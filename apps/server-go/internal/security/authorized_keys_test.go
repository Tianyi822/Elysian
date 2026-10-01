package security

// authorized_keys 纯函数与 FNV-1a id 的对等测试（对齐 authorizedKeys 的锚定行为，
// security 盘点 §4.7；FNV-1a 用公开向量锚定算法、用「不等于 UTF-8 字节迭代」锚定
// UTF-16 码元语义——id 不持久化、跨实现稳定非必需，但格式与账号维度必须保持）。

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestFnv1a公开向量(t *testing.T) {
	// FNV-1a 32 位标准测试向量（draft-east-fnv）。
	cases := map[string]string{
		"a":      "e40c292c",
		"b":      "e70c2de5",
		"foobar": "bf9cf968",
	}
	for text, want := range cases {
		if got := fnv1a(text); got != want {
			t.Errorf("fnv1a(%q) = %s，want %s", text, got, want)
		}
	}
}

func TestFnv1a按UTF16码元迭代(t *testing.T) {
	// BMP 中文字符是一个 UTF-16 码元：按码元迭代只 XOR 一次；
	// 若错按 UTF-8 字节迭代会得到不同结果——用字节参考实现对照锚定。
	text := "elysian-运维机"
	byteRef := fnv1aOverBytes(text)
	if got := fnv1a(text); got == byteRef {
		t.Errorf("fnv1a 对非 ASCII 应按 UTF-16 码元迭代（got %s 不应等于字节迭代 %s）", got, byteRef)
	}
	// 增补平面字符（代理对）按两个码元参与哈希。
	pair := "🎉"
	units := utf16.Encode([]rune(pair))
	if len(units) != 2 {
		t.Fatalf("增补平面字符应为代理对：%v", units)
	}
	if got := fnv1a(pair); got == fnv1aOverBytes(pair) {
		t.Errorf("代理对应按两个码元迭代：%s", got)
	}
}

// fnv1aOverBytes 参考实现：按 UTF-8 字节迭代（正确实现不应与它相同——非 ASCII 时）。
func fnv1aOverBytes(text string) string {
	hash := uint32(0x811c9dc5)
	for i := 0; i < len(text); i++ {
		hash ^= uint32(text[i])
		hash *= 0x01000193
	}
	return fmt.Sprintf("%08x", hash)
}

func TestKeyLineId与AuthorizedKeyId(t *testing.T) {
	line := "ssh-ed25519 AAAA elysian-部署机"
	id := KeyLineId(line)
	if !strings.HasPrefix(id, "sshkey-") || len(id) != len("sshkey-")+8 {
		t.Errorf("KeyLineId 格式应为 sshkey- 加 8 位十六进制：%q", id)
	}
	if KeyLineId("  "+line+"  ") != id {
		t.Errorf("KeyLineId 应对行 trim 稳定")
	}
	// 同一公钥装多账号 id 各异；账号维度参与哈希。
	if AuthorizedKeyId("elysian", line) == AuthorizedKeyId("newops", line) {
		t.Errorf("不同账号的同款公钥 id 应不同")
	}
	// 按各自 id 删除互不影响。
	if AuthorizedKeyId("elysian", line) == KeyLineId(line) {
		t.Errorf("账号维度应改变哈希（与裸行 id 不同）")
	}
}

func TestParsePasswdLine与GetentEntries(t *testing.T) {
	output := "root:x:0:0:root:/root:/bin/bash\nbad line\nshort:x:1\nelysian:x:1000:1000::/home/elysian:/bin/bash\n"
	entries := ParseGetentPasswdEntries(output)
	if len(entries) != 2 {
		t.Fatalf("应跳过坏行，得 %d", len(entries))
	}
	if entries[0].Name != "root" || entries[0].UID != 0 || entries[0].Home != "/root" {
		t.Errorf("root 行解析错：%+v", entries[0])
	}
	if entries[1].Name != "elysian" || entries[1].UID != 1000 {
		t.Errorf("elysian 行解析错：%+v", entries[1])
	}
}

func TestIsKeyAccount白名单(t *testing.T) {
	cases := []struct {
		entry PasswdEntry
		want  bool
	}{
		{PasswdEntry{Name: "root", UID: 0, Shell: "/bin/bash"}, false},
		{PasswdEntry{Name: "elysian", UID: 1000, Shell: "/bin/bash"}, true},
		{PasswdEntry{Name: "svc", UID: 999, Shell: "/bin/bash"}, false},
		{PasswdEntry{Name: "svc2", UID: 1000, Shell: "/usr/sbin/nologin"}, false},
		{PasswdEntry{Name: "blocked", UID: 1001, Shell: "/bin/false"}, false},
		{PasswdEntry{Name: "ok", UID: 1005, Shell: "/bin/zsh"}, true},
	}
	for _, c := range cases {
		if got := IsKeyAccount(c.entry); got != c.want {
			t.Errorf("IsKeyAccount(%+v) = %v，want %v", c.entry, got, c.want)
		}
	}
	accounts := ListKeyAccounts("elysian:x:1000:1000::/home/elysian:/bin/bash\nroot:x:0:0:root:/root:/bin/bash\n")
	if len(accounts) != 1 || accounts[0].ID != "elysian" || accounts[0].Name != "elysian" {
		t.Errorf("ListKeyAccounts 白名单过滤失败：%+v", accounts)
	}
}

func TestSshDirPath与AuthorizedKeysPath(t *testing.T) {
	if got := sshDirPath("/home/elysian/"); got != "/home/elysian/.ssh" {
		t.Errorf("sshDirPath 去尾斜杠失败：%q", got)
	}
	if got := sshDirPath("/home/elysian"); got != "/home/elysian/.ssh" {
		t.Errorf("sshDirPath：%q", got)
	}
	if got := authorizedKeysPath("/home/elysian"); got != "/home/elysian/.ssh/authorized_keys" {
		t.Errorf("authorizedKeysPath：%q", got)
	}
}

func TestParseKeyLines(t *testing.T) {
	text := "# 注释行\n  ssh-ed25519 AAAA c1  \n\nssh-rsa BBBB c2\n"
	lines := ParseKeyLines(text)
	if len(lines) != 2 || lines[0] != "ssh-ed25519 AAAA c1" || lines[1] != "ssh-rsa BBBB c2" {
		t.Errorf("ParseKeyLines 应去空行注释行并 trim：%q", lines)
	}
}

func TestAppendKeyLine(t *testing.T) {
	if got := AppendKeyLine("", "K1"); got != "K1\n" {
		t.Errorf("空文件追加：%q", got)
	}
	if got := AppendKeyLine("K0", "K1"); got != "K0\nK1\n" {
		t.Errorf("无结尾换行补上：%q", got)
	}
	if got := AppendKeyLine("K0\n\n\n", "K1"); got != "K0\nK1\n" {
		t.Errorf("尾部空白收掉：%q", got)
	}
}

func TestRemoveKeyLine(t *testing.T) {
	text := "K0\nK1\nK2\n"
	if got := RemoveKeyLine(text, "K1"); got != "K0\nK2\n" {
		t.Errorf("整行移除失败：%q", got)
	}
	if got := RemoveKeyLine(text, "missing"); got != text {
		t.Errorf("行不存在时原样返回：%q", got)
	}
	if got := RemoveKeyLine("K0\n  K1  \n", "K1"); got != "K0\n" {
		t.Errorf("移除按 trim 匹配：%q", got)
	}
}

func TestReplaceFirstKeyLine(t *testing.T) {
	if got := ReplaceFirstKeyLine("", "N"); got != "N\n" {
		t.Errorf("无公钥行时整文件只剩新行：%q", got)
	}
	text := "# 注释\nK0\nK1\n"
	if got := ReplaceFirstKeyLine(text, "N"); got != "# 注释\nN\nK1\n" {
		t.Errorf("首个非空非注释行整行替换，外来行保留：%q", got)
	}
}

func TestKeyCommentOf(t *testing.T) {
	if got := KeyCommentOf("ssh-ed25519 AAAA elysian-部署机"); got != "elysian-部署机" {
		t.Errorf("注释段（第三段起）：%q", got)
	}
	if got := KeyCommentOf("ssh-ed25519 AAAA"); got != "" {
		t.Errorf("无注释为空串：%q", got)
	}
	if got := KeyCommentOf("ssh-ed25519 AAAA c1 c2"); got != "c1 c2" {
		t.Errorf("多段注释空格连接：%q", got)
	}
}

func TestParseKeygenFingerprint(t *testing.T) {
	fp := ParseKeygenFingerprint("256 SHA256:abc123 elysian-部署机 (ED25519)\n")
	if fp == nil {
		t.Fatalf("应解析成功")
	}
	if fp.Bits != 256 || fp.Fingerprint != "SHA256:abc123" || fp.Comment != "elysian-部署机" || fp.TypeToken != "ED25519" {
		t.Errorf("字段解析错：%+v", fp)
	}
	if ParseKeygenFingerprint("garbage") != nil {
		t.Errorf("形状不对应返回 nil")
	}
}

func TestAlgorithmLabelOf(t *testing.T) {
	cases := map[string]string{
		"ED25519": "ssh-ed25519 256",
		"RSA":     "ssh-rsa 2048",
		"ECDSA":   "ecdsa-sha2-nistp256 256",
		"DSA":     "ssh-dss 1024",
		"UNKNOWN": "UNKNOWN 256",
	}
	for token, want := range cases {
		bits := 256
		switch token {
		case "RSA":
			bits = 2048
		case "DSA":
			bits = 1024
		}
		if got := AlgorithmLabelOf(KeygenFingerprint{Bits: bits, TypeToken: token}); got != want {
			t.Errorf("AlgorithmLabelOf(%s) = %q，want %q", token, got, want)
		}
	}
}

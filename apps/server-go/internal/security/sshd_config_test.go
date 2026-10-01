package security

// sshd_config 解析与补丁的对等测试（对齐 parseSshdConfig.test.ts 与
// patchSshdConfig.test.ts 的锚定行为，security 盘点 §8；补丁用例逐条移植 TS 版）。

import (
	"strings"
	"testing"
)

func TestParseSshdConfig四指令与缺省(t *testing.T) {
	text := strings.Join([]string{
		"Port 2202",
		"PasswordAuthentication no",
		"PubkeyAuthentication yes",
		"PermitRootLogin yes",
		"UsePAM yes",
	}, "\n")
	d := parseSshdConfig(text)
	if d.port == nil || *d.port != 2202 {
		t.Errorf("port 解析失败：%v", d.port)
	}
	if d.passwordAuthentication == nil || *d.passwordAuthentication {
		t.Errorf("passwordAuthentication 应为 false")
	}
	if d.pubkeyAuthentication == nil || !*d.pubkeyAuthentication {
		t.Errorf("pubkeyAuthentication 应为 true")
	}
	if d.permitRootLogin == nil || *d.permitRootLogin != "yes" {
		t.Errorf("permitRootLogin 应为 yes")
	}

	empty := parseSshdConfig("# 只有注释\n\nUsePAM yes\n")
	if empty.port != nil || empty.passwordAuthentication != nil || empty.pubkeyAuthentication != nil || empty.permitRootLogin != nil {
		t.Errorf("缺省应全 nil：%+v", empty)
	}
}

func TestParseSshdConfig注释与行内注释(t *testing.T) {
	d := parseSshdConfig("# Port 22\nPort 2222 # 行内注释\nPort 3333")
	if d.port == nil || *d.port != 2222 {
		t.Errorf("行内注释应被剥掉，port = %v", d.port)
	}
	// 取值里不含「空白+#」形态的 # 不算注释（公钥串无此形态）。
	if got := StripConfigComment("a#b"); got != "a#b" {
		t.Errorf("StripConfigComment(a#b) = %q", got)
	}
	if got := StripConfigComment(" # x"); got != "" {
		t.Errorf("StripConfigComment( # x) = %q", got)
	}
	if got := StripConfigComment("Port 22 # c"); got != "Port 22" {
		t.Errorf("StripConfigComment = %q", got)
	}
}

func TestParseSshdConfig大小写不敏感(t *testing.T) {
	d := parseSshdConfig("port 24\npasswordauthentication NO\npubkeyauthentication YES\npermitrootlogin YES")
	if d.port == nil || *d.port != 24 {
		t.Errorf("小写指令应识别，port = %v", d.port)
	}
	if d.passwordAuthentication == nil || *d.passwordAuthentication {
		t.Errorf("取值大小写不敏感，应为 false")
	}
	if d.permitRootLogin == nil || *d.permitRootLogin != "yes" {
		t.Errorf("PermitRootLogin 取值应小写归一为 yes")
	}
}

func TestParseSshdConfigFirstObtained与Match块(t *testing.T) {
	d := parseSshdConfig("PasswordAuthentication no\nPort 22\nPort 2202\nMatch User foo\n  Port 9999\n  PermitRootLogin yes")
	if d.port == nil || *d.port != 22 {
		t.Errorf("first-obtained 应取首个 Port，得 %v", d.port)
	}
	if d.permitRootLogin != nil {
		t.Errorf("Match 块内的指令应跳过，得 %v", *d.permitRootLogin)
	}
	// Match 之前的全局指令生效；Match 块到文件尾整块跳过。
	if d.passwordAuthentication == nil || *d.passwordAuthentication {
		t.Errorf("Match 之前的全局指令应生效，得 %v", d.passwordAuthentication)
	}
}

func TestParseSshdConfig取值无法辨认(t *testing.T) {
	d := parseSshdConfig("Port 70000\nPort abc\nPasswordAuthentication maybe\nPermitRootLogin weird")
	if d.port != nil {
		t.Errorf("端口越界应为 nil，得 %v", *d.port)
	}
	if d.passwordAuthentication != nil {
		t.Errorf("未知开关取值应为 nil")
	}
	if d.permitRootLogin == nil || *d.permitRootLogin != "weird" {
		t.Errorf("PermitRootLogin 未知取值应原样保留，得 %v", d.permitRootLogin)
	}
}

func TestParseSshdConfigCRLF与等号写法(t *testing.T) {
	d := parseSshdConfig("Port=22\r\nPasswordAuthentication = no\r\n")
	if d.port == nil || *d.port != 22 {
		t.Errorf("Keyword=Value 与 CRLF 应可解析，port = %v", d.port)
	}
	if d.passwordAuthentication == nil || *d.passwordAuthentication {
		t.Errorf("等号归一后取值应为 false")
	}
	if got := NormalizeEqualsSeparator("Port = 22"); got != "Port 22" {
		t.Errorf("NormalizeEqualsSeparator = %q", got)
	}
	if got := NormalizeEqualsSeparator("Include=conf.d/*.conf"); got != "Include conf.d/*.conf" {
		t.Errorf("NormalizeEqualsSeparator(Include=) = %q", got)
	}
}

func TestParseSshdConfigWithoutPassword归一(t *testing.T) {
	for _, raw := range []string{"without-password", "WITHOUT-PASSWORD", "Without-Password"} {
		d := parseSshdConfig("PermitRootLogin " + raw)
		if d.permitRootLogin == nil || *d.permitRootLogin != "prohibit-password" {
			t.Errorf("PermitRootLogin %q 应归一为 prohibit-password，得 %v", raw, d.permitRootLogin)
		}
	}
}

// ---------- 补丁用例（逐条移植 patchSshdConfig.test.ts） ----------

// patchCase 用 lines 数组断言（与 TS 版 expect(next.split('\n')).toEqual 同口径）。
func patchCase(t *testing.T, name, text string, patch []sshdPatchEntry, wantLines []string) {
	t.Helper()
	got := strings.Split(PatchSshdConfig(text, patch), "\n")
	if len(got) != len(wantLines) {
		t.Fatalf("%s：行数 %d want %d（got %q）", name, len(got), len(wantLines), got)
	}
	for i := range wantLines {
		if got[i] != wantLines[i] {
			t.Errorf("%s：第 %d 行 got %q want %q", name, i, got[i], wantLines[i])
		}
	}
}

func TestPatch整行替换与逐字保留(t *testing.T) {
	base := strings.Join([]string{"# 全局段", "Port 22", "X11Forwarding yes", "PermitRootLogin yes"}, "\n")
	patchCase(t, "整行替换", base+"\n", []sshdPatchEntry{{Name: "Port", Value: "2202"}, {Name: "PermitRootLogin", Value: "no"}},
		[]string{"# 全局段", "Port 2202", "X11Forwarding yes", "PermitRootLogin no", ""})
}

func TestPatch大小写匹配替换(t *testing.T) {
	patchCase(t, "大小写", "passwordAuthentication yes   # 开启\n", []sshdPatchEntry{{Name: "PasswordAuthentication", Value: "no"}},
		[]string{"PasswordAuthentication no", ""})
}

func TestPatchPort累积语义(t *testing.T) {
	patchCase(t, "累积", "Port 22\nPort 23\nPort 24\n", []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"Port 2202", "#Port 23", "#Port 24", ""})
}

func TestPatch非Port多次出现只换首个(t *testing.T) {
	patchCase(t, "首个生效", "PermitRootLogin no\nPermitRootLogin yes\n", []sshdPatchEntry{{Name: "PermitRootLogin", Value: "yes"}},
		[]string{"PermitRootLogin yes", "PermitRootLogin yes", ""})
}

func TestPatch缺省追加保留结尾换行(t *testing.T) {
	got := PatchSshdConfig("Port 22\n", []sshdPatchEntry{{Name: "PubkeyAuthentication", Value: "yes"}})
	if got != "Port 22\nPubkeyAuthentication yes\n" {
		t.Errorf("缺省追加失败：%q", got)
	}
	got = PatchSshdConfig("Port 22", []sshdPatchEntry{{Name: "PubkeyAuthentication", Value: "no"}})
	if got != "Port 22\nPubkeyAuthentication no" {
		t.Errorf("无结尾换行追加失败：%q", got)
	}
}

func TestPatch带Match块时追加到首个Match之前(t *testing.T) {
	text := strings.Join([]string{"Port 22", "Match User deploy", "  PasswordAuthentication yes"}, "\n")
	patchCase(t, "Match 前追加", text, []sshdPatchEntry{{Name: "PasswordAuthentication", Value: "no"}},
		[]string{"Port 22", "PasswordAuthentication no", "Match User deploy", "  PasswordAuthentication yes"})
}

func TestPatch带Match块时已有指令行内替换(t *testing.T) {
	text := strings.Join([]string{"Port 22", "Match User deploy", "  Port 2222"}, "\n")
	patchCase(t, "Match 块不动", text, []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"Port 2202", "Match User deploy", "  Port 2222"})
}

func TestPatch注释指令不视为已有取值(t *testing.T) {
	patchCase(t, "注释指令", "#Port 22\n", []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"#Port 22", "Port 2202", ""})
}

func TestPatch多指令追加顺序(t *testing.T) {
	patchCase(t, "追加顺序", "", []sshdPatchEntry{
		{Name: "PermitRootLogin", Value: "no"},
		{Name: "Port", Value: "2202"},
		{Name: "PasswordAuthentication", Value: "no"},
		{Name: "PubkeyAuthentication", Value: "yes"},
	}, []string{"Port 2202", "PasswordAuthentication no", "PubkeyAuthentication yes", "PermitRootLogin no", ""})
}

func TestPatch空补丁逐字相同(t *testing.T) {
	text := "Port 22\nInclude /etc/ssh/sshd_config.d/*.conf\n# 备注\n"
	if got := PatchSshdConfig(text, nil); got != text {
		t.Errorf("空补丁输出应逐字相同：%q", got)
	}
}

func TestPatch追加行插到Include之前(t *testing.T) {
	text := strings.Join([]string{"# Ubuntu 出厂形态", "Include /etc/ssh/sshd_config.d/*.conf", "#Port 22", ""}, "\n")
	patchCase(t, "Include 之前", text, []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"# Ubuntu 出厂形态", "Port 2202", "Include /etc/ssh/sshd_config.d/*.conf", "#Port 22", ""})
}

func TestPatchInclude之后的同指令行不替换(t *testing.T) {
	text := strings.Join([]string{"Include /etc/ssh/sshd_config.d/*.conf", "PasswordAuthentication yes", ""}, "\n")
	patchCase(t, "不替换", text, []sshdPatchEntry{{Name: "PasswordAuthentication", Value: "no"}},
		[]string{"PasswordAuthentication no", "Include /etc/ssh/sshd_config.d/*.conf", "PasswordAuthentication yes", ""})
}

func TestPatchInclude与Match并存取更早者(t *testing.T) {
	text := strings.Join([]string{"Port 22", "Include /etc/ssh/sshd_config.d/*.conf", "Match User deploy", "  PermitRootLogin yes"}, "\n")
	patchCase(t, "更早者", text, []sshdPatchEntry{{Name: "PermitRootLogin", Value: "no"}},
		[]string{"Port 22", "PermitRootLogin no", "Include /etc/ssh/sshd_config.d/*.conf", "Match User deploy", "  PermitRootLogin yes"})
}

func TestPatch指令等号写法识别为已有取值(t *testing.T) {
	patchCase(t, "等号指令", "Port=22\nPasswordAuthentication=yes\n", []sshdPatchEntry{
		{Name: "Port", Value: "2202"}, {Name: "PasswordAuthentication", Value: "no"},
	}, []string{"Port 2202", "PasswordAuthentication no", ""})
}

func TestPatchInclude等号写法识别(t *testing.T) {
	text := strings.Join([]string{"Include=/etc/ssh/sshd_config.d/*.conf", "#Port 22", ""}, "\n")
	patchCase(t, "等号 Include", text, []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"Port 2202", "Include=/etc/ssh/sshd_config.d/*.conf", "#Port 22", ""})
}

func TestPatchMatch等号写法识别(t *testing.T) {
	text := strings.Join([]string{"Port 22", "Match=User deploy", "  Port 2222"}, "\n")
	patchCase(t, "等号 Match", text, []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"Port 2202", "Match=User deploy", "  Port 2222"})
}

func TestPatchInclude之后的Port行仍被替换或注释(t *testing.T) {
	text := strings.Join([]string{"Include /etc/ssh/sshd_config.d/*.conf", "Port 22", "Port 23", ""}, "\n")
	patchCase(t, "累积不受保护", text, []sshdPatchEntry{{Name: "Port", Value: "2202"}},
		[]string{"Include /etc/ssh/sshd_config.d/*.conf", "Port 2202", "#Port 23", ""})
}

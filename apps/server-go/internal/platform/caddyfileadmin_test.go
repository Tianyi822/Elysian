package platform

import (
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

// Caddyfile 全局段改写与安装脚本对等测试（caddyfileAdmin.test.ts）：ensure 六例、
// 六段脚本 sh -n 语法可过且安装源 URL 逐字断言、写入脚本只携带 base64。

const testSocket = "/run/caddy/admin.sock"

func TestEnsureCaddyAdminSocketEmptyFile(t *testing.T) {
	got, err := ensureCaddyAdminSocket("", testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	want := "{\n\t" + caddyAdminDirective(testSocket) + "\n}\n"
	if got != want {
		t.Fatalf("空文件应补只含管理端点的全局段：\n got %q\nwant %q", got, want)
	}
}

func TestEnsureCaddyAdminSocketNoGlobalSection(t *testing.T) {
	source := "example.com {\n\troot * /srv\n}\n"
	got, err := ensureCaddyAdminSocket(source, testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	want := "{\n\t" + caddyAdminDirective(testSocket) + "\n}\n\nexample.com {\n\troot * /srv\n}\n"
	if got != want {
		t.Fatalf("管理端点应加在站点块前面：\n got %q\nwant %q", got, want)
	}
}

func TestEnsureCaddyAdminSocketInsertsIntoExistingGlobal(t *testing.T) {
	source := "{\n\temail a@b.c\n}\n\nexample.com {\n}\n"
	got, err := ensureCaddyAdminSocket(source, testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if !strings.Contains(got, "\t"+caddyAdminDirective(testSocket)+"\n") {
		t.Fatalf("应插进全局段内：%q", got)
	}
	if !strings.Contains(got, "email a@b.c") {
		t.Fatalf("既有指令应保留：%q", got)
	}
	if !strings.Contains(got, "example.com {\n}\n") {
		t.Fatalf("站点块应不动：%q", got)
	}
}

func TestEnsureCaddyAdminSocketReplacesOtherAdmin(t *testing.T) {
	source := "{\n\tadmin localhost:2019\n\tadmin off\n}\n"
	got, err := ensureCaddyAdminSocket(source, testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if count := strings.Count(got, "admin "); count != 1 {
		t.Fatalf("不应留第二条 admin：%d\n%q", count, got)
	}
	if !strings.Contains(got, caddyAdminDirective(testSocket)) {
		t.Fatalf("应含目标地址：%q", got)
	}
	if strings.Contains(got, "localhost:2019") {
		t.Fatalf("旧地址应被移除：%q", got)
	}
}

func TestEnsureCaddyAdminSocketAlreadyCorrect(t *testing.T) {
	source := "{\n\t" + caddyAdminDirective(testSocket) + "\n}\n"
	got, err := ensureCaddyAdminSocket(source, testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if got != source {
		t.Fatalf("已是目标地址则不改内容：\n got %q\nwant %q", got, source)
	}
}

func TestEnsureCaddyAdminSocketUnclosedRejected(t *testing.T) {
	_, err := ensureCaddyAdminSocket("{\n\tadmin off\n", testSocket)
	if err == nil || err.Error() != caddyfileGlobalUnclosed {
		t.Fatalf("全局段未闭合应拒绝：%v", err)
	}
}

func TestEnsureCaddyAdminSocketCRLFNormalized(t *testing.T) {
	source := "{\r\n\temail a@b.c\r\n}\r\n"
	got, err := ensureCaddyAdminSocket(source, testSocket)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if strings.Contains(got, "\r\n") {
		t.Fatalf("CRLF 应归一为 LF：%q", got)
	}
}

func TestCaddyAdminDirective(t *testing.T) {
	if got := caddyAdminDirective("/run/caddy/admin.sock"); got != "admin unix//run/caddy/admin.sock" {
		t.Fatalf("指令不符：%q", got)
	}
}

// 六段脚本 sh -n 语法可过，且不含 shell 变量插值、安装源 URL 逐字断言。
func TestScriptsShellSyntaxAndSources(t *testing.T) {
	scripts := map[string]string{
		"caddyInstall":   caddyInstallScript,
		"caddyEnable":    caddyEnableScript,
		"dockerInstall":  dockerInstallScript,
		"dockerEnable":   dockerEnableScript,
		"readCaddyfile":  readCaddyfileScript,
		"writeCaddyfile": writeCaddyfileScript("{\n\t" + caddyAdminDirective(testSocket) + "\n}\n"),
	}
	for name, script := range scripts {
		cmd := exec.Command("/bin/sh", "-n")
		cmd.Stdin = strings.NewReader(script)
		if err := cmd.Run(); err != nil {
			t.Errorf("%s 脚本 sh -n 语法不过：%v", name, err)
		}
		if name == "caddyInstall" || name == "dockerInstall" || name == "caddyEnable" || name == "dockerEnable" {
			if strings.Contains(script, "$(") || strings.Contains(script, "${") {
				t.Errorf("%s 不应含 shell 变量/命令插值", name)
			}
		}
	}
	if !strings.Contains(caddyInstallScript, "https://dl.cloudsmith.io/public/caddy/stable/gpg.key") {
		t.Fatal("Caddy 安装源 URL 不符")
	}
	if !strings.Contains(caddyInstallScript, "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt") {
		t.Fatal("Caddy 源列表 URL 不符")
	}
	if !strings.Contains(caddyInstallScript, "apt-get install -y caddy") {
		t.Fatal("Caddy 安装命令不符")
	}
	if !strings.Contains(dockerInstallScript, "https://get.docker.com") {
		t.Fatal("Docker 官方安装脚本 URL 不符")
	}
	if !strings.Contains(caddyEnableScript, "RuntimeDirectory=caddy") {
		t.Fatal("Caddy runtime 配置不符")
	}
}

// 写入脚本只携带 base64：文件原文不进 shell 引号。
func TestWriteCaddyfileScriptCarriesOnlyBase64(t *testing.T) {
	content := "{\n\tadmin '\n}\n"
	script := writeCaddyfileScript(content)
	if strings.Contains(script, "admin '") {
		t.Fatalf("原文不得出现在脚本里：%q", script)
	}
	payloadPattern := regexp.MustCompile(`printf '%s' '([A-Za-z0-9+/=]*)'`)
	matched := payloadPattern.FindStringSubmatch(script)
	if matched == nil {
		t.Fatalf("应携带 base64 载荷：%q", script)
	}
	decoded, err := decodeBase64Lenient(matched[1])
	if err != nil {
		t.Fatalf("载荷解码失败：%v", err)
	}
	if decoded != content {
		t.Fatalf("载荷解码后应还原内容：\n got %q\nwant %q", decoded, content)
	}
}

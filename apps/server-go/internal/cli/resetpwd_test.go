package cli

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"elysian/server/internal/auth"
)

// 重置密码入口的门禁测试（CLI 方案 §5／§8）：euid 经注入 fake 判定；生产路径
//（/var/lib/elysian/.Elysian）非 root 一律拒绝且不触碰改密流程（挡「普通用户在自己
// home 建一份无关凭据却显示成功」的误导形态），root／开发路径放行并原样打印解析出的
// 凭据路径。密码不回显断言串联真实 auth 流程（非 TTY 两行管道输入）。

// gatedDeps 构造带调用记录的门禁 fake：resolved 记录传给改密流程的 panelHome。
func gatedDeps(fileExists func(string) bool, euid int) (deps, *[]string) {
	resolved := &[]string{}
	d := fakeDeps()
	d.fileExists = fileExists
	d.geteuid = func() int { return euid }
	d.runResetAt = func(home string, stdin io.Reader, stdout io.Writer) int {
		*resolved = append(*resolved, home)
		return 0
	}
	return d, resolved
}

func TestResetPasswordGateProductionRequiresRoot(t *testing.T) {
	d, resolved := gatedDeps(func(p string) bool { return p == productionPanelHome }, 1000)
	var out bytes.Buffer
	runResetPassword(&out, strings.NewReader(""), d)
	if len(*resolved) != 0 {
		t.Fatalf("非 root 在生产路径应被拒绝且不进改密流程，实际调用了 %v", *resolved)
	}
	if !strings.Contains(out.String(), "需要管理员权限：sudo ely") {
		t.Errorf("拒绝提示应指明 sudo ely：%q", out.String())
	}
	if !strings.Contains(out.String(), productionPanelHome+"/config/panel-credentials.json") {
		t.Errorf("拒绝时应展示目标凭据路径供核对：%q", out.String())
	}
}

func TestResetPasswordGateRootProceedsAgainstProduction(t *testing.T) {
	d, resolved := gatedDeps(func(p string) bool { return p == productionPanelHome }, 0)
	var out bytes.Buffer
	runResetPassword(&out, strings.NewReader(""), d)
	if len(*resolved) != 1 || (*resolved)[0] != productionPanelHome {
		t.Fatalf("root 应以生产数据根进入改密流程，实际 %v", *resolved)
	}
	if !strings.Contains(out.String(), "面板凭据文件："+productionPanelHome+"/config/panel-credentials.json") {
		t.Errorf("提示阶段应原样打印生产凭据路径：%q", out.String())
	}
}

func TestResetPasswordGateDevHomeAllowedWithoutRoot(t *testing.T) {
	d, resolved := gatedDeps(func(string) bool { return false }, 1000)
	var out bytes.Buffer
	runResetPassword(&out, strings.NewReader(""), d)
	if len(*resolved) != 1 || (*resolved)[0] != "/home/dev/.Elysian" {
		t.Fatalf("开发形态（$HOME 下）非 root 应放行，实际 %v", *resolved)
	}
	if !strings.Contains(out.String(), "面板凭据文件：/home/dev/.Elysian/config/panel-credentials.json") {
		t.Errorf("应原样打印开发凭据路径：%q", out.String())
	}
}

func TestResetPasswordGateEnvOverrideToProductionStillRequiresRoot(t *testing.T) {
	// 门禁按「解析结果路径」判定：显式 env 指向生产路径时同样须 root。
	d := fakeDeps()
	d.getenv = func(string) string { return productionPanelHome }
	d.geteuid = func() int { return 1000 }
	var out bytes.Buffer
	runResetPassword(&out, strings.NewReader(""), d)
	if !strings.Contains(out.String(), "需要管理员权限：sudo ely") {
		t.Fatalf("env 指向生产路径且非 root 应拒绝：%q", out.String())
	}
}

func TestResetPasswordResolveFailurePrintsError(t *testing.T) {
	d := fakeDeps()
	d.userHome = func() (string, error) { return "", fmt.Errorf("boom") }
	var out bytes.Buffer
	runResetPassword(&out, strings.NewReader(""), d)
	if !strings.Contains(out.String(), "无法定位面板数据目录") {
		t.Fatalf("解析失败应打印中文错误：%q", out.String())
	}
}

// 串联真实改密流程的密码不回显断言（CLI 方案 §8「密码明文不出现在任何输出捕获」）：
// 门禁放行后转交 auth.RunResetPasswordCLIAt，非 TTY 两行管道输入，全程输出不得包含
// 密码明文，凭据文件按 scrypt 落盘。
func TestResetPasswordFlowDoesNotEchoPassword(t *testing.T) {
	home := t.TempDir()
	d := fakeDeps()
	d.getenv = func(string) string { return home } // ELYSIAN_PANEL_HOME 显式覆盖
	d.runResetAt = auth.RunResetPasswordCLIAt      // 真实改密流程
	var out bytes.Buffer
	stdin := strings.NewReader("cli-secret-密码-9\ncli-secret-密码-9\n")
	runResetPassword(&out, stdin, d)
	got := out.String()
	if !strings.Contains(got, "✓ 密码已重置") {
		t.Fatalf("改密应成功：%q", got)
	}
	if strings.Contains(got, "cli-secret-密码-9") {
		t.Fatalf("输出泄漏了密码明文：%q", got)
	}
	if !strings.Contains(got, "面板凭据文件："+home+"/config/panel-credentials.json") {
		t.Errorf("提示阶段应原样打印解析出的凭据路径：%q", got)
	}
	credentials, err := os.ReadFile(home + "/config/panel-credentials.json")
	if err != nil {
		t.Fatalf("凭据应落盘：%v", err)
	}
	if !strings.Contains(string(credentials), "scrypt:") || strings.Contains(string(credentials), "cli-secret") {
		t.Errorf("凭据应为 scrypt 哈希且不含明文：%s", credentials)
	}
}

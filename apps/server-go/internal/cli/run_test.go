package cli

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

// Run 的参数语义与非 TTY 检测测试（CLI 方案 §2／§5）：无参数且 stdin 非 TTY 时明确
// 提示并以 1 退出（菜单不启动）；--version／--help 回 0；其余任意参数（含 elysian
// 子命令形态与带多余参数的已知旗标）打印用法并以 2 结束。

var testInfo = Info{Commit: "abc1234", BuildTime: "2026-10-24T12:00:00Z"}

func TestRunNoArgsNonTTYExitsWithNotice(t *testing.T) {
	// os.Pipe 的读端是 *os.File 但不是终端：isatty 为假，走非 TTY 拒绝路径。
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	var out, errOut bytes.Buffer
	code := Run(testInfo, nil, r, &out, &errOut)
	if code != 1 {
		t.Fatalf("非 TTY 无参数应退出码 1，得到 %d", code)
	}
	msg := errOut.String()
	if !strings.Contains(msg, "ely 需要交互式终端") || !strings.Contains(msg, "elysian 子命令") {
		t.Errorf("非 TTY 提示应指明需交互式终端并引导 elysian 子命令：%q", msg)
	}
	if out.Len() != 0 {
		t.Errorf("非 TTY 拒绝时 stdout 不应有输出：%q", out.String())
	}
}

func TestRunNoArgsNilStdinRejected(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Run(testInfo, nil, nil, &out, &errOut); code != 1 {
		t.Fatalf("nil stdin 应按非 TTY 拒绝退出 1，得到 %d", code)
	}
}

func TestRunVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Run(testInfo, []string{"--version"}, nil, &out, &errOut)
	if code != 0 {
		t.Fatalf("--version 应退出 0，得到 %d", code)
	}
	got := out.String()
	for _, want := range []string{"Elysian CLI（ely）", "版本：abc1234", "构建时间：2026-10-24T12:00:00Z"} {
		if !strings.Contains(got, want) {
			t.Errorf("--version 输出应含 %q：%q", want, got)
		}
	}
	if errOut.Len() != 0 {
		t.Errorf("--version 不应写 stderr：%q", errOut.String())
	}
}

func TestRunHelp(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Run(testInfo, []string{"--help"}, nil, &out, &errOut)
	if code != 0 {
		t.Fatalf("--help 应退出 0，得到 %d", code)
	}
	got := out.String()
	if !strings.Contains(got, "交互主菜单") || !strings.Contains(got, "elysian resetpwd") {
		t.Errorf("--help 应说明菜单用法并引导脚本走 elysian 子命令：%q", got)
	}
}

func TestRunUnknownArgsExitTwo(t *testing.T) {
	cases := [][]string{
		{"panel-ports"},     // 同上
		{"-v"},              // 未定义旗标
		{"--version", "x"},  // 已知旗标带多余参数
		{"--help", "extra"}, // 同上
		{"", "x"},           // 空串参数同样拒绝
	}
	for _, args := range cases {
		var out, errOut bytes.Buffer
		code := Run(testInfo, args, nil, &out, &errOut)
		if code != 2 {
			t.Errorf("参数 %v 应退出 2，得到 %d", args, code)
		}
		if !strings.Contains(errOut.String(), "用法") {
			t.Errorf("参数 %v 应在 stderr 打印用法：%q", args, errOut.String())
		}
	}
}

// fakeDeps 供菜单与门禁测试注入：全部出口为可控 fake，不触网络与文件系统。
func fakeDeps() deps {
	return deps{
		getenv:     func(string) string { return "" },
		userHome:   func() (string, error) { return "/home/dev", nil },
		fileExists: func(string) bool { return false },
		geteuid:    func() int { return 1000 },
		runResetAt: func(string, io.Reader, io.Writer) int { return 0 },
		probePanel: func(context.Context) panelStatus { return panelStatus{kind: panelNotRunning} },
	}
}

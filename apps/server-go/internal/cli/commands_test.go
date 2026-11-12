package cli

import (
	"bytes"
	tea "github.com/charmbracelet/bubbletea"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestCommandHelpWithoutTerminalOrPanel(t *testing.T) {
	for _, args := range [][]string{{"help"}, {"-h"}, {"--help"}, {"help", "agent"}, {"help", "resetpwd"}, {"help", "upgrade"}, {"help", "uninstall"}, {"help", "help"}, {"agent", "--help"}, {"resetpwd", "-h"}, {"upgrade", "--help"}, {"uninstall", "-h"}, {"uninstall", "--help"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var out, errOut bytes.Buffer
			d := fakeDeps()
			d.userHome = func() (string, error) { t.Fatal("帮助不应读取 HOME"); return "", nil }
			code := runWithDeps(testInfo, args, nil, &out, &errOut, d)
			if code != 0 || !strings.Contains(out.String(), "用法") || errOut.Len() != 0 {
				t.Fatalf("code=%d out=%s err=%s", code, &out, &errOut)
			}
		})
	}
}

func TestUpgradeArgumentValidationBeforeExecution(t *testing.T) {
	for _, args := range [][]string{{"upgrade", "--source", "gitee"}, {"upgrade", "--source", "other"}, {"upgrade", "--channel", "stable"}, {"upgrade", "--password", "x"}, {"upgrade", "extra"}, {"agent", "extra"}, {"resetpwd", "--yes"}, {"help", "missing"}, {"help", "upgrade", "extra"}, {"upgrade"}} {
		var out, errOut bytes.Buffer
		d := fakeDeps()
		d.runUpgrade = func(upgradeOptions, *os.File, io.Writer, io.Writer) int {
			t.Fatal("参数失败不应执行更新")
			return 0
		}
		if code := runWithDeps(testInfo, args, nil, &out, &errOut, d); code != 2 {
			t.Errorf("%v code=%d: %s", args, code, &errOut)
		}
	}
}

func TestNonInteractiveUpgradePassesExactFlagsAndExitCode(t *testing.T) {
	d := fakeDeps()
	d.runUpgrade = func(opts upgradeOptions, _ *os.File, _ io.Writer, _ io.Writer) int {
		if !reflect.DeepEqual(opts, upgradeOptions{Source: "github", Channel: "release", Yes: true}) {
			t.Fatalf("opts=%+v", opts)
		}
		return 130
	}
	for _, args := range [][]string{{"upgrade", "--source=github", "--channel", "release", "-y"}, {"upgrade", "--channel", "release", "--yes"}} {
		var out bytes.Buffer
		if code := runWithDeps(testInfo, args, nil, &out, &out, d); code != 130 {
			t.Fatalf("%v code=%d", args, code)
		}
	}
}

func TestNonInteractiveGiteeUpgradePassesSource(t *testing.T) {
	d := fakeDeps()
	d.runUpgrade = func(opts upgradeOptions, _ *os.File, _ io.Writer, _ io.Writer) int {
		if opts.Source != "gitee" || opts.Channel != "" || !opts.Yes {
			t.Fatalf("opts=%+v", opts)
		}
		return 0
	}
	var out, errOut bytes.Buffer
	if code := runWithDeps(testInfo, []string{"upgrade", "--source", "gitee", "--yes"}, nil, &out, &errOut, d); code != 0 {
		t.Fatalf("%d %s", code, &errOut)
	}
}

func TestUninstallPassesArgumentsThrough(t *testing.T) {
	// root 且已安装卸载脚本时，选项原样转交脚本入口，退出码透传。
	for _, args := range [][]string{
		{"uninstall"},
		{"uninstall", "--keep-data"},
		{"uninstall", "--remove-legacy-components", "caddy,docker,go,bun"},
		{"uninstall", "--dry-run", "--yes"},
	} {
		var out, errOut bytes.Buffer
		d := fakeDeps()
		d.geteuid = func() int { return 0 }
		d.fileExists = func(p string) bool { return p == uninstallScriptPath }
		called := false
		d.runUninstall = func(scriptArgs []string, _ io.Writer) int {
			called = true
			if want := args[1:]; !reflect.DeepEqual(scriptArgs, want) {
				t.Fatalf("%v 透传参数=%v，期望 %v", args, scriptArgs, want)
			}
			return 7
		}
		if code := runWithDeps(testInfo, args, nil, &out, &errOut, d); code != 7 || !called {
			t.Fatalf("%v code=%d called=%v", args, code, called)
		}
	}
}

func TestUninstallGatedBeforeScript(t *testing.T) {
	// 非 root：提示 sudo ely uninstall，不触脚本。
	var out, errOut bytes.Buffer
	d := fakeDeps() // fakeDeps 的 geteuid 为非 root。
	d.fileExists = func(p string) bool { return p == uninstallScriptPath }
	d.runUninstall = func([]string, io.Writer) int {
		t.Fatal("门禁未通过不应执行卸载")
		return 0
	}
	if code := runWithDeps(testInfo, []string{"uninstall", "--yes"}, nil, &out, &errOut, d); code != 1 {
		t.Fatalf("非 root 应退出 1，得到 %d", code)
	}
	if msg := errOut.String(); !strings.Contains(msg, "sudo ely uninstall") {
		t.Fatalf("非 root 提示应引导 sudo ely uninstall：%q", msg)
	}
	// root 但脚本缺失：给出路径与获取指引，不执行。
	out.Reset()
	errOut.Reset()
	d.geteuid = func() int { return 0 }
	d.fileExists = func(string) bool { return false }
	if code := runWithDeps(testInfo, []string{"uninstall"}, nil, &out, &errOut, d); code != 1 {
		t.Fatalf("脚本缺失应退出 1，得到 %d", code)
	}
	if msg := errOut.String(); !strings.Contains(msg, uninstallScriptPath) || !strings.Contains(msg, "重新安装") {
		t.Fatalf("脚本缺失提示应含路径与重新安装指引：%q", msg)
	}
}

func TestDirectResetPasswordPreservesResult(t *testing.T) {
	d := fakeDeps()
	calls := 0
	d.runResetAt = func(home string, in io.Reader, out io.Writer) int {
		calls++
		if home != "/home/dev/.Elysian" {
			t.Fatalf("home=%s", home)
		}
		return 1
	}
	var out bytes.Buffer
	if code := runWithDeps(testInfo, []string{"resetpwd"}, nil, &out, &out, d); code != 1 || calls != 1 {
		t.Fatalf("code=%d calls=%d", code, calls)
	}
}

func TestMenuUpgradeAndHelp(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m.cursor = 2
	m, cmd := pressWithCmd(t, m, keyEnter())
	if m.action != menuActionUpgrade || !quits(t, cmd) {
		t.Fatal("更新菜单没有分派")
	}
	m = newMenuModel(testInfo, fakeDeps())
	m.cursor = 3
	m, cmd = pressWithCmd(t, m, keyEnter())
	if !m.help || cmd != nil || !strings.Contains(m.View(), "ely agent") {
		t.Fatal("帮助菜单没有内容")
	}
	m = press(t, m, tea.WindowSizeMsg{Width: 60, Height: 12})
	m = press(t, m, tea.KeyMsg{Type: tea.KeyPgDown})
	if m.helpViewport.YOffset == 0 {
		t.Fatal("帮助没有滚动")
	}
	m = press(t, m, keyEsc())
	if m.help {
		t.Fatal("Esc 应回菜单")
	}
}

package cli

import (
	"bytes"
	tea "github.com/charmbracelet/bubbletea"
	"io"
	"os"
	"strings"
	"testing"
)

func TestCommandHelpWithoutTerminalOrPanel(t *testing.T) {
	for _, args := range [][]string{{"help"}, {"-h"}, {"--help"}, {"help", "agent"}, {"help", "resetpwd"}, {"help", "upgrade"}, {"help", "help"}, {"agent", "--help"}, {"resetpwd", "-h"}, {"upgrade", "--help"}} {
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
	for _, args := range [][]string{{"upgrade", "--source", "other"}, {"upgrade", "--channel", "stable"}, {"upgrade", "--password", "x"}, {"upgrade", "extra"}, {"agent", "extra"}, {"resetpwd", "--yes"}, {"help", "missing"}, {"help", "upgrade", "extra"}, {"upgrade"}, {"upgrade", "--source", "github", "--yes"}} {
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
		if opts != (upgradeOptions{Source: "gitee", Channel: "release", Yes: true}) {
			t.Fatalf("opts=%+v", opts)
		}
		return 130
	}
	var out bytes.Buffer
	if code := runWithDeps(testInfo, []string{"upgrade", "--source=gitee", "--channel", "release", "-y"}, nil, &out, &out, d); code != 130 {
		t.Fatalf("code=%d", code)
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

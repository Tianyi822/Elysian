//go:build linux || darwin

package cli

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/tui"

	"github.com/creack/pty"
)

// agentSmokeSize 冒烟终端尺寸（真实终端必有尺寸；宽度覆盖提示行下限）。
const agentSmokeCols = 120

// Agent 终端的真机冒烟（与 menu_pty_test 同法）：菜单 Enter 进 Agent 终端 → TUI
// boot 探测失败（注入恒「未启动」的 Discover）→ 连接错误屏呈现启动指引 → Esc 返回
// 菜单。锚定菜单↔TUI 握手与五态错误屏在真实终端的完整链路；环境无可用 pty 时跳过。

func TestAgentTerminalConnErrorRoundTripViaPty(t *testing.T) {
	master, tty, err := pty.Open()
	if err != nil {
		t.Skipf("环境无可用 pty，跳过 Agent 终端交互测试：%v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		_ = tty.Close()
	})
	if err := pty.Setsize(master, &pty.Winsize{Rows: 40, Cols: agentSmokeCols}); err != nil {
		t.Skipf("无法设置 pty 尺寸：%v", err)
	}
	d := fakeDeps()
	d.agentDeps = func() tui.Deps {
		deps := tui.Deps{
			Discover: func(context.Context) (string, error) {
				return "", &client.Error{Kind: client.KindNotRunning, Message: "面板后端连接被拒绝", Hint: client.HintFor(client.KindNotRunning)}
			},
			Dial:       func(string) tui.API { return nil }, // 未达拨号路径
			LoadCreds:  func() (string, string, error) { return "", "", nil },
			SaveCreds:  func(string, string) error { return nil },
			ClearCreds: func() error { return nil },
			LoadState:  func() tui.StoredState { return tui.StoredState{} },
			SaveState:  func(tui.StoredState) error { return nil },
		}
		return deps
	}
	out := &agentSmokeWriter{first: make(chan struct{})}
	errOut := &bytes.Buffer{}
	done := make(chan int, 1)
	go func() { done <- runMenu(testInfo, tty, out, errOut, d) }()
	<-out.first
	// 首帧后 Enter（焦点在「Agent 终端」）：菜单退出、TUI 启动并探测失败。
	if _, err := master.Write([]byte("\r")); err != nil {
		t.Fatal(err)
	}
	waitForAgent(t, out, "Agent 终端错误屏", func(s string) bool {
		return strings.Contains(s, "systemctl start elysian")
	})
	// Esc：TUI 退出并返回菜单。
	if _, err := master.Write([]byte("\x1b")); err != nil {
		t.Fatal(err)
	}
	// 菜单重启以第二次「面板未启动」为安全信号（探测回填即读取器就绪，按键不被
	// TCSAFLUSH 丢弃），随后退出菜单。
	waitForAgent(t, out, "TUI 退出返回菜单", func(s string) bool { return strings.Count(s, "面板未启动") >= 2 })
	if _, err := master.Write([]byte("jjjj\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("最终退出码应为 0，得到 %d（stderr：%q）", code, errOut.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("菜单未在时限内退出")
	}
}

// agentSmokeWriter 与 menu_pty_test 的 signalWriter 同形（独立类型避免测试文件间耦合）。
type agentSmokeWriter struct {
	once  sync.Once
	first chan struct{}
	buf   bytes.Buffer
	mu    sync.Mutex
}

func (w *agentSmokeWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.first) })
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *agentSmokeWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func waitForAgent(t *testing.T, out *agentSmokeWriter, what string, cond func(string) bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond(out.String()) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待 %s 超时，当前输出：\n%s", what, out.String())
}

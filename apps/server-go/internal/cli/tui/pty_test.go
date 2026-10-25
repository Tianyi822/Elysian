//go:build linux || darwin

package tui

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
	"github.com/creack/pty"
)

func TestTUIPTYChild(t *testing.T) {
	if os.Getenv("ELYSIAN_TUI_PTY_CHILD") != "1" {
		return
	}
	api := &fakeAPI{sessions: []client.Session{{ID: "s1", Title: "中文会话", ModelProfileID: "p1", ModelRevision: 1}}, profiles: pickerModels()}
	deps := (&fakeDeps{api: api, discover: okDiscover}).deps()
	deps.LoadCreds = func() (string, string, error) { return "", "", nil }
	deps.SaveState = func(state StoredState) error {
		raw, err := json.Marshal(state)
		if err != nil {
			return err
		}
		return os.WriteFile(os.Getenv("ELYSIAN_TUI_PTY_STATE"), raw, 0600)
	}
	err := Run(os.Stdin, os.Stdout, deps)
	if err != nil && !errors.Is(err, ErrExitCLI) {
		os.Exit(2)
	}
	os.Exit(0)
}

type ptyCapture struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (c *ptyCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.b.Write(p)
}
func (c *ptyCapture) text() string { c.mu.Lock(); defer c.mu.Unlock(); return c.b.String() }
func TestPTYChinesePasteResizePasswordAndExit(t *testing.T) {
	for _, signal := range []bool{false, true} {
		t.Run(map[bool]string{false: "CtrlC", true: "SIGTERM"}[signal], func(t *testing.T) {
			state := filepath.Join(t.TempDir(), "state.json")
			cmd := exec.Command(os.Args[0], "-test.run=^TestTUIPTYChild$")
			cmd.Env = append(os.Environ(), "ELYSIAN_TUI_PTY_CHILD=1", "ELYSIAN_TUI_PTY_STATE="+state, "TERM=xterm-256color", "NO_COLOR=1")
			terminal, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 32, Cols: 100})
			if err != nil {
				t.Fatal(err)
			}
			defer terminal.Close()
			defer cmd.Process.Kill()
			capture := &ptyCapture{}
			go func() {
				buf := make([]byte, 4096)
				for {
					n, e := terminal.Read(buf)
					if n > 0 {
						_, _ = capture.Write(buf[:n])
					}
					if e != nil {
						return
					}
				}
			}()
			wait := func(want string) {
				t.Helper()
				end := time.Now().Add(8 * time.Second)
				for time.Now().Before(end) {
					if strings.Contains(capture.text(), want) {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("未显示 %s：%s", want, capture.text())
			}
			wait("用户名")
			_, _ = terminal.Write([]byte("\t"))
			_, _ = terminal.Write([]byte("pty-secret-password"))
			time.Sleep(70 * time.Millisecond)
			if strings.Contains(capture.text(), "pty-secret-password") {
				t.Fatal("密码明文输出")
			}
			_, _ = terminal.Write([]byte("\r"))
			wait("中文会话")
			_, _ = terminal.Write([]byte("\r"))
			wait("暂无消息")
			draft := strings.Repeat("中文 é 👨‍👩‍👧‍👦 长内容 ", 40) + "\n第二行"
			_, _ = terminal.Write([]byte("\x1b[200~" + draft + "\x1b[201~"))
			time.Sleep(100 * time.Millisecond)
			_ = pty.Setsize(terminal, &pty.Winsize{Rows: 24, Cols: 70})
			_ = cmd.Process.Signal(syscall.SIGWINCH)
			time.Sleep(80 * time.Millisecond)
			if signal {
				_ = cmd.Process.Signal(syscall.SIGTERM)
			} else {
				_, _ = terminal.Write([]byte{3})
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("退出未收敛")
			}
			raw, err := os.ReadFile(state)
			if err != nil {
				t.Fatal(err)
			}
			var saved StoredState
			if err = json.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			if saved.Sessions["s1"].Draft != draft {
				t.Fatalf("粘贴或退出丢失草稿：got %d want %d", len(saved.Sessions["s1"].Draft), len(draft))
			}
		})
	}
}

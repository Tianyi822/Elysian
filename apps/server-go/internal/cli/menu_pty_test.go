//go:build linux || darwin

package cli

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/auth"

	"github.com/creack/pty"
)

// 菜单程序的真机交互测试（先例 auth 域 tty_linux_test.go 的 pty 驱动）：pty slave 作为
// stdin 进入 bubbletea 原始模式、signalWriter 作为渲染输出，首帧渲染后（输入读取器已
// 就绪、原始模式切换的 TCSAFLUSH 已发生）再写入 j/j/Enter 选中「退出」，锚定菜单真实
// 消费按键并以退出码 0 收敛、头部呈现面板探测结果。环境无可用 pty 时跳过（dev-check
// 容器内正常执行）。

// signalWriter 首次写入时关闭 channel（首帧渲染信号），此后继续累积渲染输出。
type signalWriter struct {
	once  sync.Once
	first chan struct{}
	buf   bytes.Buffer
	mu    sync.Mutex
}

func (w *signalWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.first) })
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *signalWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestMenuProgramInteractiveQuitViaPty(t *testing.T) {
	master, tty, err := pty.Open()
	if err != nil {
		t.Skipf("环境无可用 pty，跳过菜单交互测试：%v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		_ = tty.Close()
	})
	out := &signalWriter{first: make(chan struct{})}
	errOut := &bytes.Buffer{}
	done := make(chan int, 1)
	go func() { done <- runMenu(testInfo, tty, out, errOut, fakeDeps()) }()
	select {
	case <-out.first:
	case <-time.After(10 * time.Second):
		t.Fatal("菜单首帧未在时限内渲染")
	}
	// 首帧后再写按键：j/j 移动焦点到「退出」，Enter 确认退出。
	if _, err := master.Write([]byte("jjjj\r")); err != nil {
		t.Fatalf("写入按键失败：%v", err)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("选中「退出」应以退出码 0 收敛，得到 %d（stderr：%q）", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("菜单未在时限内退出（按键未被消费）")
	}
	rendered := out.String()
	for _, want := range []string{"Elysian CLI", "Agent 终端", "重置密码", "退出", "面板未启动"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("菜单渲染应含 %q：%q", want, rendered)
		}
	}
}

// 兜底断言 signalWriter 满足 io.Writer（runMenu 签名约束）。
var _ io.Writer = (*signalWriter)(nil)

// waitFor 轮询渲染输出直到出现目标子串（cond 返回真）或超时。
func waitFor(t *testing.T, out *signalWriter, what string, cond func(string) bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond(out.String()) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待 %s 超时，当前输出：\n%s", what, out.String())
}

// 菜单「重置密码」全程真机测试：门禁解析（env 覆盖到临时面板数据根）→ 真实
// auth.RunResetPasswordCLIAt 的 TTY 无回显双次输入 → 原子落盘 → 返回菜单 → 退出。
// 密码明文不得出现在任何输出捕获（隐藏输入不回显），凭据按 scrypt 落盘。
func TestMenuResetPasswordRoundTripViaPty(t *testing.T) {
	home := t.TempDir()
	master, tty, err := pty.Open()
	if err != nil {
		t.Skipf("环境无可用 pty，跳过菜单交互测试：%v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		_ = tty.Close()
	})
	d := fakeDeps()
	d.getenv = func(string) string { return home } // ELYSIAN_PANEL_HOME → 临时数据根
	d.runResetAt = auth.RunResetPasswordCLIAt      // 真实改密流程（含 TTY 隐藏输入）
	out := &signalWriter{first: make(chan struct{})}
	errOut := &bytes.Buffer{}
	done := make(chan int, 1)
	go func() { done <- runMenu(testInfo, tty, out, errOut, d) }()
	<-out.first
	// j 下移到「重置密码」，Enter 进入门禁与改密流程。
	if _, err := master.Write([]byte("j\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, out, "门禁路径提示", func(s string) bool { return strings.Contains(s, home+"/config/panel-credentials.json") })
	waitFor(t, out, "新密码提示", func(s string) bool { return strings.Contains(s, "新密码：") })
	const password = "ely-ptypass-9"
	if _, err := master.Write([]byte(password + "\n")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, out, "确认密码提示", func(s string) bool { return strings.Contains(s, "确认密码：") })
	if _, err := master.Write([]byte(password + "\n")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, out, "改密成功", func(s string) bool { return strings.Contains(s, "✓ 密码已重置") })
	// 返回菜单后再次探测到「面板未启动」（第二次出现）再退出：确保新菜单程序已完成
	// 原始模式切换，后续按键不被 TCSAFLUSH 丢弃。
	waitFor(t, out, "菜单重启", func(s string) bool { return strings.Count(s, "面板未启动") >= 2 })
	if _, err := master.Write([]byte("jjjj\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("菜单最终退出码应为 0，得到 %d（stderr：%q）", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("菜单未在时限内退出")
	}
	rendered := out.String()
	if strings.Contains(rendered, password) {
		t.Fatalf("TTY 隐藏输入的密码明文出现在输出捕获中：\n%s", rendered)
	}
	credentials, err := os.ReadFile(filepath.Join(home, "config", "panel-credentials.json"))
	if err != nil {
		t.Fatalf("凭据应落盘：%v", err)
	}
	if !strings.Contains(string(credentials), "scrypt:") {
		t.Errorf("凭据应为 scrypt 哈希：%s", credentials)
	}
}

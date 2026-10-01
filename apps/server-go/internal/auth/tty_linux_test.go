//go:build linux

package auth

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/creack/pty"
)

// TTY 无回显读的真机测试（resetPasswordCli 的 readHiddenFromTty 锚点）：经 pty 对
//（master 写入模拟键盘、slave 作为 stdin）驱动 termios raw mode 逐字节读，锚定回车
// 结束、退格弹字节、Ctrl-C 抛「已取消改密」。环境无可用 pty 时跳过（dev-check 容器
// 内正常执行）。

func openPty(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	master, slave, err := pty.Open()
	if err != nil {
		t.Skipf("环境无可用 pty，跳过 TTY 交互测试：%v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		_ = slave.Close()
	})
	return master, slave
}

func TestReadHiddenFromTTYLineInput(t *testing.T) {
	master, tty := openPty(t)
	stdout := &bytes.Buffer{}
	go func() {
		_, _ = master.Write([]byte("secret-password\n"))
	}()
	line, err := readHiddenAsync(t, tty, stdout, "提示：")
	if err != nil {
		t.Fatalf("readHiddenFromTTY 失败：%v", err)
	}
	if line != "secret-password" {
		t.Errorf("读到 %q，期望 secret-password", line)
	}
	if !bytes.HasPrefix(stdout.Bytes(), []byte("提示：")) || !bytes.HasSuffix(stdout.Bytes(), []byte("\n")) {
		t.Errorf("提示与回车换行都应写 stdout：%q", stdout.String())
	}
}

func TestReadHiddenFromTTYBackspace(t *testing.T) {
	master, tty := openPty(t)
	stdout := &bytes.Buffer{}
	go func() {
		_, _ = master.Write([]byte("abc\x7fd\n"))
	}()
	line, err := readHiddenAsync(t, tty, stdout, "")
	if err != nil {
		t.Fatalf("readHiddenFromTTY 失败：%v", err)
	}
	if line != "abd" {
		t.Errorf("退格应弹出一个字节，得 %q（期望 abd）", line)
	}
}

func TestReadHiddenFromTTYCtrlC(t *testing.T) {
	master, tty := openPty(t)
	stdout := &bytes.Buffer{}
	go func() {
		_, _ = master.Write([]byte{0x03})
	}()
	_, err := readHiddenAsync(t, tty, stdout, "")
	if err == nil || err.Error() != "已取消改密" {
		t.Fatalf("Ctrl-C 应抛「已取消改密」，得 %v", err)
	}
	if !bytes.HasSuffix(stdout.Bytes(), []byte("\n")) {
		t.Errorf("中止时输出换行：%q", stdout.String())
	}
}

func TestIsTerminalOnPtySlave(t *testing.T) {
	_, tty := openPty(t)
	if !isTerminal(tty) {
		t.Error("pty slave 应被判定为终端")
	}
	if isTerminal(nil) {
		t.Error("nil 不是终端")
	}
	// 普通文件不是终端（RunResetPasswordCLI 的 stdin 可能是重定向文件）。
	file, err := os.CreateTemp(t.TempDir(), "not-a-tty")
	if err != nil {
		t.Fatalf("建临时文件失败：%v", err)
	}
	defer file.Close()
	if isTerminal(file) {
		t.Error("普通文件不应被判定为终端")
	}
}

// readHiddenAsync 带时限地驱动 readHiddenFromTTY（pty 输入由调用方另行注入）。
func readHiddenAsync(t *testing.T, tty *os.File, stdout *bytes.Buffer, prompt string) (string, error) {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		line, err := readHiddenFromTTY(tty, stdout, prompt)
		done <- result{line: line, err: err}
	}()
	select {
	case r := <-done:
		return r.line, r.err
	case <-time.After(5 * time.Second):
		t.Fatal("readHiddenFromTTY 未在时限内返回")
		return "", nil
	}
}

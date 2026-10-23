//go:build linux

package auth

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/creack/pty"
)

// TTY 无回显读的真机测试（resetPasswordCli 的 readHiddenFromTty 锚点）：经 pty 对
//（master 写入模拟键盘、slave 作为 stdin）驱动 termios raw mode 逐字节读，锚定回车
// 结束、退格删字符、Ctrl-C 抛「已取消改密」。环境无可用 pty 时跳过（dev-check 容器
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
	line, err := readHiddenInput(t, master, tty, stdout, "提示：", []byte("secret-password\n"))
	if err != nil {
		t.Fatalf("readHiddenFromTTY 失败：%v", err)
	}
	if line != "secret-password" {
		t.Errorf("读到 %q，期望 secret-password", line)
	}
	if stdout.String() != "提示：\r\n" {
		t.Errorf("提示与回车换行都应写 stdout：%q", stdout.String())
	}
}

func TestReadHiddenFromTTYBackspace(t *testing.T) {
	master, tty := openPty(t)
	stdout := &bytes.Buffer{}
	line, err := readHiddenInput(t, master, tty, stdout, "", []byte("abc\x7fd\n"))
	if err != nil {
		t.Fatalf("readHiddenFromTTY 失败：%v", err)
	}
	if line != "abd" {
		t.Errorf("退格应弹出一个字节，得 %q（期望 abd）", line)
	}
}

func TestReadHiddenFromTTYUTF8Backspace(t *testing.T) {
	master, tty := openPty(t)
	line, err := readHiddenInput(t, master, tty, io.Discard, "", []byte("密码\x7f码\r"))
	if err != nil || line != "密码" {
		t.Fatalf("退格应删除整个 UTF-8 字符：line=%q err=%v", line, err)
	}
}

func TestReadHiddenFromTTYCtrlC(t *testing.T) {
	master, tty := openPty(t)
	stdout := &bytes.Buffer{}
	_, err := readHiddenInput(t, master, tty, stdout, "", []byte{0x03})
	if err == nil || err.Error() != "已取消改密" {
		t.Fatalf("Ctrl-C 应抛「已取消改密」，得 %v", err)
	}
	if !bytes.HasSuffix(stdout.Bytes(), []byte("\n")) {
		t.Errorf("中止时输出换行：%q", stdout.String())
	}
}

func TestReadHiddenFromTTYRestoresStateAndCursor(t *testing.T) {
	for _, test := range []struct {
		name  string
		input []byte
		err   error
	}{
		{"enter", []byte("secret-password\r"), nil},
		{"cancel", []byte{0x03}, errPasswordResetCancelled},
		{"end-input", []byte{0x04}, errPasswordInputEnded},
	} {
		t.Run(test.name, func(t *testing.T) {
			master, tty := openPty(t)
			original := readTermios(t, tty)
			_, err := readHiddenInput(t, master, tty, tty, "提示：", test.input)
			if !errors.Is(err, test.err) {
				t.Fatalf("结束状态错误：%v", err)
			}
			if restored := readTermios(t, tty); restored != original {
				t.Fatalf("终端属性未恢复：before=%+v after=%+v", original, restored)
			}
			fmt.Fprintln(tty, "next")
			want := "提示：\r\nnext\r\n"
			done := make(chan string, 1)
			go func() {
				output := make([]byte, len(want))
				_, _ = io.ReadFull(master, output)
				done <- string(output)
			}()
			select {
			case output := <-done:
				if output != want {
					t.Fatalf("密码不得回显，后续输出必须回到行首：%q", output)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("终端未输出完整回车换行")
			}
		})
	}
}

func readTermios(t *testing.T, tty *os.File) syscall.Termios {
	t.Helper()
	var attributes syscall.Termios
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, tty.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&attributes)), 0, 0, 0); errno != 0 {
		t.Fatal(errno)
	}
	return attributes
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

type passwordPromptWriter struct {
	io.Writer
	ready chan struct{}
	once  sync.Once
}

func (w *passwordPromptWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	w.once.Do(func() { close(w.ready) })
	return n, err
}

// 等待提示输出（此时已关闭回显）后再输入，避免 Ctrl-C 在进入 raw mode 前被终端吞掉。
func readHiddenInput(t *testing.T, master, tty *os.File, stdout io.Writer, prompt string, input []byte) (string, error) {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	writer := &passwordPromptWriter{Writer: stdout, ready: make(chan struct{})}
	go func() {
		line, err := readHiddenFromTTY(tty, writer, prompt)
		done <- result{line: line, err: err}
	}()
	select {
	case <-writer.ready:
		if _, err := master.Write(input); err != nil {
			t.Fatal(err)
		}
	case result := <-done:
		return result.line, result.err
	case <-time.After(5 * time.Second):
		t.Fatal("终端未开始密码输入")
	}
	select {
	case r := <-done:
		return r.line, r.err
	case <-time.After(5 * time.Second):
		t.Fatal("readHiddenFromTTY 未在时限内返回")
		return "", nil
	}
}

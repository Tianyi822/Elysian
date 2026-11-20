package shared

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const systemCommandTimeout = 30 * time.Second

// SystemCommand 限制系统操作的执行时间；取消时也结束继承管道的子进程。
// 调用方必须在 Run/Wait 后调用 cancel，密码等敏感参数不进入错误消息。
func SystemCommand(parent context.Context, name string, args ...string) (*exec.Cmd, context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, systemCommandTimeout)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	return cmd, ctx, cancel
}

func SystemCommandError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("系统命令超时或已取消，操作结果尚未确认：%w", ctx.Err())
	}
	return err
}

// RunCapture 执行命令并单独捕获 stderr；stdout 仍由调用方选择接收或丢弃。
func RunCapture(cmd *exec.Cmd) (stderr string, err error) {
	var output bytes.Buffer
	cmd.Stderr = &output
	err = cmd.Run()
	return output.String(), err
}

// CommandErrorWithStderr 优先使用非空的 stderr；没有详情时保留原始错误。
func CommandErrorWithStderr(err error, stderr string) error {
	if detail := strings.TrimSpace(stderr); detail != "" {
		return errors.New(detail)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if detail := strings.TrimSpace(string(exit.Stderr)); detail != "" {
			return errors.New(detail)
		}
	}
	return err
}

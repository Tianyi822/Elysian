package shared

import (
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

const SystemCommandTimeout = 30 * time.Second

// SystemCommand 限制系统操作的执行时间；取消时也结束继承管道的子进程。
// 调用方必须在 Run/Wait 后调用 cancel，密码等敏感参数不进入错误消息。
func SystemCommand(parent context.Context, name string, args ...string) (*exec.Cmd, context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, SystemCommandTimeout)
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

//go:build !linux && !darwin

package auth

import (
	"errors"
	"io"
	"os"
)

// TTY 无回显读的其余平台回落实现：Linux 与 darwin 各有 termios 实现（tty_linux.go /
// tty_darwin.go），dev-check 容器与部署目标是 Linux、macOS 供开发机联调，其余平台一律
// 视为非终端，走明文行读路径；readHidden 不会被调用到。

// isTerminal 非 Linux 非 darwin 平台恒 false：无 termios ioctl 可用即不做无回显读。
func isTerminal(file *os.File) bool { return false }

// readHiddenFromTTY 非 Linux 非 darwin 平台不可用。
func readHiddenFromTTY(file *os.File, stdout io.Writer, prompt string) (string, error) {
	return "", errors.New("当前平台不支持无回显输入")
}

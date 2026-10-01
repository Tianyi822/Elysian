//go:build !linux

package auth

import (
	"errors"
	"io"
	"os"
)

// TTY 无回显读的非 Linux 回落实现：dev-check 容器与部署目标都是 Linux，其他平台
//（如开发机本机误跑）一律视为非终端，走明文行读路径；readHidden 不会被调用到。

// isTerminal 非 Linux 平台恒 false：无 termios ioctl 可用即不做无回显读。
func isTerminal(file *os.File) bool { return false }

// readHiddenFromTTY 非 Linux 平台不可用。
func readHiddenFromTTY(file *os.File, stdout io.Writer, prompt string) (string, error) {
	return "", errors.New("当前平台不支持无回显输入")
}

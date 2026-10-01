//go:build linux

package auth

import (
	"fmt"
	"io"
	"os"
	"syscall"
	"unsafe"
)

// TTY 无回显读的 Linux 实现（Node setRawMode 的等价物，标准库 syscall 直接 ioctl；
// 固定选型不含 golang.org/x/term）。

// isTerminal 判定文件描述符是否挂在终端上：TCGETS 成功即是（/dev/null 等 character
// device 会被 ioctl 拒绝，不误判）。
func isTerminal(file *os.File) bool {
	if file == nil {
		return false
	}
	var termios syscall.Termios
	_, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, file.Fd(), syscall.TCGETS,
		uintptr(unsafe.Pointer(&termios)), 0, 0, 0)
	return errno == 0
}

// readHiddenFromTTY 交互式无回显读一行：写提示 → 进入 raw mode（关回显与行编辑、
// Ctrl-C 以字节到达由本函数处理）→ 逐字节缓冲；回车（0x0d/0x0a）结束并输出换行；
// 退格（0x7f/0x08）弹出一个字节；Ctrl-C（0x03）输出换行后中止「已取消改密」。
// 结束后恢复原 termios。UTF-8 输入按字节缓冲、按原样回放（与 TS 字节数组等价）。
func readHiddenFromTTY(file *os.File, stdout io.Writer, prompt string) (string, error) {
	fmt.Fprint(stdout, prompt)
	var original syscall.Termios
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, file.Fd(), syscall.TCGETS,
		uintptr(unsafe.Pointer(&original)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("读取终端属性失败：%v", errno)
	}
	raw := original
	enterRawMode(&raw)
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, file.Fd(), syscall.TCSETS,
		uintptr(unsafe.Pointer(&raw)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("设置终端 raw mode 失败：%v", errno)
	}
	defer func() {
		_, _, _ = syscall.Syscall6(syscall.SYS_IOCTL, file.Fd(), syscall.TCSETS,
			uintptr(unsafe.Pointer(&original)), 0, 0, 0)
	}()

	var buf []byte
	chunk := make([]byte, 1)
	for {
		n, err := file.Read(chunk)
		if n == 0 {
			if err != nil {
				return "", err
			}
			continue
		}
		switch chunk[0] {
		case 0x03: // Ctrl-C：中止。
			fmt.Fprint(stdout, "\n")
			return "", errPasswordResetCancelled
		case 0x0d, 0x0a: // 回车：结束。
			fmt.Fprint(stdout, "\n")
			return string(buf), nil
		case 0x7f, 0x08: // 退格：弹出一个字节。
			if len(buf) > 0 {
				buf = buf[:len(buf)-1]
			}
		default:
			buf = append(buf, chunk[0])
		}
	}
}

// enterRawMode 按 cfmakeraw 语义构造 raw termios：关输入的 BRKINT/ICRNL/IXON 等、
// 输出的 OPOST、本地的 ECHO/ICANON/ISIG/IEXTEN，VMIN=1/VTIME=0 逐字节读。
func enterRawMode(termios *syscall.Termios) {
	termios.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP |
		syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	termios.Oflag &^= syscall.OPOST
	termios.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	termios.Cflag &^= syscall.CSIZE | syscall.PARENB
	termios.Cflag |= syscall.CS8
	termios.Cc[syscall.VMIN] = 1
	termios.Cc[syscall.VTIME] = 0
}

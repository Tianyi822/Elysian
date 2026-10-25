//go:build darwin

package auth

import (
	"fmt"
	"io"
	"os"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/unix"
)

// TTY 无回显读的 macOS 实现（macOS 开发机联调；部署目标与 dev-check 容器是 Linux）：
// darwin 无 TCGETS/TCSETS，termios 经已是直接依赖的 golang.org/x/sys/unix 走
// TIOCGETA/TIOCSETA，raw mode 语义与 Linux 版逐条一致（cfmakeraw 同款标志位）。

// isTerminal 判定文件描述符是否挂在终端上：TIOCGETA 成功即是（/dev/null 等 character
// device 会被 ioctl 拒绝，不误判）。
func isTerminal(file *os.File) bool {
	if file == nil {
		return false
	}
	var termios unix.Termios
	_, _, errno := unix.Syscall6(unix.SYS_IOCTL, file.Fd(), unix.TIOCGETA,
		uintptr(unsafe.Pointer(&termios)), 0, 0, 0)
	return errno == 0
}

// readHiddenFromTTY 交互式无回显读一行：进入 raw mode（关回显与行编辑、
// Ctrl-C 以字节到达由本函数处理）→ 写提示 → 逐字节缓冲；回车结束输入；
// 退格删除一个 UTF-8 字符；Ctrl-C 中止，Ctrl-D 结束输入。
// 结束时显式回车换行，再恢复原 termios，避免 raw mode 下只有换行导致后续提示右移。
func readHiddenFromTTY(file *os.File, stdout io.Writer, prompt string) (string, error) {
	var original unix.Termios
	if _, _, errno := unix.Syscall6(unix.SYS_IOCTL, file.Fd(), unix.TIOCGETA,
		uintptr(unsafe.Pointer(&original)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("读取终端属性失败：%v", errno)
	}
	raw := original
	enterRawMode(&raw)
	if _, _, errno := unix.Syscall6(unix.SYS_IOCTL, file.Fd(), unix.TIOCSETA,
		uintptr(unsafe.Pointer(&raw)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("设置终端 raw mode 失败：%v", errno)
	}
	defer func() {
		// OPOST 在 raw mode 下关闭，必须同时复位列位置与换行。
		fmt.Fprint(stdout, "\r\n")
		_, _, _ = unix.Syscall6(unix.SYS_IOCTL, file.Fd(), unix.TIOCSETA,
			uintptr(unsafe.Pointer(&original)), 0, 0, 0)
	}()
	fmt.Fprint(stdout, prompt)

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
			return "", errPasswordResetCancelled
		case 0x04: // Ctrl-D：输入结束。
			return "", errPasswordInputEnded
		case 0x0d, 0x0a: // 回车：结束。
			return string(buf), nil
		case 0x7f, 0x08: // 退格：删除一个字符。
			if len(buf) > 0 {
				_, size := utf8.DecodeLastRune(buf)
				buf = buf[:len(buf)-size]
			}
		default:
			buf = append(buf, chunk[0])
		}
	}
}

// enterRawMode 按 cfmakeraw 语义构造 raw termios：关输入的 BRKINT/ICRNL/IXON 等、
// 输出的 OPOST、本地的 ECHO/ICANON/ISIG/IEXTEN，VMIN=1/VTIME=0 逐字节读。
func enterRawMode(termios *unix.Termios) {
	termios.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP |
		unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	termios.Oflag &^= unix.OPOST
	termios.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	termios.Cflag &^= unix.CSIZE | unix.PARENB
	termios.Cflag |= unix.CS8
	termios.Cc[unix.VMIN] = 1
	termios.Cc[unix.VTIME] = 0
}

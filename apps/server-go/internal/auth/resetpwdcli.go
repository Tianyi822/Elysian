package auth

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// resetpwd 提供无会话可用时的本机改密入口，与设置页共用 ChangePanelPassword。
// 交互终端隐藏输入并允许校验失败后重试；管道和文件输入只消费两行，失败立即退出。

// resetPasswordIO CLI 的 IO 出口：测试注入 fake（不真起交互）。
type resetPasswordIO struct {
	// isTTY 报告输入端是否交互终端。
	isTTY func() bool
	// readHidden 交互式无回显读一行（termios raw mode）。
	readHidden func(prompt string) (string, error)
	// readLine 逐行读取（非 TTY：管道/脚本，带跨调用行缓冲）。
	readLine func(prompt string) (string, error)
	// print 打印一行。
	print func(text string)
}

// errPasswordResetCancelled Ctrl-C 中止改密。
var errPasswordResetCancelled = errors.New("已取消改密")

// errPasswordInputEnded EOF 且未读到任何内容。
var errPasswordInputEnded = errors.New("输入已结束，未读到密码")

// runResetPasswordCli CLI 主流程（IO 与改密依赖全部经注入出口）：读两次密码 → 纯函数
// 改密 → 打印结果。TTY 校验失败可重试；ELYSIAN_AUTH_DEV=1 时追加 dev 说明行。
func runResetPasswordCli(io_ resetPasswordIO, credentials CredentialsStore, hasher PasswordHasher, authDev bool) error {
	tty := io_.isTTY()
	read := io_.readLine
	if tty {
		read = io_.readHidden
	}
	io_.print("Elysian | 重置密码")
	io_.print("")
	io_.print("管理员：" + PanelUsername)
	if tty {
		io_.print("密码至少 8 位，输入不回显。")
		io_.print("保存后全部登录会话失效；Ctrl+C 取消。")
	} else {
		io_.print("非交互输入：按顺序读取新密码和确认密码，共两行。")
		io_.print("密码至少 8 位，保存后全部登录会话失效。")
	}
	io_.print("")
	for {
		first, err := read("新密码：")
		if err != nil {
			return err
		}
		if tty && utf16Length(first) < PasswordMinLength {
			io_.print("! 密码至少需要 8 位，请重新输入。")
			io_.print("")
			continue
		}
		second, err := read("确认密码：")
		if err != nil {
			return err
		}
		if _, err := ChangePanelPassword(credentials, hasher, first, second); err != nil {
			var invalid *shared.InvalidRequestError
			if tty && errors.As(err, &invalid) {
				io_.print("! " + err.Error() + "，请重新输入。")
				io_.print("")
				continue
			}
			return err
		}
		break
	}
	io_.print("")
	io_.print("✓ 密码已重置")
	io_.print("全部现有登录会话已失效。")
	io_.print("请使用新密码重新登录。")
	if authDev {
		io_.print("开发固定账号不受影响（仅开发环境可用）。")
	}
	return nil
}

// RunResetPasswordCLI `elysian resetpwd` 子命令入口（go-plan §3.8 冻结签名）：
// 失败打印错误消息到 stderr 并回 1，成功回 0。dev 开关经 config.Load 取得（域包不读 env）。
func RunResetPasswordCLI(stdin io.Reader, stdout io.Writer) int {
	credentials := NewFileCredentialsStore(paths.Default.PanelCredentials)
	hasher := NewScryptHasher()
	lines := &nonTTYLineReader{reader: stdin}
	file, isFile := stdin.(*os.File)
	io_ := resetPasswordIO{
		isTTY: func() bool { return isFile && isTerminal(file) },
		readHidden: func(prompt string) (string, error) {
			if !isFile {
				return "", errPasswordInputEnded
			}
			return readHiddenFromTTY(file, stdout, prompt)
		},
		readLine: func(prompt string) (string, error) {
			fmt.Fprint(stdout, prompt)
			defer fmt.Fprintln(stdout)
			return lines.next()
		},
		print: func(text string) { fmt.Fprintln(stdout, text) },
	}
	if err := runResetPasswordCli(io_, credentials, hasher, config.Load().AuthDev); err != nil {
		if errors.Is(err, errPasswordResetCancelled) {
			fmt.Fprintln(stdout, "\n− 已取消，密码未修改。")
		} else {
			fmt.Fprintln(os.Stderr, "\n✗ 重置失败："+err.Error())
		}
		return 1
	}
	return 0
}

// nonTTYLineReader 非 TTY 逐行读的跨调用缓冲：一次读可能带多行（管道一次性写入），
// 未消费的余量必须留给下一次读，否则第二行被静默丢弃（TS stdinLeftover 的等价物）。
// 读到换行即止（末尾 \r 归一）；EOF 时把剩余内容当最后一行，一无所有则报中文错误
// （脚本场景下快速失败而不是挂死）。
type nonTTYLineReader struct {
	reader io.Reader
	buf    string
	eof    bool
}

// next 读下一行（不含换行）。
func (l *nonTTYLineReader) next() (string, error) {
	for {
		if i := strings.IndexByte(l.buf, '\n'); i >= 0 {
			line := strings.TrimSuffix(l.buf[:i], "\r")
			l.buf = l.buf[i+1:]
			return line, nil
		}
		if l.eof {
			if l.buf == "" {
				return "", errPasswordInputEnded
			}
			line := strings.TrimSuffix(l.buf, "\r")
			l.buf = ""
			return line, nil
		}
		chunk := make([]byte, 4096)
		n, err := l.reader.Read(chunk)
		l.buf += string(chunk[:n])
		if err == io.EOF {
			l.eof = true
		} else if err != nil {
			return "", err
		}
	}
}

// readHiddenFromTTY 的平台差异实现：Linux 用 termios ioctl（dev-check 容器与部署目标
// 都是 Linux）；其余平台视为不可用（明文读兜底由 RunResetPasswordCLI 的 isTTY 判定
// 挡住，不会走到 readHidden 的平台回落分支）。
// 固定选型不含 golang.org/x/term（auth 盘点 §12），故直接用标准库 syscall 实现。

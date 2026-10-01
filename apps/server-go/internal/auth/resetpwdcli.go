package auth

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
)

// 改密 CLI 入口（resetPasswordCli.ts 等价物）：`elysian resetpwd` 子命令（非 HTTP 端点
// ——「改密只能在命令行进行」，面板不提供改密界面端点，也少一个高价值攻击面）。
//
// 交互全中文，退出码非 0 即失败：
//  1. 提示输入新密码（至少 8 位）：真 TTY 用 termios raw mode 逐字节读、不回显、支持
//     退格、回车结束、Ctrl-C 中止；非 TTY（管道/脚本）改逐行读并事前提示输入将明文回显。
//  2. 再次输入新密码，同法读入。
//  3. 两次明文交给 ChangePanelPassword 纯函数校验并写盘（只写凭据文件、不触碰会话
//     文件——既有会话靠 epoch 机制在下一次请求时失效）。
//  4. 打印改密结果；ELYSIAN_AUTH_DEV=1 时追加开发固定账号不受影响的说明。
//
// 落点纪律：校验与写盘逻辑全在 passwordchange.go；本文件只做 stdin 交互与打印。
// runResetPasswordCli 是可注入 IO 的核心流程（测试驱动），RunResetPasswordCLI 绑真实
// stdin/stdout 与 config.Load 产出的 dev 开关。

// resetPasswordIO CLI 的 IO 出口：测试注入 fake（不真起交互）。
type resetPasswordIO struct {
	// isTTY 报告输入端是否交互终端。
	isTTY func() bool
	// readHidden 交互式无回显读一行（termios raw mode）。
	readHidden func(prompt string) (string, error)
	// readLine 明文读一行（非 TTY：管道/脚本，带跨调用行缓冲）。
	readLine func(prompt string) (string, error)
	// print 打印一行。
	print func(text string)
}

// errPasswordResetCancelled Ctrl-C 中止改密。
var errPasswordResetCancelled = errors.New("已取消改密")

// errPasswordInputEnded EOF 且未读到任何内容。
var errPasswordInputEnded = errors.New("输入已结束，未读到密码")

// runResetPasswordCli CLI 主流程（IO 与改密依赖全部经注入出口）：读两次密码 → 纯函数
// 改密 → 打印结果。校验失败向上抛中文错误；ELYSIAN_AUTH_DEV=1 时追加 dev 说明行。
func runResetPasswordCli(io_ resetPasswordIO, credentials CredentialsStore, hasher PasswordHasher, authDev bool) error {
	tty := io_.isTTY()
	read := io_.readLine
	if tty {
		read = io_.readHidden
	}
	if !tty {
		io_.print("当前不是交互终端，输入将明文回显")
	}
	first, err := read("请输入新密码（至少 8 位）：")
	if err != nil {
		return err
	}
	second, err := read("请再次输入新密码：")
	if err != nil {
		return err
	}
	if _, err := ChangePanelPassword(credentials, hasher, first, second); err != nil {
		return err
	}
	io_.print("面板密码已修改；全部现有登录会话已失效，请重新登录。")
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
			return lines.next()
		},
		print: func(text string) { fmt.Fprintln(stdout, text) },
	}
	if err := runResetPasswordCli(io_, credentials, hasher, config.Load().AuthDev); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
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

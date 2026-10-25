package auth

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// resetpwd CLI 的非 TTY 路径测试：经注入 IO 的 runResetPasswordCli + 文件版 store
//（凭据路径指向临时目录）驱动，锚定跨调用行缓冲、\r\n 归一、EOF「输入已结束，未读到
// 密码」、错误中文上抛与真实落盘。RunResetPasswordCLI 是绑定 paths.Default 与
// config.Load 的薄封装（go-plan §3.8 冻结签名，无法注入路径），其组合行为（含退出码）
// 不在单测覆盖——由集成阶段端到端覆盖。TTY 无回显读（termios raw mode）的交互行为由
// tty_linux_test.go 用 pty 实测。

func TestResetPasswordCliNonTTYHappyPath(t *testing.T) {
	dir := tempDir(t)
	credentialsPath := filepath.Join(dir, "config", "panel-credentials.json")
	stdin := &bytes.Buffer{}
	stdin.WriteString("new-password-1\nnew-password-1\n")
	stdout := &bytes.Buffer{}

	credentials := NewFileCredentialsStore(credentialsPath)
	lines := &nonTTYLineReader{reader: stdin}
	io_ := resetPasswordIO{
		isTTY:      func() bool { return false },
		readHidden: func(string) (string, error) { return "", errors.New("不应走无回显读") },
		readLine: func(prompt string) (string, error) {
			stdout.WriteString(prompt + "\n")
			return lines.next()
		},
		print: func(text string) { stdout.WriteString(text + "\n") },
	}
	if err := runResetPasswordCli(io_, credentials, NewScryptHasher(), false); err != nil {
		t.Fatalf("CLI 失败：%v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "非交互输入") {
		t.Errorf("提示非交互输入：%q", out)
	}
	if !strings.Contains(out, "✓ 密码已重置\n全部现有登录会话已失效。\n请使用新密码重新登录。") {
		t.Errorf("成功文案缺失：%q", out)
	}
	if !strings.Contains(out, "新密码：\n确认密码：\n") {
		t.Errorf("两次提示缺失：%q", out)
	}
	current, err := credentials.Current()
	if err != nil || current == nil {
		t.Fatalf("凭据应落盘：(%v, %v)", current, err)
	}
	ok, err := NewScryptHasher().Verify("new-password-1", current.PasswordHash)
	if err != nil || !ok {
		t.Errorf("新密码可验证登录：(%v, %v)", ok, err)
	}
}

func TestNonTTYLineReaderOneWriteMultipleLines(t *testing.T) {
	// 一次写入带多行：未消费的余量留给下一次读，第二行不被静默丢弃。
	stdin := &bytes.Buffer{}
	stdin.WriteString("new-password-1\nnew-password-1\n")
	lines := &nonTTYLineReader{reader: stdin}
	first, err := lines.next()
	if err != nil || first != "new-password-1" {
		t.Fatalf("第一次读 = (%q, %v)", first, err)
	}
	second, err := lines.next()
	if err != nil || second != "new-password-1" {
		t.Fatalf("第二次读 = (%q, %v)（跨调用缓冲应保留余量）", second, err)
	}
}

func TestNonTTYLineReaderCRLFNormalization(t *testing.T) {
	lines := &nonTTYLineReader{reader: strings.NewReader("new-password-1\r\n")}
	line, err := lines.next()
	if err != nil || line != "new-password-1" {
		t.Fatalf("末尾 \\r 应归一：(%q, %v)", line, err)
	}
}

func TestNonTTYLineReaderEOFNoInput(t *testing.T) {
	lines := &nonTTYLineReader{reader: &bytes.Buffer{}}
	_, err := lines.next()
	if err == nil || err.Error() != "输入已结束，未读到密码" {
		t.Fatalf("EOF 无内容应报中文错误，得 %v", err)
	}
}

func TestNonTTYLineReaderEOFTailAsLastLine(t *testing.T) {
	lines := &nonTTYLineReader{reader: strings.NewReader("last-line-no-newline")}
	line, err := lines.next()
	if err != nil || line != "last-line-no-newline" {
		t.Fatalf("EOF 时剩余内容当最后一行：(%q, %v)", line, err)
	}
	_, err = lines.next()
	if err == nil || err.Error() != "输入已结束，未读到密码" {
		t.Fatalf("再读应报 EOF 错误，得 %v", err)
	}
}

func TestResetPasswordCliNonTTYFileInputIsNotTerminal(t *testing.T) {
	// 普通文件（重定向脚本）不是终端：走明文读路径，两次不一致向上抛中文错误且不落盘。
	dir := tempDir(t)
	script := filepath.Join(dir, "input.txt")
	if err := os.WriteFile(script, []byte("new-password-1\ndifferent-pwd\n"), 0o600); err != nil {
		t.Fatalf("写输入文件失败：%v", err)
	}
	stdin, err := os.Open(script)
	if err != nil {
		t.Fatalf("打开输入文件失败：%v", err)
	}
	defer stdin.Close()
	if isTerminal(stdin) {
		t.Fatal("普通文件不应被判定为终端")
	}

	credentials := NewMemoryCredentialsStore(nil)
	lines := &nonTTYLineReader{reader: stdin}
	io_ := resetPasswordIO{
		isTTY:      func() bool { return false },
		readHidden: func(string) (string, error) { return "", errors.New("不应走无回显读") },
		readLine:   func(string) (string, error) { return lines.next() },
		print:      func(string) {},
	}
	err = runResetPasswordCli(io_, credentials, NewScryptHasher(), false)
	if err == nil || err.Error() != "两次输入的密码不一致" {
		t.Fatalf("err = %v，期望「两次输入的密码不一致」", err)
	}
	current, _ := credentials.Current()
	if current != nil {
		t.Error("校验失败不应写凭据")
	}
}

func TestRunResetPasswordCLIAtWritesToPanelHome(t *testing.T) {
	dir := tempDir(t)
	stdin := strings.NewReader("panel-home-pwd-1\npanel-home-pwd-1\n")
	stdout := &bytes.Buffer{}
	if code := RunResetPasswordCLIAt(dir, stdin, stdout); code != 0 {
		t.Fatalf("退出码 = %d，输出 %q", code, stdout.String())
	}
	credentialsPath := filepath.Join(dir, "config", "panel-credentials.json")
	credentials := NewFileCredentialsStore(credentialsPath)
	current, err := credentials.Current()
	if err != nil || current == nil {
		t.Fatalf("凭据应落在注入 panelHome 下：(%v, %v)", current, err)
	}
	ok, err := NewScryptHasher().Verify("panel-home-pwd-1", current.PasswordHash)
	if err != nil || !ok {
		t.Errorf("panelHome 下的新密码可验证：(%v, %v)", ok, err)
	}
	if strings.Contains(stdout.String(), "panel-home-pwd-1") {
		t.Errorf("密码明文不得出现在输出：%q", stdout.String())
	}
}

func TestRunResetPasswordCLIAtMismatchExitsOneWithoutFile(t *testing.T) {
	dir := tempDir(t)
	stdin := strings.NewReader("first-password\ndifferent-pwd\n")
	stdout := &bytes.Buffer{}
	if code := RunResetPasswordCLIAt(dir, stdin, stdout); code != 1 {
		t.Fatalf("两次不一致应回 1，得 %d", code)
	}
	if _, err := os.Stat(filepath.Join(dir, "config", "panel-credentials.json")); !os.IsNotExist(err) {
		t.Error("校验失败不应写凭据文件")
	}
}

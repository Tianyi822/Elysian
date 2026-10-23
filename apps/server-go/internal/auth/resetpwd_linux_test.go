//go:build linux

package auth

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestResetPasswordCLIProcess(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_RESETPWD_PROCESS") == "1" {
		os.Exit(RunResetPasswordCLI(os.Stdin, os.Stdout))
	}
}

func resetPasswordCommand(t *testing.T, home string) *exec.Cmd {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestResetPasswordCLIProcess$")
	command.Env = append(os.Environ(), "ELYSIAN_TEST_RESETPWD_PROCESS=1", "ELYSIAN_AUTH_DEV=0", "HOME="+home)
	return command
}

func TestResetPasswordCLIRealTerminal(t *testing.T) {
	type input struct{ prompt, value string }
	for _, test := range []struct {
		name     string
		input    []input
		result   string
		password string
	}{
		{"success", []input{{"新密码：", "new-password-1\r"}, {"确认密码：", "new-password-1\r"}}, "✓ 密码已重置", "new-password-1"},
		{"retry", []input{{"新密码：", "short\r"}, {"新密码：", "new-password-1\r"}, {"确认密码：", "different-password\r"}, {"新密码：", "new-password-2\r"}, {"确认密码：", "new-password-2\r"}}, "✓ 密码已重置", "new-password-2"},
		{"cancel", []input{{"新密码：", "\x03"}}, "− 已取消，密码未修改。", ""},
		{"end-input", []input{{"新密码：", "\x04"}}, "✗ 重置失败：输入已结束，未读到密码", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := tempDir(t)
			command := resetPasswordCommand(t, home)
			terminal, err := pty.Start(command)
			if err != nil {
				t.Fatal(err)
			}
			defer terminal.Close()
			reader := bufio.NewReader(terminal)
			var output strings.Builder
			for _, input := range test.input {
				for !strings.HasSuffix(output.String(), input.prompt) {
					b, err := reader.ReadByte()
					if err != nil {
						t.Fatalf("等待输入提示 %q 失败：%v；输出：%q", input.prompt, err, output.String())
					}
					output.WriteByte(b)
				}
				if _, err := io.WriteString(terminal, input.value); err != nil {
					t.Fatal(err)
				}
				// 下一次等待必须读取新的提示，不能复用本次已消费的后缀。
				b, err := reader.ReadByte()
				if err != nil {
					t.Fatal(err)
				}
				output.WriteByte(b)
			}
			remaining, _ := io.ReadAll(reader) // Linux PTY 在从端关闭后返回 EIO。
			output.Write(remaining)
			err = command.Wait()
			if (err == nil) != (test.password != "") {
				t.Fatalf("退出状态错误：%v；输出：%q", err, output.String())
			}
			transcript := output.String()
			if !strings.Contains(transcript, test.result) {
				t.Fatalf("缺少结果提示：%q", transcript)
			}
			if strings.Contains(strings.ReplaceAll(transcript, "\r\n", ""), "\n") {
				t.Fatalf("真实终端中存在未复位列位置的换行：%q", transcript)
			}
			for _, input := range test.input {
				if value := strings.TrimSuffix(input.value, "\r"); len(value) > 1 && strings.Contains(transcript, value) {
					t.Fatalf("终端不应回显密码：%q", transcript)
				}
			}
			credentials, err := NewFileCredentialsStore(filepath.Join(home, ".Elysian", "config", "panel-credentials.json")).Current()
			if err != nil {
				t.Fatal(err)
			}
			if test.password == "" {
				if credentials != nil {
					t.Fatal("未完成输入时不能写入凭据")
				}
			} else if credentials == nil {
				t.Fatal("成功后应持久化凭据")
			} else if ok, err := NewScryptHasher().Verify(test.password, credentials.PasswordHash); err != nil || !ok {
				t.Fatalf("最终密码无法验证：%v", err)
			}
		})
	}
}

func TestResetPasswordCLIRealPipe(t *testing.T) {
	command := resetPasswordCommand(t, tempDir(t))
	command.Stdin = strings.NewReader("new-password-1\nnew-password-1\n")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("管道改密失败：%v；%s", err, output)
	}
	transcript := string(output)
	if !strings.Contains(transcript, "新密码：\n确认密码：\n") || !strings.Contains(transcript, "✓ 密码已重置") || strings.Contains(transcript, "new-password-1") || strings.Contains(transcript, "\x1b") {
		t.Fatalf("管道输出应分行、无密码与控制序列：%q", transcript)
	}
}

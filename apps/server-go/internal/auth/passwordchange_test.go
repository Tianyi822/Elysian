package auth

import (
	"errors"
	"regexp"
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

// 改密测试（passwordChange.test.ts 对等用例）：纯函数的校验/哈希/写盘与错误分型，
// 以及 resetpwd CLI 核心流程（注入 IO fake 与内存 store，不真起交互、不碰 ~/.Elysian）。

// fakeHasher 记录型哈希器：可选包装真实 scrypt（verify 计数）或纯脚本（hash 返回固定串）。
type fakeHasher struct {
	hashFn     func(plain string) (string, error)
	verifyFn   func(plain, stored string) (bool, error)
	hashCalls  int
	verifyArgs []verifyCall
}

type verifyCall struct{ plain, stored string }

func (f *fakeHasher) Hash(plain string) (string, error) {
	f.hashCalls++
	return f.hashFn(plain)
}

func (f *fakeHasher) Verify(plain, stored string) (bool, error) {
	f.verifyArgs = append(f.verifyArgs, verifyCall{plain, stored})
	return f.verifyFn(plain, stored)
}

func scriptedHasher() *fakeHasher {
	return &fakeHasher{
		hashFn:   func(plain string) (string, error) { return "hash:" + plain, nil },
		verifyFn: func(string, string) (bool, error) { return false, nil },
	}
}

func TestChangePanelPasswordMismatch(t *testing.T) {
	hasher := scriptedHasher()
	credentials := NewMemoryCredentialsStore(nil)
	_, err := ChangePanelPassword(credentials, hasher, "abcdefg1", "abcdefg2")
	if err == nil || err.Error() != "两次输入的密码不一致" {
		t.Fatalf("err = %v，期望「两次输入的密码不一致」", err)
	}
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) {
		t.Errorf("错误分型应为 InvalidRequestError，得 %T", err)
	}
	if hasher.hashCalls != 0 {
		t.Errorf("校验失败不应触发哈希（hashCalls=%d）", hasher.hashCalls)
	}
	current, _ := credentials.Current()
	if current != nil {
		t.Error("校验失败不应写盘")
	}
}

func TestChangePanelPasswordTooShort(t *testing.T) {
	hasher := scriptedHasher()
	_, err := ChangePanelPassword(NewMemoryCredentialsStore(nil), hasher, "1234567", "1234567")
	if err == nil || err.Error() != "密码至少需要 8 位" {
		t.Fatalf("err = %v，期望「密码至少需要 8 位」", err)
	}
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) {
		t.Errorf("错误分型应为 InvalidRequestError，得 %T", err)
	}
}

// failingCredentialsStore 写盘恒失败的凭据 store（IO 故障分型用）。
type failingCredentialsStore struct{ written []string }

func (s *failingCredentialsStore) Current() (*PanelCredentials, error) { return nil, nil }

func (s *failingCredentialsStore) Write(passwordHash string) (*PanelCredentials, error) {
	s.written = append(s.written, passwordHash)
	return nil, errors.New("EACCES: permission denied, open")
}

func TestChangePanelPasswordWriteIOErrorPassesThrough(t *testing.T) {
	hasher := scriptedHasher()
	hasher.hashFn = func(string) (string, error) { return "hash:x", nil }
	credentials := &failingCredentialsStore{}
	_, err := ChangePanelPassword(credentials, hasher, "long-enough-pwd", "long-enough-pwd")
	if err == nil || !strings.Contains(err.Error(), "EACCES") {
		t.Fatalf("err = %v，期望含 EACCES 的原文", err)
	}
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
		t.Error("IO 故障不应被包装成 InvalidRequestError")
	}
}

func TestChangePanelPasswordSuccess(t *testing.T) {
	credentials := NewMemoryCredentialsStore(nil)
	written, err := ChangePanelPassword(credentials, NewScryptHasher(), "new-password-1", "new-password-1")
	if err != nil {
		t.Fatalf("ChangePanelPassword 失败：%v", err)
	}
	if written.Username != "admin" {
		t.Errorf("written.Username = %q", written.Username)
	}
	if !regexp.MustCompile(`^scrypt:`).MatchString(written.PasswordHash) {
		t.Errorf("written.PasswordHash = %q，期望 scrypt 串", written.PasswordHash)
	}
	ok, err := NewScryptHasher().Verify("new-password-1", written.PasswordHash)
	if err != nil || !ok {
		t.Errorf("新密码可 verify = (%v, %v)", ok, err)
	}
	current, _ := credentials.Current()
	if current == nil || *current != *written {
		t.Errorf("store 里的凭据与返回值一致，得 %v", current)
	}
}

func TestChangePanelPasswordWriteShape(t *testing.T) {
	var writtenHashes []string
	credentials := &recordingCredentialsStore{inner: NewMemoryCredentialsStore(nil), onWrite: func(hash string) { writtenHashes = append(writtenHashes, hash) }}
	if _, err := ChangePanelPassword(credentials, NewScryptHasher(), "whatever-long", "whatever-long"); err != nil {
		t.Fatalf("ChangePanelPassword 失败：%v", err)
	}
	if len(writtenHashes) != 1 {
		t.Fatalf("恰好一次 write，得 %d", len(writtenHashes))
	}
	if !regexp.MustCompile(`^scrypt:`).MatchString(writtenHashes[0]) {
		t.Errorf("write 收到的是哈希串，得 %q", writtenHashes[0])
	}
}

// recordingCredentialsStore 记录型凭据 store：包住内存版，记录每次 Write 收到的哈希。
type recordingCredentialsStore struct {
	inner     CredentialsStore
	onWrite   func(hash string)
	writes    int
	lastWrite string
}

func (s *recordingCredentialsStore) Current() (*PanelCredentials, error) { return s.inner.Current() }

func (s *recordingCredentialsStore) Write(hash string) (*PanelCredentials, error) {
	s.writes++
	s.lastWrite = hash
	if s.onWrite != nil {
		s.onWrite(hash)
	}
	return s.inner.Write(hash)
}

// scriptedIO 按脚本顺序吐密码输入，记录提示与打印。
type scriptedIO struct {
	tty     bool
	queue   []string
	prompts []string
	printed []string
}

func (io_ *scriptedIO) reset(passwords ...string) {
	io_.queue = append([]string(nil), passwords...)
}

func makeScriptedIO(tty bool) *scriptedIO { return &scriptedIO{tty: tty} }

func (io_ *scriptedIO) asResetPasswordIO() resetPasswordIO {
	return resetPasswordIO{
		isTTY: func() bool { return io_.tty },
		readHidden: func(prompt string) (string, error) {
			io_.prompts = append(io_.prompts, prompt)
			if len(io_.queue) == 0 {
				return "", errPasswordInputEnded
			}
			next := io_.queue[0]
			io_.queue = io_.queue[1:]
			return next, nil
		},
		readLine: func(prompt string) (string, error) {
			io_.prompts = append(io_.prompts, prompt)
			if len(io_.queue) == 0 {
				return "", errPasswordInputEnded
			}
			next := io_.queue[0]
			io_.queue = io_.queue[1:]
			return next, nil
		},
		print: func(text string) { io_.printed = append(io_.printed, text) },
	}
}

func TestRunResetPasswordCliTTYFlow(t *testing.T) {
	io_ := makeScriptedIO(true)
	io_.reset("new-password-1", "new-password-1")
	credentials := NewMemoryCredentialsStore(nil)
	if err := runResetPasswordCli(io_.asResetPasswordIO(), credentials, NewScryptHasher(), false); err != nil {
		t.Fatalf("CLI 失败：%v", err)
	}
	if len(io_.prompts) != 2 || io_.prompts[0] != "新密码：" || io_.prompts[1] != "确认密码：" {
		t.Errorf("提示文案：%v", io_.prompts)
	}
	output := strings.Join(io_.printed, "\n")
	if !strings.Contains(output, "Elysian | 重置密码") || !strings.Contains(output, "输入不回显") || !strings.Contains(output, "✓ 密码已重置\n全部现有登录会话已失效。\n请使用新密码重新登录。") || strings.Contains(output, "开发固定账号") {
		t.Errorf("标题、要求与成功结果应分行展示：%s", output)
	}
	current, _ := credentials.Current()
	if current == nil || current.Username != "admin" {
		t.Errorf("凭据已落盘：%v", current)
	}
}

func TestRunResetPasswordCliNonTTYFlow(t *testing.T) {
	io_ := makeScriptedIO(false)
	io_.reset("new-password-1", "new-password-1")
	if err := runResetPasswordCli(io_.asResetPasswordIO(), NewMemoryCredentialsStore(nil), NewScryptHasher(), false); err != nil {
		t.Fatalf("CLI 失败：%v", err)
	}
	output := strings.Join(io_.printed, "\n")
	if !strings.Contains(output, "非交互输入") || strings.Contains(output, "输入不回显") || strings.Contains(output, "Ctrl+C") {
		t.Errorf("非 TTY 应展示管道输入说明：%v", io_.printed)
	}
	found := false
	for _, line := range io_.printed {
		if line == "✓ 密码已重置" {
			found = true
		}
	}
	if !found {
		t.Errorf("成功文案缺失：%v", io_.printed)
	}
}

func TestRunResetPasswordCliMismatchThrows(t *testing.T) {
	io_ := makeScriptedIO(false)
	io_.reset("new-password-1", "different-pwd")
	err := runResetPasswordCli(io_.asResetPasswordIO(), NewMemoryCredentialsStore(nil), NewScryptHasher(), false)
	if err == nil || err.Error() != "两次输入的密码不一致" {
		t.Fatalf("err = %v，期望「两次输入的密码不一致」", err)
	}
	if strings.Contains(strings.Join(io_.printed, "\n"), "✓") {
		t.Errorf("失败不打印成功文案：%v", io_.printed)
	}
}

func TestRunResetPasswordCliTooShortThrows(t *testing.T) {
	io_ := makeScriptedIO(false)
	io_.reset("short", "short")
	err := runResetPasswordCli(io_.asResetPasswordIO(), NewMemoryCredentialsStore(nil), NewScryptHasher(), false)
	if err == nil || err.Error() != "密码至少需要 8 位" {
		t.Fatalf("err = %v，期望「密码至少需要 8 位」", err)
	}
}

func TestRunResetPasswordCliTTYRetriesValidationWithoutWriting(t *testing.T) {
	io_ := makeScriptedIO(true)
	io_.reset("short", "new-password-1", "different-password", "new-password-2", "new-password-2")
	credentials := &recordingCredentialsStore{inner: NewMemoryCredentialsStore(nil)}
	hasher := scriptedHasher()
	if err := runResetPasswordCli(io_.asResetPasswordIO(), credentials, hasher, false); err != nil {
		t.Fatal(err)
	}
	output := strings.Join(io_.printed, "\n")
	if !strings.Contains(output, "! 密码至少需要 8 位") || !strings.Contains(output, "! 两次输入的密码不一致") || !strings.Contains(output, "✓ 密码已重置") {
		t.Fatalf("重试过程缺少结果提示：%s", output)
	}
	if strings.Join(io_.prompts, ",") != "新密码：,新密码：,确认密码：,新密码：,确认密码：" {
		t.Errorf("过短密码不应再要求确认：%v", io_.prompts)
	}
	if hasher.hashCalls != 1 || credentials.writes != 1 || credentials.lastWrite != "hash:new-password-2" {
		t.Errorf("仅最终有效密码允许写入：hashCalls=%d store=%+v", hasher.hashCalls, credentials)
	}
}

func TestRunResetPasswordCliTTYWriteFailureDoesNotRetry(t *testing.T) {
	io_ := makeScriptedIO(true)
	io_.reset("new-password-1", "new-password-1")
	credentials := &failingCredentialsStore{}
	err := runResetPasswordCli(io_.asResetPasswordIO(), credentials, scriptedHasher(), false)
	if err == nil || !strings.Contains(err.Error(), "EACCES") || len(io_.prompts) != 2 || len(credentials.written) != 1 {
		t.Fatalf("存储失败应直接上抛，不继续消费密码：err=%v prompts=%v", err, io_.prompts)
	}
	if strings.Contains(strings.Join(io_.printed, "\n"), "✓") {
		t.Fatal("存储失败不能显示成功")
	}
}

func TestRunResetPasswordCliDevLine(t *testing.T) {
	io_ := makeScriptedIO(true)
	io_.reset("new-password-1", "new-password-1")
	if err := runResetPasswordCli(io_.asResetPasswordIO(), NewMemoryCredentialsStore(nil), NewScryptHasher(), true); err != nil {
		t.Fatalf("CLI 失败：%v", err)
	}
	found := false
	for _, line := range io_.printed {
		if line == "开发固定账号不受影响（仅开发环境可用）。" {
			found = true
		}
	}
	if !found {
		t.Errorf("dev 开时应追加说明行：%v", io_.printed)
	}
}

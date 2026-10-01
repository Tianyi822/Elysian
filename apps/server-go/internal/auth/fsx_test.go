package auth

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// 诊断归因（shared/errorReason.ts 等价物）的小单测：优先 errno code、其次 message、
// 都拿不到回「未知错误」；wrapErrno 把系统 errno 包上符号名（EACCES 等）。

func TestErrorReasonPrefersCode(t *testing.T) {
	err := &codedError{code: "EACCES", message: "模拟读取故障"}
	if got := errorReason(err); got != "EACCES" {
		t.Errorf("errorReason = %q，期望 EACCES", got)
	}
}

func TestErrorReasonFallsBackToMessage(t *testing.T) {
	err := errors.New("模拟 IO 故障")
	if got := errorReason(err); got != "模拟 IO 故障" {
		t.Errorf("errorReason = %q", got)
	}
}

func TestErrorReasonNil(t *testing.T) {
	if got := errorReason(nil); got != "未知错误" {
		t.Errorf("errorReason(nil) = %q，期望 未知错误", got)
	}
}

func TestWrapErrnoNamesPathError(t *testing.T) {
	pathErr := &os.PathError{Op: "open", Path: "/tmp/x", Err: syscall.EACCES}
	if got := errorReason(wrapErrno(pathErr)); got != "EACCES" {
		t.Errorf("errorReason = %q，期望 EACCES", got)
	}
	loopErr := &os.PathError{Op: "open", Path: "/tmp/x", Err: syscall.ELOOP}
	if got := errorReason(wrapErrno(loopErr)); got != "ELOOP" {
		t.Errorf("errorReason = %q，期望 ELOOP", got)
	}
	// 非系统 errno 的包装错误回落 message。
	plain := &os.PathError{Op: "open", Path: "/tmp/x", Err: errors.New("自定义失败")}
	if got := errorReason(wrapErrno(plain)); got != plain.Error() {
		t.Errorf("errorReason = %q，期望原文 %q", got, plain.Error())
	}
}

func TestUtf16Length(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"admin", 5},
		{"密码密码", 4}, // BMP 内汉字各计 1
		{"😀", 2},    // 增补平面字符计 2（JS .length 同口径）
	}
	for _, tc := range cases {
		if got := utf16Length(tc.in); got != tc.want {
			t.Errorf("utf16Length(%q) = %d，期望 %d", tc.in, got, tc.want)
		}
	}
}

func TestWriteFileAtomicTempCleanupOnRenameFailure(t *testing.T) {
	// rename 失败场景：目标路径被一个已存在的非空目录占据（rename 文件→目录恒失败），
	// 临时文件应被清理且错误上抛。
	dir := tempDir(t)
	target := filepath.Join(dir, "occupied")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	err := writeFileAtomic(target, []byte("{}"))
	if err == nil {
		t.Fatal("rename 到目录应失败")
	}
	leftovers, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatalf("读目录失败：%v", readErr)
	}
	if len(leftovers) != 1 || leftovers[0].Name() != "occupied" {
		names := make([]string, 0, len(leftovers))
		for _, entry := range leftovers {
			names = append(names, entry.Name())
		}
		t.Errorf("失败后临时文件应被清理，目录内容：%v", names)
	}
}

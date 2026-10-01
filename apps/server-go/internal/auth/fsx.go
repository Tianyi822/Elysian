package auth

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// 面板数据文件的读写纪律（auth 域私有公共件，credentialsStore/sessionStore 共用）：
// O_NOFOLLOW 读 + 权限/属主/大小校验、0700 目录、0600 临时文件（uuid 后缀）+ fsync +
// rename 原子写。凭据与会话文件都是「打开符号链接即拒绝」，防白名单/凭据指到任意文件。

// credentialsMaxBytes 凭据文件体积上限：64 KiB。
const credentialsMaxBytes = 64 * 1024

// sessionsMaxBytes 会话文件体积上限：1 MiB。
const sessionsMaxBytes = 1024 * 1024

// openNoFollow 以 O_RDONLY|O_NOFOLLOW 打开：最终组件是符号链接时得 ELOOP。
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// isNoFollowMiss 判定打开失败是否属于 fail-closed 集合：文件不存在（ENOENT）与
// 最终组件是符号链接（ELOOP）都按「不可用」处理；其余 errno 原样上抛。
func isNoFollowMiss(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ELOOP)
}

// statTrusted 对已打开文件的 fstat 做信任校验：普通文件、体积不超限、group/other
// 无任何权限（权限被放宽即不可用）、属主是当前进程 uid。任一不过即 false。
func statTrusted(fi os.FileInfo, maxBytes int64) bool {
	if !fi.Mode().IsRegular() || fi.Size() > maxBytes {
		return false
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return false
	}
	stat, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return stat.Uid == uint32(os.Getuid())
}

// writeFileAtomic 原子写：mkdir（recursive、0700）→ 写 `<path>.<uuid>.tmp`（独占、0600）
// → fsync → rename 原子替换；rename 失败清理临时文件并返回错误。
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + "." + randomUUID() + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// randomUUID 生成 UUIDv4 形随机串（临时文件后缀用；唯一性足够，非安全边界）。
func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败属进程级故障：panic 优于写出可预测的临时文件名。
		panic(fmt.Sprintf("系统随机源不可用：%v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// isoNowMillis 当前时刻的毫秒精度 ISO 串（与 JS new Date().toISOString() 同形，恒 UTC、
// 恒三位毫秒）：passwordChangedAt 即会话失效 epoch 基准。同毫秒内两次改密产生相同
// epoch、会话不失效——TS 现状即如此，不「修复」成单调序列。
func isoNowMillis() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// formatISOMillis 把 epoch 毫秒格式化为 ISO 串。
func formatISOMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// utf16Length 计算字符串的 UTF-16 code unit 数（与 JS string.length 同口径：BMP 外
// 字符计 2）。登录字段上限、密码最小长度与回跳长度上限都用它对齐 TS 的 .length 语义。
func utf16Length(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// codeCarrier 带 errno code 的错误（TS ErrnoException.code 的等价物）：诊断归因优先取它。
type codeCarrier interface {
	ErrorCode() string
}

// codedError 测试与域内可构造的带 code 错误。
type codedError struct {
	code    string
	message string
}

// ErrorCode 实现 codeCarrier。
func (e *codedError) ErrorCode() string { return e.code }

// Error 实现 error：只回 message（code 经 ErrorCode 单独取）。
func (e *codedError) Error() string { return e.message }

// errnoError 把系统 errno 包装成带 code 的错误。
type errnoError struct {
	err  error
	code string
}

// ErrorCode 实现 codeCarrier。
func (e *errnoError) ErrorCode() string { return e.code }

// Error 实现 error。
func (e *errnoError) Error() string { return e.err.Error() }

// wrapErrno 若错误是系统 errno 则包上符号名（EACCES 等），供 errorReason 归因。
func wrapErrno(err error) error {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := errnoSymbol(errno); name != "" {
			return &errnoError{err: err, code: name}
		}
	}
	return err
}

// errnoSymbol 常见 errno 的符号名（TS errorReason 的 code 字段口径）；未列出的回空。
func errnoSymbol(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.EIO:
		return "EIO"
	case syscall.EMFILE:
		return "EMFILE"
	case syscall.ENFILE:
		return "ENFILE"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EEXIST:
		return "EEXIST"
	default:
		return ""
	}
}

// errorReason 从任意错误安全提取诊断归因（shared/errorReason.ts 等价物）：优先 errno
// code，其次非空 message，都拿不到回「未知错误」。
func errorReason(err error) string {
	if err == nil {
		return "未知错误"
	}
	if carrier, ok := err.(codeCarrier); ok {
		if code := carrier.ErrorCode(); code != "" {
			return code
		}
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		if wrapped := wrapErrno(pathErr.Err); wrapped != pathErr.Err {
			return errorReason(wrapped)
		}
	}
	message := err.Error()
	if message != "" {
		return message
	}
	return "未知错误"
}

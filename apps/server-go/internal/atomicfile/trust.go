package atomicfile

import (
	"errors"
	"os"
	"syscall"
)

var ErrUntrusted = errors.New("文件属性不符合信任要求")

// TrustOptions 由调用方指定最终文件的读取约束；MaxBytes 为零时只允许空文件。
type TrustOptions struct {
	MaxBytes   int64
	RejectPerm os.FileMode
	OwnerUID   *uint32 // nil 表示不核验属主。
	SingleLink bool
}

// OpenNoFollow 只读打开文件，拒绝路径最后一个组件为符号链接。
func OpenNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// OpenTrusted 无跟随打开并在同一句柄上核验属性，成功时由调用方关闭文件。
func OpenTrusted(path string, opts TrustOptions) (*os.File, error) {
	file, err := OpenNoFollow(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err == nil && !StatTrusted(info, opts) {
		err = ErrUntrusted
	}
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

// StatTrusted 核验普通文件的体积、权限和显式指定的身份要求。
func StatTrusted(info os.FileInfo, opts TrustOptions) bool {
	if !info.Mode().IsRegular() || info.Size() > opts.MaxBytes || info.Mode().Perm()&opts.RejectPerm != 0 {
		return false
	}
	if opts.OwnerUID == nil && !opts.SingleLink {
		return true
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && (opts.OwnerUID == nil || stat.Uid == *opts.OwnerUID) && (!opts.SingleLink || stat.Nlink == 1)
}

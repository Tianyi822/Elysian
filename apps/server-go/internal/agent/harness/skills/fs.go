package skills

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

func randomID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("无法分配技能对象编号")
	}
	return prefix + hex.EncodeToString(b[:])
}
func storageError() error { return problem(503, "skill-storage", "技能存储不可用") }
func cleanRelative(value string) (string, error) {
	if value == "" || value == "." || !utf8.ValidString(value) || len(value) > 1024 || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return "", problem(400, "invalid-path", "技能文件路径无效")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." || part == "" {
			return "", problem(400, "invalid-path", "技能文件路径无效")
		}
	}
	return value, nil
}

// openDirectory 逐级拒绝符号链接；不依赖先检查再打开的路径判定。
func openDirectory(name string, create bool) (*os.File, error) {
	if !filepath.IsAbs(name) {
		return nil, problem(400, "invalid-path", "技能存储必须使用绝对路径")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, storageError()
	}
	for _, part := range strings.Split(filepath.Clean(name), string(os.PathSeparator)) {
		if part == "" {
			continue
		}
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(e, unix.ENOENT) && create {
			if e = unix.Mkdirat(fd, part, 0700); e == nil || errors.Is(e, unix.EEXIST) {
				next, e = unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if e != nil {
			return nil, problem(400, "unsafe-path", "技能目录不可访问或包含符号链接")
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), name), nil
}
func openRegular(name string) (*os.File, error) {
	parent, err := openDirectory(filepath.Dir(name), false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	fd, err := unix.Openat(int(parent.Fd()), filepath.Base(name), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, problem(400, "unsafe-file", "技能包仅允许普通文件，不允许链接或设备")
	}
	return f, nil
}
func createRegular(name string) (*os.File, error) {
	dir, err := openDirectory(filepath.Dir(name), true)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	fd, err := unix.Openat(int(dir.Fd()), filepath.Base(name), unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, storageError()
	}
	return os.NewFile(uintptr(fd), name), nil
}
func writeDocument(name string, doc document) (bool, error) {
	raw, err := json.Marshal(doc)
	if err != nil || len(raw) > 16<<20 {
		return false, problem(409, "skill-config-limit", "技能登记容量达到上限")
	}
	dir, err := openDirectory(filepath.Dir(name), true)
	if err != nil {
		return false, err
	}
	defer dir.Close()
	tmp := randomID(".skill-")
	fd, err := unix.Openat(int(dir.Fd()), tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return false, storageError()
	}
	f := os.NewFile(uintptr(fd), tmp)
	defer unix.Unlinkat(int(dir.Fd()), tmp, 0)
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return false, storageError()
	}
	if err = unix.Renameat(int(dir.Fd()), tmp, int(dir.Fd()), filepath.Base(name)); err != nil {
		return false, storageError()
	}
	if err = dir.Sync(); err != nil {
		return true, problem(503, "skill-storage-uncertain", "技能配置写入后的同步未确认，请重新读取状态")
	}
	return true, nil
}
func readBounded(name string, limit int64) ([]byte, error) {
	f, err := openRegular(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, storageError()
	}
	if int64(len(b)) > limit {
		return nil, problem(413, "skill-size-limit", "技能文件超过读取限额")
	}
	return b, nil
}

package execution

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Docker resolves host paths after the API request. Trusted ancestors prevent
// an unprivileged writer from replacing the approved mount root in that gap.
func validateGrantDirectory(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("授权目录路径无效")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() { unix.Close(fd) }()
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for _, part := range parts {
		var stat unix.Stat_t
		if err = unix.Fstat(fd, &stat); err != nil {
			return err
		}
		if stat.Uid != 0 || stat.Mode&0022 != 0 {
			return errors.New("授权目录的所有祖先必须由 root 持有且不可被组或其他用户写入")
		}
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if e != nil {
			return e
		}
		unix.Close(fd)
		fd = next
	}
	count := 0
	return scanGrantDirectory(fd, 0, &count)
}

func grantSecretName(name string) bool {
	n := strings.ToLower(name)
	if strings.HasPrefix(n, ".env") || strings.HasPrefix(n, ".elysian-") {
		return true
	}
	for _, blocked := range []string{".ssh", ".aws", ".azure", ".config", ".docker", ".elysian", ".git", "credentials", "secrets", "node_modules"} {
		if n == blocked {
			return true
		}
	}
	for _, suffix := range []string{".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx"} {
		if strings.HasSuffix(n, suffix) {
			return true
		}
	}
	return strings.Contains(n, "credential") || strings.Contains(n, "private_key") || strings.Contains(n, "secret")
}

func scanGrantDirectory(fd, depth int, count *int) error {
	if depth > 32 {
		return errors.New("授权目录层级超过安全检查上限")
	}
	dup, err := unix.Dup(fd)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(dup), "grant-directory")
	defer dir.Close()
	entries, err := dir.ReadDir(4097 - *count)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, entry := range entries {
		*count++
		if *count > 4096 {
			return errors.New("授权目录条目超过安全检查上限")
		}
		if grantSecretName(entry.Name()) {
			return errors.New("授权目录包含凭据或秘密文件，请使用独立的普通业务目录")
		}
		var before unix.Stat_t
		if err := unix.Fstatat(fd, entry.Name(), &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		kind := before.Mode & unix.S_IFMT
		if kind != unix.S_IFREG && kind != unix.S_IFDIR {
			return errors.New("授权目录包含链接、设备、套接字或其他特殊条目")
		}
		if kind == unix.S_IFREG && before.Nlink != 1 {
			return errors.New("授权目录包含硬链接")
		}
		child, err := unix.Openat(fd, entry.Name(), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return errors.New("授权目录包含链接或无法安全读取的条目")
		}
		var stat unix.Stat_t
		err = unix.Fstat(child, &stat)
		if err == nil && (stat.Dev != before.Dev || stat.Ino != before.Ino || stat.Mode&unix.S_IFMT != kind) {
			err = errors.New("授权目录条目在检查期间变化")
		}
		if err == nil {
			switch stat.Mode & unix.S_IFMT {
			case unix.S_IFDIR:
				err = scanGrantDirectory(child, depth+1, count)
			case unix.S_IFREG:
				if stat.Nlink != 1 {
					err = errors.New("授权目录包含硬链接")
				}
			default:
				err = errors.New("授权目录包含设备、套接字或其他特殊条目")
			}
		}
		unix.Close(child)
		if err != nil {
			return err
		}
	}
	return nil
}

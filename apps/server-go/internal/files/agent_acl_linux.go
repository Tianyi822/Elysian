//go:build linux

package files

import (
	"errors"

	"golang.org/x/sys/unix"
)

func agentRequireNoACL(fd int) error {
	size, err := unix.Fgetxattr(fd, "system.posix_acl_access", nil)
	if errors.Is(err, unix.ENODATA) || errors.Is(err, unix.ENOTSUP) {
		return nil
	}
	if err != nil || size > 0 {
		return errors.New("文件含扩展 ACL 或无法核验权限，禁止替换以免改变访问权限")
	}
	return nil
}

//go:build !linux

package workspace

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// macOS/BSD do not expose renameat2. All callers hold the workspace lock, so
// an existence check followed by renameat preserves no-replace semantics for
// cooperating workspace stores during local development and tests.
func renameNoReplace(root *os.File, oldName, newName string) error {
	var info unix.Stat_t
	if err := unix.Fstatat(int(root.Fd()), newName, &info, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		return unix.EEXIST
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	return unix.Renameat(int(root.Fd()), oldName, int(root.Fd()), newName)
}

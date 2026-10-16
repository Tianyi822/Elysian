//go:build linux

package workspace

import (
	"os"

	"golang.org/x/sys/unix"
)

func renameNoReplace(root *os.File, oldName, newName string) error {
	return unix.Renameat2(int(root.Fd()), oldName, int(root.Fd()), newName, unix.RENAME_NOREPLACE)
}

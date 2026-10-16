//go:build linux

package files

import "golang.org/x/sys/unix"

func agentRenameNoReplace(source int, name string, target int, targetName string) error {
	return unix.Renameat2(source, name, target, targetName, unix.RENAME_NOREPLACE)
}

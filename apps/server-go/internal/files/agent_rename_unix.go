//go:build !linux

package files

import "errors"

func agentRenameNoReplace(int, string, int, string) error {
	return errors.New("此平台未提供安全的原子移动")
}

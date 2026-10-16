//go:build !linux

package files

import "errors"

func agentRequireNoACL(int) error {
	return errors.New("当前平台无法安全核验扩展 ACL，禁止替换已有文件")
}

package security

// seam.SystemAccounts 实现（files 域消费的 getent 通道）：等价 `getent passwd`，
// NSS 源（勿改读 /etc/passwd）；`getent passwd <name>` 退出码 2（查无结果）归一为
// (nil, nil)。

import (
	"context"

	"elysian/server/internal/seam"
)

// systemAccounts getent passwd 通道；exec 注入命令执行（ctx 取消即中止）。
type systemAccounts struct {
	exec func(ctx context.Context, name string, args []string) (string, string, error)
}

// NewSystemAccounts 产出 files 域消费的 getent 通道。
func NewSystemAccounts() seam.SystemAccounts {
	return &systemAccounts{exec: execContextOutput}
}

// PasswdAll 等价 `getent passwd`（NSS 源）；仅执行失败返回 error。
func (s *systemAccounts) PasswdAll(ctx context.Context) ([]seam.PasswdRecord, error) {
	output, err := s.getent(ctx, "passwd")
	if err != nil {
		return nil, err
	}
	records := ParseGetentPasswd(output)
	if records == nil {
		records = []seam.PasswdRecord{}
	}
	return records, nil
}

// PasswdByName 等价 `getent passwd <name>`；退出码 2（查无结果）归一为 (nil, nil)。
func (s *systemAccounts) PasswdByName(ctx context.Context, name string) (*seam.PasswdRecord, error) {
	output, err := s.getent(ctx, "passwd", name)
	if err != nil {
		return nil, err
	}
	records := ParseGetentPasswd(output)
	if len(records) == 0 {
		return nil, nil
	}
	return &records[0], nil
}

// getent 经注入的执行函数跑一次 getent（退出码语义归一在 runGetentViaExecFile）。
func (s *systemAccounts) getent(ctx context.Context, args ...string) (string, error) {
	exec := s.exec
	if exec == nil {
		exec = execContextOutput
	}
	return runGetentViaExecFile(func(name string, argv []string) (string, string, error) {
		return exec(ctx, name, argv)
	}, args)
}

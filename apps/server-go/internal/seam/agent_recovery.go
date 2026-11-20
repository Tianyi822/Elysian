package seam

import "context"

// AgentExecutionRecovery 让启动和离线维护核对配置与回收结果，不读取执行配置的内部格式。
type AgentExecutionRecovery interface {
	ConfigRequiresRecovery(root string) (bool, error)
	RecoverManagedContainers(ctx context.Context, socket, binary string) error
}

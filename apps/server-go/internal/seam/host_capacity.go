package seam

import (
	"context"

	"elysian/server/internal/shared"
)

// HostCapacity 读取宿主内存容量（platform 域实现；docker 与 database 域在创建容器前
// 消费）。纯读，不消耗 Agent 派发票据，不写任何系统状态。
type HostCapacity interface {
	Sample(ctx context.Context) (shared.HostMemory, error)
}

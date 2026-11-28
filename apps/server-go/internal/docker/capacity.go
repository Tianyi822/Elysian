package docker

import (
	"context"

	"elysian/server/internal/shared"
)

// 创建容器前的宿主容量核对：读数经 seam.HostCapacity 取得，判定口径、报告与拒绝文案都在
// shared（database 域创建实例前用同一套）。读数不可得一律不放行；所有拒绝都发生在任何
// 变更之前。

type (
	HostCapacityTier   = shared.HostCapacityTier
	HostCapacityReport = shared.HostCapacityReport
)

// HostCapacity 读取宿主容量并逐一判定各档位能否容纳。
func (a *AgentFacade) HostCapacity(ctx context.Context) (HostCapacityReport, error) {
	if err := a.check(ctx); err != nil {
		return HostCapacityReport{}, err
	}
	memory, reason, err := a.sampleHostMemory(ctx)
	if err != nil {
		return HostCapacityReport{}, err
	}
	return shared.BuildHostCapacityReport(memory, reason), nil
}

// sampleHostMemory 采样宿主内存。读数不可得时返回原因而不报错，调用方据此拒绝创建；
// 只有上下文结束才返回错误。
func (a *AgentFacade) sampleHostMemory(ctx context.Context) (shared.HostMemory, string, error) {
	if a.hostCapacity == nil {
		return shared.HostMemory{}, shared.HostCapacityUnavailable, nil
	}
	memory, err := a.hostCapacity.Sample(ctx)
	if ctx.Err() != nil {
		return shared.HostMemory{}, "", ctx.Err()
	}
	if err != nil {
		return shared.HostMemory{}, shared.HostCapacityUnreadable, nil
	}
	return memory, shared.HostMemoryReason(memory), nil
}

// requireCapacity 是创建前的强制核对：读数不可得或放不下都拒绝；need 描述被拒的对象
// （如「 large 档」），拒绝文案带回读数与当前可容纳的档位。
func (a *AgentFacade) requireCapacity(ctx context.Context, need string, requiredBytes int64) error {
	memory, reason, err := a.sampleHostMemory(ctx)
	if err != nil {
		return err
	}
	if message := shared.CapacityRejection(memory, reason, need, requiredBytes); message != "" {
		return shared.InvalidRequest(message)
	}
	return nil
}

package websites

import (
	"context"
	"errors"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// websiteContainerBridge 让 docker 域的容器生命周期工具按登记核验后路由到网站服务：
// 登记反查、单登记校验与 inProgress 互斥的数据权威留在本包，docker 侧不感知网站登记。
type websiteContainerBridge struct {
	facade *AgentFacade
	verify func(context.Context) error
}

// WebsiteContainerBridge 共享网站页的服务与互斥；verify 复用调用方同一张派发票据。
func (f *AgentFacade) WebsiteContainerBridge(verify func(context.Context) error) seam.AgentWebsiteContainers {
	return &websiteContainerBridge{facade: f, verify: verify}
}

func (b *websiteContainerBridge) check(ctx context.Context) error {
	if b.facade == nil || b.facade.service == nil || b.verify == nil {
		return errors.New("网站登记能力不可用")
	}
	return b.verify(ctx)
}

// rows 按容器 ID 反查网站登记。
func (b *websiteContainerBridge) rows(ctx context.Context, id string) ([]WebsiteRecord, error) {
	rows, err := b.facade.service.deps.registry.List(ctx)
	if err != nil {
		return nil, err
	}
	result := []WebsiteRecord{}
	for _, row := range rows {
		if row.ContainerID != nil && *row.ContainerID == id {
			result = append(result, row)
		}
	}
	return result, nil
}

// Lifecycle 只承接 start/stop/restart；remove 保持 website_remove 专属入口，不在此路由。
func (b *websiteContainerBridge) Lifecycle(ctx context.Context, id, action string) (bool, error) {
	if action != "start" && action != "stop" && action != "restart" {
		return false, nil
	}
	if err := b.check(ctx); err != nil {
		return false, err
	}
	rows, err := b.rows(ctx, id)
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	if len(rows) != 1 {
		return true, websiteBridgeFailure(shared.InvalidRequest("容器被多个网站登记引用，不能执行容器级操作"), true)
	}
	_, dispatched, err := b.facade.service.containerLifecycle(ctx, rows[0].ID, id, action)
	return true, websiteBridgeFailure(err, !dispatched)
}

func websiteBridgeFailure(err error, notDispatched bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	invalid, knownRejection := err.(*shared.InvalidRequestError)
	if notDispatched && !knownRejection {
		return err
	}
	message := "网站容器操作失败，请回读实际状态，不能自动重试"
	if knownRejection {
		message = invalid.Message
	}
	if notDispatched {
		message += "，网站变更未执行"
	}
	return &seam.AgentContainerError{Code: "website-container-operation-failed", Message: message, NotDispatched: notDispatched}
}

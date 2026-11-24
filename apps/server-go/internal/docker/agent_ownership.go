package docker

import (
	"context"

	"elysian/server/internal/shared"
)

func (a *AgentFacade) checkDomainExecOrUpdate(ctx context.Context, id string, exec bool) error {
	// An authorized submission checks registration. A queued worker rechecks
	// the exact Engine identity and immutable ownership labels before dispatch.
	if a.databaseContainers != nil {
		registered, err := a.databaseContainers.Registered(ctx, id)
		if err != nil {
			return err
		}
		if registered {
			if exec {
				return shared.InvalidRequest("受管数据库容器不支持执行任意命令")
			}
			return shared.InvalidRequest("数据库容器配置须通过所属领域处理")
		}
	}
	if a.websiteContainers != nil {
		registered, err := a.websiteContainers.Registered(ctx, id)
		if err != nil {
			return err
		}
		if registered {
			return shared.InvalidRequest("网站容器的配置与命令须通过所属领域处理")
		}
	}
	return nil
}

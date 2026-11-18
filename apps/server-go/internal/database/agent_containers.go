package database

import (
	"context"
	"errors"
	"sort"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type containerBridge struct {
	facade *AgentFacade
	verify func(context.Context) error
}

// ContainerBridge shares the page's service and registration mutex. The caller
// consumes its dispatch ticket once; verify checks that same authorization.
func (f *AgentFacade) ContainerBridge(verify func(context.Context) error) seam.AgentDatabaseContainers {
	return &containerBridge{facade: f, verify: verify}
}

type containerOperationRequestKey struct{}

func (s *databaseService) checkContainerMutation(ctx context.Context, id, name string) error {
	if s.operationGuard == nil {
		return nil
	}
	requestID, _ := ctx.Value(containerOperationRequestKey{}).(string)
	return s.operationGuard(ctx, id, name, requestID)
}

func (b *containerBridge) check(ctx context.Context) error {
	if !b.facade.Available() || b.verify == nil {
		return errors.New("数据库登记能力不可用")
	}
	return b.verify(ctx)
}

func (b *containerBridge) rows(id string) ([]databaseRecord, error) {
	rows, err := b.facade.service.deps.registry.list()
	if err != nil {
		return nil, err
	}
	var result []databaseRecord
	for _, row := range rows {
		if row.ContainerID == id {
			result = append(result, row)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

// Registered 供 docker_container_exec 拦截受管数据库容器。
func (b *containerBridge) Registered(ctx context.Context, id string) (bool, error) {
	if err := b.check(ctx); err != nil {
		return false, err
	}
	rows, err := b.rows(id)
	return len(rows) > 0, err
}

// Lifecycle 受管数据库容器的 start/stop/restart 路由与 remove→removeContainer
// 的五元核验；非数据库容器返回 handled=false 交回 docker 域。
func (b *containerBridge) Lifecycle(ctx context.Context, id, action string) (bool, error) {
	if err := b.check(ctx); err != nil {
		return false, err
	}
	s := b.facade.service
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := b.rows(id)
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	if len(rows) != 1 {
		return true, bridgePreflightFailure(shared.InvalidRequest("容器中还有其他已登记数据库，不能执行容器级操作"))
	}
	row := rows[0]
	if err := s.checkContainerMutation(ctx, row.ContainerID, row.ContainerName); err != nil {
		return true, bridgePreflightFailure(err)
	}
	if row.Source != sourceManaged {
		return true, bridgePreflightFailure(shared.InvalidRequest("仅允许操作面板受管数据库容器"))
	}
	if action == "remove" {
		return true, bridgeFailure(s.removeContainer(ctx, row.ContainerID), false)
	}
	docker, ok := s.deps.docker.(*dockerAPI)
	if !ok {
		return true, errors.New("数据库容器控制未接入")
	}
	if action == "restart" {
		if err := docker.agentControl(ctx, row, "stop", s.deps.selfContainerID); err != nil {
			return true, bridgeFailure(err, false)
		}
		action = "start"
	}
	return true, bridgeFailure(docker.agentControl(ctx, row, action, s.deps.selfContainerID), false)
}

func bridgePreflightFailure(err error) error {
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		return &seam.AgentContainerError{Code: "database-container-operation-failed", Message: invalid.Message + "，数据库变更未执行", NotDispatched: true}
	}
	return bridgeFailure(err, false)
}

func bridgeFailure(err error, noBusinessEffect bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	message := "数据库操作失败，请回读实际状态，不能自动重试"
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		message = invalid.Message
	}
	if noBusinessEffect {
		message += "，数据库变更未执行"
	}
	return &seam.AgentContainerError{Code: "database-container-operation-failed", Message: message, NoBusinessEffect: noBusinessEffect}
}

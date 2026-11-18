package docker

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

func agentObjectID(raw string, image bool) (string, error) {
	id := raw
	if image {
		id = strings.TrimPrefix(id, "sha256:")
	}
	if len(id) != 64 {
		return "", shared.InvalidRequest("Docker 详情查询必须使用列表返回的完整对象 ID")
	}
	if _, err := hex.DecodeString(id); err != nil || strings.ToLower(id) != id {
		return "", shared.InvalidRequest("Docker 对象 ID 无效")
	}
	return id, nil
}

// InspectContainer reads one exact local identity after consuming dispatch authorization.
func (a *AgentFacade) InspectContainer(ctx context.Context, raw string) (contract.Container, error) {
	if err := a.check(ctx); err != nil {
		return contract.Container{}, err
	}
	id, err := agentObjectID(raw, false)
	if err != nil {
		return contract.Container{}, err
	}
	value, err := a.service.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	result, err := mapContainer(value)
	if err == nil && result.ID != id {
		return contract.Container{}, errors.New("容器详情与请求 ID 不匹配")
	}
	return result, err
}

// InspectImage reads installed image metadata without exposing raw Engine configuration.
func (a *AgentFacade) InspectImage(ctx context.Context, raw string) (contract.ContainerImage, error) {
	if err := a.check(ctx); err != nil {
		return contract.ContainerImage{}, err
	}
	id, err := agentObjectID(raw, true)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	value, err := a.service.inspectImageByID(ctx, id)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	result, err := mapImage(value, value)
	if err == nil && result.ID != id {
		return contract.ContainerImage{}, errors.New("镜像详情与请求 ID 不匹配")
	}
	return result, err
}

package docker

import (
	"context"
	"errors"
)

// AgentError 仅公开固定文案；不包含 Engine 输出或远程响应。
type AgentError struct {
	Code          string
	Message       string
	NotDispatched bool
}

func (e *AgentError) Error() string { return e.Message }

func agentQueryError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return &AgentError{Code: "docker-registry-query-failed", Message: "镜像源查询不可用；可用 docker_registry_list 选择其他源，已知镜像名可直接查询版本；搜索不可用不表示镜像不存在"}
}

// pullConfirmedFailure 只在未调用拉取或完整 Engine 失败响应后产生。
type pullConfirmedFailure struct{ error }

func confirmedPullError(err error) error {
	if err == nil {
		return nil
	}
	return &pullConfirmedFailure{err}
}

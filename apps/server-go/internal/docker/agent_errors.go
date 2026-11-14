package docker

import (
	"context"
	"errors"
	"net"

	"elysian/server/internal/shared"
)

// AgentError 仅公开固定文案；不包含 Engine 输出或远程响应。
type AgentError struct {
	Retryable     bool
	Code          string
	Message       string
	NotDispatched bool
}

func (e *AgentError) Error() string { return e.Message }

// agentRejected 把输入预检拒绝（未派发任何变更）转成固定文案的未派发业务
// 错误，经工具层交回模型纠正；执行中失败原样通过，不冒充预检。
func agentRejected(err error) error {
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
		return &AgentError{Code: "docker-operation-rejected", Message: invalid.Message, NotDispatched: true}
	}
	return err
}

// agentSubmitRejected 标记异步提交在派发前的确定失败：未受理、无业务变更，供
// harness 走干净失败而非「结果未知」。与 agentRejected 不同，它对任何预派发错误
// 都给出 NotDispatched 类型化拒绝；仅保留契约文案，不透传 Engine 输出或远程响应。
func agentSubmitRejected(err error) error {
	if err == nil {
		return nil
	}
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
		return &AgentError{Code: "docker-operation-rejected", Message: invalid.Message, NotDispatched: true}
	}
	var typed *AgentError
	if errors.As(err, &typed) {
		return &AgentError{Code: typed.Code, Message: typed.Message, NotDispatched: true}
	}
	return &AgentError{Code: "docker-operation-rejected", Message: "容器操作提交预检失败，未派发任何变更；请核实输入与面板状态后重试", NotDispatched: true}
}

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
	var network net.Error
	retryable := errors.As(err, &network)
	return &AgentError{Code: "docker-registry-query-failed", Message: "镜像源查询不可用；可用 docker_registry_list 选择其他源，已知镜像名可直接查询版本；搜索不可用不表示镜像不存在", Retryable: retryable}
}

// pullConfirmedFailure 只在未调用拉取或完整 Engine 失败响应后产生。
type pullConfirmedFailure struct{ error }

func confirmedPullError(err error) error {
	if err == nil {
		return nil
	}
	return &pullConfirmedFailure{err}
}

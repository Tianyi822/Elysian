package database

import (
	"context"
	"errors"

	"elysian/server/internal/shared"
)

// AgentLifecycleRejectedError 仅用于纯本地预检、未派发任何变更；
// 存储、授权与执行中失败不得使用。
type AgentLifecycleRejectedError struct{ Message string }

func (e *AgentLifecycleRejectedError) Error() string { return e.Message }

// AgentLifecycleError 执行中失败：只携带固定公开中文原因，不保留底层错误链。
type AgentLifecycleError struct{ Code, Message string }

func (e *AgentLifecycleError) Error() string { return e.Message }

// lifecycleFailureCode 同步生命周期执行失败的固定错误码。
const lifecycleFailureCode = "database-lifecycle-failed"

// lifecycleFailure 把执行中失败收敛为固定公开中文原因：取消与超时原样返回；
// *shared.InvalidRequestError 的消息是 API 契约（中文，逐字）按类型放行；
// 其余（引擎正文、传输细节）一律兜底，不带 Unwrap。
func lifecycleFailure(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		return &AgentLifecycleError{Code: lifecycleFailureCode, Message: invalid.Message}
	}
	return &AgentLifecycleError{Code: lifecycleFailureCode, Message: "数据库操作失败，请回读实际状态，不能自动重试"}
}

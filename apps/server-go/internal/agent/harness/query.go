package harness

import (
	"context"
	"errors"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

var bad = state.Bad

func storageFailure(err error) error {
	if err == nil {
		return nil
	}
	if commitUnconfirmed(err) {
		return &Error{Status: 503, Code: "storage-commit-unconfirmed", Message: "保存结果尚未确认，已暂停执行；请使用原请求标识核实，不能重复提交操作"}
	}
	if _, ok := err.(*Error); ok {
		return err
	}
	if errors.Is(err, sessionstore.ErrNotFound) {
		return &Error{Status: 404, Code: "not-found", Message: "运行记录不存在"}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Status: 408, Code: "request-cancelled", Message: "请求已取消或超时，可使用原请求标识查询结果"}
	}
	return &Error{Status: 503, Code: "storage-unavailable", Message: "任务存储不可用，无法确认运行状态"}
}

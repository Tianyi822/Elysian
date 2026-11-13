package docker

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// 异步提交在派发前的确定失败必须表达为 NotDispatched 类型化拒绝，供 harness 走
// 干净失败；若返回原始 error，harness 的 Async 分支会误判为「结果未知」并终止运行。
func TestSubmitPreDispatchRejectionIsNotDispatched(t *testing.T) {
	newFacade := func(authorize func(context.Context) error) *AgentFacade {
		return &AgentFacade{
			operationRoot: filepath.Join(t.TempDir(), "tasks"),
			service:       &dockerService{},
			authorize:     authorize,
		}
	}
	input := AgentServiceCreateInput{RequestID: strings.Repeat("a", 64), Name: "mysql", Image: "mysql:8.4"}

	t.Run("授权预检失败", func(t *testing.T) {
		a := newFacade(func(context.Context) error { return errors.New("执行后端缺少有效的单次工具授权") })
		_, err := a.SubmitService(context.Background(), input)
		var rejected *AgentError
		if !errors.As(err, &rejected) || !rejected.NotDispatched {
			t.Fatalf("预派发授权失败应为 NotDispatched 类型化拒绝，得 %v", err)
		}
	})

	t.Run("输入预检失败", func(t *testing.T) {
		a := newFacade(func(context.Context) error { return nil })
		_, err := a.SubmitService(context.Background(), AgentServiceCreateInput{RequestID: strings.Repeat("b", 64), Name: "", Image: "mysql:8.4"})
		var rejected *AgentError
		if !errors.As(err, &rejected) || !rejected.NotDispatched {
			t.Fatalf("预派发输入拒绝应为 NotDispatched 类型化拒绝，得 %v", err)
		}
	})

	t.Run("exec 授权预检失败", func(t *testing.T) {
		a := newFacade(func(context.Context) error { return errors.New("执行后端缺少有效的单次工具授权") })
		_, err := a.SubmitExec(context.Background(), ContainerExecInput{RequestID: strings.Repeat("c", 64), ID: strings.Repeat("d", 64), Argv: []string{"true"}})
		var rejected *AgentError
		if !errors.As(err, &rejected) || !rejected.NotDispatched {
			t.Fatalf("exec 预派发授权失败应为 NotDispatched 类型化拒绝，得 %v", err)
		}
	})
}

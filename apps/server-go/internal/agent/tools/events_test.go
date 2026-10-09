// 三段瀑布的语义测试：pre-execute 只能拒、execute 可包裹、post-execute 可改判，
// 全链失败闭合。
package tools

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
)

// listen 在根 ctx 上登记监听器，测试结束自动退订。
func listen(t *testing.T, root *kardia.Context, name kardia.EventName, listener kardia.Listener) {
	t.Helper()
	unsubscribe, err := root.On(name, listener)
	if err != nil {
		t.Fatalf("登记 %s 监听器失败：%v", name, err)
	}
	t.Cleanup(func() { unsubscribe() })
}

func TestPreExecuteDenyBlocksHandler(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	called := false
	if _, err := registry.Register(Descriptor{
		Name:        "guarded_tool",
		Description: "受策略保护",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(*kardia.Context, Arguments) (any, error) {
			called = true
			return "不该到这里", nil
		},
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}

	var seenOutcome Outcome
	var seenCall Call
	listen(t, root, EventPreExecute, func(ev *kardia.EventCtx) (any, error) {
		call, _ := ev.Args[0].(Call)
		seenCall = call
		return &Deny{Reason: "该动作需要人工审批"}, nil
	})
	listen(t, root, EventResult, func(ev *kardia.EventCtx) (any, error) {
		if outcome, ok := ev.Args[1].(Outcome); ok {
			seenOutcome = outcome
		}
		return nil, nil
	})

	_, err := registry.Execute(root, "guarded_tool", nil)
	var denied *DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("拒绝应产出 *DeniedError，实际：%v", err)
	}
	if denied.Reason != "该动作需要人工审批" || denied.Name != "guarded_tool" {
		t.Fatalf("拒绝信息不符：%v", denied)
	}
	if called {
		t.Fatal("被拒的调用不得触达处理器")
	}
	if seenCall.Name != "guarded_tool" || seenCall.ID == "" {
		t.Fatalf("pre-execute 收到的调用描述不符：%v", seenCall)
	}
	if seenOutcome.Err == nil || !errors.As(seenOutcome.Err, &denied) {
		t.Fatalf("result 事件应携带拒绝错误：%v", seenOutcome.Err)
	}
}

func TestPreExecuteDenyShortCircuitsLaterListeners(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("short_circuit_tool", 1)); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	reached := false
	listen(t, root, EventPreExecute, func(*kardia.EventCtx) (any, error) {
		return &Deny{Reason: "先拒"}, nil
	})
	listen(t, root, EventPreExecute, func(*kardia.EventCtx) (any, error) {
		reached = true
		return nil, nil
	})

	if _, err := registry.Execute(root, "short_circuit_tool", nil); err == nil {
		t.Fatal("应被拒")
	}
	if reached {
		t.Fatal("瀑布被拦截后不得继续调用后续监听者")
	}
}

func TestPreExecuteUnknownDecisionFailsClosed(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	called := false
	if _, err := registry.Register(Descriptor{
		Name:        "odd_tool",
		Description: "监听者返回了怪东西",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(*kardia.Context, Arguments) (any, error) {
			called = true
			return nil, nil
		},
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	listen(t, root, EventPreExecute, func(*kardia.EventCtx) (any, error) { return "允许", nil })

	_, err := registry.Execute(root, "odd_tool", nil)
	if err == nil || !strings.Contains(err.Error(), "无法识别的裁决") {
		t.Fatalf("未知裁决应失败闭合，实际：%v", err)
	}
	if called {
		t.Fatal("裁决不可识别时不得调用处理器")
	}
}

func TestPreExecuteListenerErrorPropagates(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("error_tool", 1)); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	sentinel := errors.New("策略服务不可用")
	listen(t, root, EventPreExecute, func(*kardia.EventCtx) (any, error) { return nil, sentinel })

	if _, err := registry.Execute(root, "error_tool", nil); !errors.Is(err, sentinel) {
		t.Fatalf("监听者错误应穿透，实际：%v", err)
	}
}

func TestExecuteWaterfallCanWrapHandler(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("wrap_tool", "raw")); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	listen(t, root, EventExecute, func(ev *kardia.EventCtx) (any, error) {
		value, err := ev.Next()
		if err != nil {
			return nil, err
		}
		return map[string]any{"wrapped": value}, nil
	})

	value, err := registry.Execute(root, "wrap_tool", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	wrapped, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("返回值应被包裹：%v", value)
	}
	inner, ok := wrapped["wrapped"].(map[string]any)
	if !ok || inner["echo"] != "raw" {
		t.Fatalf("包裹内容不符：%v", wrapped)
	}
}

func TestPostExecuteCanReplaceOutcome(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	sentinel := errors.New("上游超时")
	if _, err := registry.Register(Descriptor{
		Name:        "flaky_tool",
		Description: "恒失败但被改判",
		Parameters:  Schema{Type: SchemaObject},
		Handler:     func(*kardia.Context, Arguments) (any, error) { return nil, sentinel },
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	listen(t, root, EventPostExecute, func(ev *kardia.EventCtx) (any, error) {
		call, _ := ev.Args[0].(Call)
		outcome, _ := ev.Args[1].(Outcome)
		if outcome.Err == nil {
			return ev.Next()
		}
		return &Outcome{Value: map[string]any{"degraded": call.Name, "reason": outcome.Err.Error()}}, nil
	})

	value, err := registry.Execute(root, "flaky_tool", nil)
	if err != nil {
		t.Fatalf("改判后不应返回错误：%v", err)
	}
	degraded, ok := value.(map[string]any)
	if !ok || degraded["degraded"] != "flaky_tool" || degraded["reason"] != sentinel.Error() {
		t.Fatalf("改判结果不符：%v", value)
	}
}

func TestResultAndChangeEvents(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	var results []Call
	listen(t, root, EventResult, func(ev *kardia.EventCtx) (any, error) {
		if call, ok := ev.Args[0].(Call); ok {
			results = append(results, call)
		}
		return nil, nil
	})
	var changes []Change
	listen(t, root, EventChange, func(ev *kardia.EventCtx) (any, error) {
		if change, ok := ev.Args[0].(Change); ok {
			changes = append(changes, change)
		}
		return nil, nil
	})

	dispose, err := registry.Register(echoDescriptor("event_tool", 1))
	if err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	if len(changes) != 1 || changes[0].Kind != ChangeRegistered || changes[0].Name != "event_tool" {
		t.Fatalf("注册应发出 change 事件：%v", changes)
	}
	for i := 0; i < 2; i++ {
		if _, err := registry.Execute(root, "event_tool", nil); err != nil {
			t.Fatalf("第 %d 次执行失败：%v", i+1, err)
		}
	}
	if len(results) != 2 || results[0].ID == results[1].ID {
		t.Fatalf("每次执行应产出唯一调用标识：%v", results)
	}
	if err := dispose(nil); err == nil {
		t.Fatal("销毁必须接收非 nil 的 ctx")
	}
	if err := dispose(context.Background()); err != nil {
		t.Fatalf("撤销失败：%v", err)
	}
	if len(changes) != 2 || changes[1].Kind != ChangeRemoved {
		t.Fatalf("撤销应发出 change 事件：%v", changes)
	}
}

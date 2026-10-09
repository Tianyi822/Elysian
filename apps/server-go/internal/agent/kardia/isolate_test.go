package kardia

import (
	"context"
	"sync/atomic"
	"testing"
)

// 对应 core/tests/isolate.spec.ts（3 个用例）。isolate 以 IsolateMap 的
// 链式符号表承载（同 label 同符号即同隔离域）；TS 的 await sleep() 以
// 显式 Await 依赖 fiber 替换（确定性，不依赖真实时间）。

// isolateFooOf 读取 c 域上的 foo 实现值（nil 返回 nil）。
func isolateFooOf(c *Context) any {
	v, _ := c.Get("foo")
	return v
}

// isolateBarOf 读取 foo.bar 数值；foo 缺失时返回 -1（等价 TS 的 undefined
// 断言分支）。
func isolateBarOf(c *Context) int {
	v := isolateFooOf(c)
	if v == nil {
		return -1
	}
	m, ok := v.(map[string]any)
	if !ok {
		return -1
	}
	bar, ok := m["bar"].(int)
	if !ok {
		return -1
	}
	return bar
}

// TestIsolateIsolatedContext 对应 'isolated context'：不同 label 的隔离域
// 互不可见；provide/dispose 只影响本域的注入 fiber。
func TestIsolateIsolatedContext(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	callbackCalls, disposeCalls := 0, 0
	plugin := &Plugin{
		Inject: InjectMap{"foo": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			callbackCalls++
			return func(context.Context) error {
				disposeCalls++
				return nil
			}, nil
		},
	}

	fiber0, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	ctx1 := root.Isolate("foo", nil)
	fiber1, err := ctx1.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件（ctx1）失败：%v", err)
	}
	ctx2 := root.Isolate("foo", nil)
	fiber2, err := ctx2.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件（ctx2）失败：%v", err)
	}

	awaitFiber := func(f *Fiber, stage string) {
		t.Helper()
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("%s：等待 fiber 失败：%v", stage, err)
		}
	}

	dispose0, err := root.Provide("foo", map[string]any{"bar": 100}, nil)
	if err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	awaitFiber(fiber0, "root provide")
	if got := isolateBarOf(root); got != 100 {
		t.Fatalf("root.foo.bar 应为 100，实际 %d", got)
	}
	if v := isolateFooOf(ctx1); v != nil {
		t.Fatalf("ctx1.foo 应为 nil，实际 %v", v)
	}
	if v := isolateFooOf(ctx2); v != nil {
		t.Fatalf("ctx2.foo 应为 nil，实际 %v", v)
	}
	if callbackCalls != 1 || disposeCalls != 0 {
		t.Fatalf("root provide 后计数应为 1/0，实际 %d/%d", callbackCalls, disposeCalls)
	}

	dispose1, err := ctx1.Provide("foo", map[string]any{"bar": 200}, nil)
	if err != nil {
		t.Fatalf("provide foo（ctx1）失败：%v", err)
	}
	awaitFiber(fiber1, "ctx1 provide")
	if got := isolateBarOf(root); got != 100 {
		t.Fatalf("root.foo.bar 仍应为 100，实际 %d", got)
	}
	if got := isolateBarOf(ctx1); got != 200 {
		t.Fatalf("ctx1.foo.bar 应为 200，实际 %d", got)
	}
	if v := isolateFooOf(ctx2); v != nil {
		t.Fatalf("ctx2.foo 应为 nil，实际 %v", v)
	}
	if callbackCalls != 2 || disposeCalls != 0 {
		t.Fatalf("ctx1 provide 后计数应为 2/0，实际 %d/%d", callbackCalls, disposeCalls)
	}

	if err := dispose0(ctxBg); err != nil {
		t.Fatalf("撤销 root provide 失败：%v", err)
	}
	awaitFiber(fiber0, "root dispose")
	if v := isolateFooOf(root); v != nil {
		t.Fatalf("root.foo 应为 nil，实际 %v", v)
	}
	if got := isolateBarOf(ctx1); got != 200 {
		t.Fatalf("ctx1.foo.bar 仍应为 200，实际 %d", got)
	}
	if v := isolateFooOf(ctx2); v != nil {
		t.Fatalf("ctx2.foo 应为 nil，实际 %v", v)
	}
	if callbackCalls != 2 || disposeCalls != 1 {
		t.Fatalf("root 撤销后计数应为 2/1，实际 %d/%d", callbackCalls, disposeCalls)
	}

	if _, err := ctx2.Provide("foo", map[string]any{"bar": 300}, nil); err != nil {
		t.Fatalf("provide foo（ctx2）失败：%v", err)
	}
	awaitFiber(fiber2, "ctx2 provide")
	if v := isolateFooOf(root); v != nil {
		t.Fatalf("root.foo 应为 nil，实际 %v", v)
	}
	if got := isolateBarOf(ctx1); got != 200 {
		t.Fatalf("ctx1.foo.bar 仍应为 200，实际 %d", got)
	}
	if got := isolateBarOf(ctx2); got != 300 {
		t.Fatalf("ctx2.foo.bar 应为 300，实际 %d", got)
	}
	if callbackCalls != 3 || disposeCalls != 1 {
		t.Fatalf("ctx2 provide 后计数应为 3/1，实际 %d/%d", callbackCalls, disposeCalls)
	}
	_ = dispose1
}

// TestIsolateSharedLabel 对应 'shared label'：同 label 的两个隔离域共享
// 实现；域内撤销同时销毁两份注入 fiber。
func TestIsolateSharedLabel(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var callbackCalls, disposeCalls atomic.Int64
	plugin := &Plugin{
		Inject: InjectMap{"foo": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			callbackCalls.Add(1)
			return func(context.Context) error {
				disposeCalls.Add(1)
				return nil
			}, nil
		},
	}

	label := NewSymbol("test")
	fiber0, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	ctx1 := root.Isolate("foo", label)
	fiber1, err := ctx1.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件（ctx1）失败：%v", err)
	}
	ctx2 := root.Isolate("foo", label)
	fiber2, err := ctx2.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件（ctx2）失败：%v", err)
	}

	awaitFiber := func(f *Fiber, stage string) {
		t.Helper()
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("%s：等待 fiber 失败：%v", stage, err)
		}
	}
	awaitFiber(fiber0, "初始")
	if callbackCalls.Load() != 0 || disposeCalls.Load() != 0 {
		t.Fatalf("初始计数应为 0/0，实际 %d/%d", callbackCalls.Load(), disposeCalls.Load())
	}

	dispose0, err := root.Provide("foo", map[string]any{"bar": 100}, nil)
	if err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	awaitFiber(fiber0, "root provide")
	if got := isolateBarOf(root); got != 100 {
		t.Fatalf("root.foo.bar 应为 100，实际 %d", got)
	}
	if v := isolateFooOf(ctx1); v != nil {
		t.Fatalf("ctx1.foo 应为 nil，实际 %v", v)
	}
	if v := isolateFooOf(ctx2); v != nil {
		t.Fatalf("ctx2.foo 应为 nil，实际 %v", v)
	}
	if callbackCalls.Load() != 1 || disposeCalls.Load() != 0 {
		t.Fatalf("root provide 后计数应为 1/0，实际 %d/%d", callbackCalls.Load(), disposeCalls.Load())
	}

	dispose12, err := ctx1.Provide("foo", map[string]any{"bar": 200}, nil)
	if err != nil {
		t.Fatalf("provide foo（ctx1）失败：%v", err)
	}
	awaitFiber(fiber1, "ctx1 provide")
	awaitFiber(fiber2, "ctx1 provide")
	if got := isolateBarOf(root); got != 100 {
		t.Fatalf("root.foo.bar 仍应为 100，实际 %d", got)
	}
	if got := isolateBarOf(ctx1); got != 200 {
		t.Fatalf("ctx1.foo.bar 应为 200，实际 %d", got)
	}
	if got := isolateBarOf(ctx2); got != 200 {
		t.Fatalf("共享 label 下 ctx2.foo.bar 应为 200，实际 %d", got)
	}
	if callbackCalls.Load() != 3 || disposeCalls.Load() != 0 {
		t.Fatalf("共享域 provide 后计数应为 3/0，实际 %d/%d", callbackCalls.Load(), disposeCalls.Load())
	}

	if err := dispose12(ctxBg); err != nil {
		t.Fatalf("撤销共享域 provide 失败：%v", err)
	}
	awaitFiber(fiber1, "共享域撤销")
	awaitFiber(fiber2, "共享域撤销")
	if got := isolateBarOf(root); got != 100 {
		t.Fatalf("root.foo.bar 仍应为 100，实际 %d", got)
	}
	if v := isolateFooOf(ctx1); v != nil {
		t.Fatalf("ctx1.foo 应为 nil，实际 %v", v)
	}
	if v := isolateFooOf(ctx2); v != nil {
		t.Fatalf("ctx2.foo 应为 nil，实际 %v", v)
	}
	if callbackCalls.Load() != 3 || disposeCalls.Load() != 2 {
		t.Fatalf("共享域撤销后计数应为 3/2，实际 %d/%d", callbackCalls.Load(), disposeCalls.Load())
	}
	_ = dispose0
}

// isolateFooSvc 对应 'isolated event' 的 Foo：构造即以服务实例为 thisArg
// 发射事件（Service 的 [symbols.filter] 按 isolate 符号过滤）。
type isolateFooSvc struct {
	Service
}

// TestIsolateIsolatedEvent 对应 'isolated event'：以服务实例为 thisArg 的
// 派发按其所在隔离域过滤，外层 ctx 的监听器不触发。
func TestIsolateIsolatedEvent(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	ctx := root.Isolate("foo", nil)
	outerCalls, innerCalls := 0, 0
	event := StringEvent("custom-event")
	root.On(event, func(*EventCtx) (any, error) {
		outerCalls++
		return nil, nil
	})
	ctx.On(event, func(*EventCtx) (any, error) {
		innerCalls++
		return nil, nil
	})

	fiber, err := ctx.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &isolateFooSvc{}
			s.Service = newTestService(c, "foo", s, nil)
			// 对应 TS 构造器的 this.ctx.emit(this, event)
			if err := c.EmitTo(s, event); err != nil {
				t.Errorf("emit 失败：%v", err)
			}
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}

	if outerCalls != 0 {
		t.Fatalf("外层监听器不应触发，实际 %d 次", outerCalls)
	}
	if innerCalls != 1 {
		t.Fatalf("隔离域内监听器应触发 1 次，实际 %d 次", innerCalls)
	}
}

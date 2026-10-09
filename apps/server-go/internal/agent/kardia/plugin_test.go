package kardia

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// 对应 core/tests/plugin.spec.ts（10 个用例）。inspect 断言改为
// Context.String()（"Context <fiber name>"）；_disposables.length 经
// Fiber.Disposables()；throw 断言改为 error 断言（方案第 3 节）。

// TestPluginApplyFunctional 对应 'apply functional plugin'：回调恰好执行一次
// 且收到原样 config。
func TestPluginApplyFunctional(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	calls := 0
	var gotConfig any
	fiber, err := root.Plugin(&Plugin{
		Apply: func(c *Context, config any) (Disposable, error) {
			calls++
			gotConfig = config
			return nil, nil
		},
	}, map[string]any{"foo": "bar"})
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if calls != 1 {
		t.Fatalf("回调应恰好执行 1 次，实际 %d 次", calls)
	}
	if !reflect.DeepEqual(gotConfig, map[string]any{"foo": "bar"}) {
		t.Fatalf("config 应原样传入：%v", gotConfig)
	}
}

// TestPluginApplyObject 对应 'apply object plugin'：对象形态（具名 Plugin）同
// 样装载，runtime 以插件名建档。
func TestPluginApplyObject(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	calls := 0
	var gotConfig any
	plugin := &Plugin{
		Name: "bar",
		Apply: func(c *Context, config any) (Disposable, error) {
			calls++
			gotConfig = config
			return nil, nil
		},
	}
	fiber, err := root.Plugin(plugin, map[string]any{"bar": "foo"})
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if calls != 1 {
		t.Fatalf("回调应恰好执行 1 次，实际 %d 次", calls)
	}
	if !reflect.DeepEqual(gotConfig, map[string]any{"bar": "foo"}) {
		t.Fatalf("config 应原样传入：%v", gotConfig)
	}
	runtime := root.Registry().Get(plugin)
	if runtime == nil || runtime.Name != "bar" {
		t.Fatalf("runtime 应以插件名 bar 建档：%v", runtime)
	}
}

// TestPluginApplyInvalid 对应 'apply invalid plugin'：无效插件（Apply 缺失）
// 返回中文错误。
func TestPluginApplyInvalid(t *testing.T) {
	root := NewContext()
	cases := []struct {
		name   string
		plugin *Plugin
	}{
		{"nil 插件", nil},
		{"空插件", &Plugin{}},
		{"仅有名字的插件", &Plugin{Name: "x"}},
	}
	for _, tc := range cases {
		_, err := root.Plugin(tc.plugin, nil)
		if err == nil {
			t.Fatalf("%s 应返回错误", tc.name)
		}
		if !strings.Contains(err.Error(), "无效的插件") {
			t.Fatalf("%s 的错误文案应说明无效插件，实际 %q", tc.name, err.Error())
		}
	}
}

// TestPluginInactiveContext 对应 'inactive context'：已销毁 fiber 的 ctx 上
// 注册插件/effect 被拒（错误码保持协议值、文案中文）。ctx.on 的 inactive 检查同源
// （events.On 注册前 assertActive），以 AssertActive 等价断言。
func TestPluginInactiveContext(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	callbackCalls := 0
	callback := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			callbackCalls++
			return nil, nil
		},
	}
	var pluginErr, effectErr, assertErr error
	fiber, err := root.Plugin(&Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			return func(context.Context) error {
				_, pluginErr = c.Plugin(callback, nil)
				_, effectErr = c.Fiber().Effect("e", func() (Disposable, error) { return nil, nil })
				assertErr = c.Fiber().AssertActive()
				return nil
			}, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件激活失败：%v", err)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	const want = "无法在非激活上下文中创建副作用"
	for name, err := range map[string]error{"plugin": pluginErr, "effect": effectErr, "on": assertErr} {
		if err == nil {
			t.Fatalf("inactive ctx 上 %s 应被拒绝", name)
		}
		var ce *CordisError
		if !errors.As(err, &ce) {
			t.Fatalf("%s 的错误应为 CordisError，实际 %T", name, err)
		}
		if ce.Code != "INACTIVE_EFFECT" {
			t.Fatalf("%s 的错误码不符：%s", name, ce.Code)
		}
		if err.Error() != want {
			t.Fatalf("%s 的错误文案不符：%q", name, err.Error())
		}
	}
	if callbackCalls != 0 {
		t.Fatalf("被拒插件不应执行，实际 %d 次", callbackCalls)
	}
}

// TestPluginContextInspect 对应 'context inspect'：Context 的字符串形态为
// "Context <fiber name>"（根为 root，插件 fiber 取插件名）。
func TestPluginContextInspect(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	if got := root.String(); got != "Context <root>" {
		t.Fatalf("根 ctx 应为 Context <root>，实际 %q", got)
	}
	var names []string
	load := func(name string) {
		t.Helper()
		fiber, err := root.Plugin(&Plugin{
			Name: name,
			Apply: func(c *Context, _ any) (Disposable, error) {
				names = append(names, c.String())
				return nil, nil
			},
		}, nil)
		if err != nil {
			t.Fatalf("装载 %s 失败：%v", name, err)
		}
		if _, err := fiber.Await(ctxBg); err != nil {
			t.Fatalf("等待 %s 失败：%v", name, err)
		}
	}
	load("foo")
	load("bar")
	load("Qux")
	want := []string{"Context <foo>", "Context <bar>", "Context <Qux>"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("插件 ctx 的字符串形态不符：%v want %v", names, want)
	}
}

// TestPluginRegistry 对应 'ctx.registry'：注册表的内省与计数。
func TestPluginRegistry(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	plugin := &Plugin{
		Name:  "p",
		Apply: func(c *Context, _ any) (Disposable, error) { return nil, nil },
	}
	if got := root.Registry().Size(); got != 0 {
		t.Fatalf("初始 size 应为 0，实际 %d", got)
	}
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if got := root.Registry().Size(); got != 1 {
		t.Fatalf("装载后 size 应为 1，实际 %d", got)
	}
	if !root.Registry().Has(plugin) {
		t.Fatal("Has 应为真")
	}
	runtime := root.Registry().Get(plugin)
	if runtime == nil || len(runtime.FiberSnapshot()) != 1 {
		t.Fatalf("Get 应返回持有 1 个 fiber 的运行时：%v", runtime)
	}
	if got := len(root.Registry().Values()); got != 1 {
		t.Fatalf("Values 长度应为 1，实际 %d", got)
	}
	uid := fiber.UID()
	if uid == nil || *uid != 1 {
		t.Fatalf("首个插件 fiber 的 uid 应为 1，实际 %v", uid)
	}
	if got := root.Registry().Counter(); got != 2 {
		t.Fatalf("Counter 应自增为 2，实际 %d", got)
	}
	if left, err := root.Registry().Delete(plugin); left == nil || err != nil {
		t.Fatal("Delete 应返回被移除的运行时")
	}
	if got := root.Registry().Size(); got != 0 {
		t.Fatalf("Delete 后 size 应为 0，实际 %d", got)
	}
	if root.Registry().Has(plugin) {
		t.Fatal("Delete 后 Has 应为假")
	}
	if got := root.Registry().Get(plugin); got != nil {
		t.Fatalf("Delete 后 Get 应为 nil，实际 %v", got)
	}
}

// TestPluginNestedPlugins 对应 'nested plugins'：嵌套装载的注册表大小、事件
// 分发与整体销毁。
func TestPluginNestedPlugins(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	calls := 0
	listener := func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	}
	emit := func() {
		t.Helper()
		calls = 0
		if err := root.Emit(StringEvent("custom-event")); err != nil {
			t.Fatalf("emit 失败：%v", err)
		}
	}
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			_, _ = c.On(StringEvent("custom-event"), listener)
			nested, err := c.Plugin(&Plugin{
				Apply: func(c *Context, _ any) (Disposable, error) {
					_, _ = c.On(StringEvent("custom-event"), listener)
					innermost, err := c.Plugin(&Plugin{
						Apply: func(c *Context, _ any) (Disposable, error) {
							_, _ = c.On(StringEvent("custom-event"), listener)
							return nil, nil
						},
					}, nil)
					if err != nil {
						return nil, err
					}
					_, err = innermost.Await(ctxBg)
					return nil, err
				},
			}, nil)
			if err != nil {
				return nil, err
			}
			_, err = nested.Await(ctxBg)
			return nil, err
		},
	}
	_, _ = root.On(StringEvent("custom-event"), listener)
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	emit()
	if calls != 4 {
		t.Fatalf("此时应有 4 个监听器，实际 %d 次", calls)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	if got := root.Registry().Size(); got != 0 {
		t.Fatalf("销毁后注册表应清空，实际 %d", got)
	}
	emit()
	if calls != 1 {
		t.Fatalf("销毁后应只剩根级 1 个监听器，实际 %d 次", calls)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("重复 dispose 失败：%v", err)
	}
	if got := root.Registry().Size(); got != 0 {
		t.Fatalf("重复 dispose 后注册表应保持空，实际 %d", got)
	}
	emit()
	if calls != 1 {
		t.Fatalf("重复 dispose 后监听器应不变，实际 %d 次", calls)
	}
}

// TestPluginCompareSnapshot 对应 'compare snapshot'：删除插件后钩子快照回到
// 装载前，重新装载后快照复现。
func TestPluginCompareSnapshot(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			_, _ = c.On(StringEvent("custom-event"), noopListener)
			nested, err := c.Plugin(&Plugin{
				Apply: func(c *Context, _ any) (Disposable, error) {
					_, _ = c.On(StringEvent("custom-event"), noopListener)
					innermost, err := c.Plugin(&Plugin{
						Apply: func(c *Context, _ any) (Disposable, error) {
							_, _ = c.On(StringEvent("custom-event"), noopListener)
							return nil, nil
						},
					}, nil)
					if err != nil {
						return nil, err
					}
					_, err = innermost.Await(ctxBg)
					return nil, err
				},
			}, nil)
			if err != nil {
				return nil, err
			}
			_, err = nested.Await(ctxBg)
			return nil, err
		},
	}
	before := GetHookSnapshot(root)
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	after := GetHookSnapshot(root)
	// 删除前收集 fiber，删除后显式等待其销毁（等价 TS 的 await sleep()）。
	runtime := root.Registry().Get(plugin)
	var fibers []*Fiber
	if runtime != nil {
		fibers = runtime.FiberSnapshot()
	}
	root.Registry().Delete(plugin)
	for _, f := range fibers {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 销毁失败：%v", err)
		}
	}
	if !reflect.DeepEqual(before, GetHookSnapshot(root)) {
		t.Fatalf("删除插件后钩子快照应回到 before：%v vs %v", before, GetHookSnapshot(root))
	}
	again, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("重新装载插件失败：%v", err)
	}
	if _, err := again.Await(ctxBg); err != nil {
		t.Fatalf("等待重新装载失败：%v", err)
	}
	if !reflect.DeepEqual(after, GetHookSnapshot(root)) {
		t.Fatalf("重新装载后钩子快照应等于 after：%v vs %v", after, GetHookSnapshot(root))
	}
}

// TestPluginRootDispose 对应 'root dispose'：根 fiber 销毁即重启，子插件
// fiber 置空 uid 并执行清理器，根 fiber 的 uid 与 disposables 状态保持。
func TestPluginRootDispose(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	disposeCalls := 0
	fiber, err := root.Plugin(&Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			return func(context.Context) error {
				disposeCalls++
				return nil
			}, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatal(err)
	}
	rootUID := root.Fiber().UID()
	if rootUID == nil || *rootUID != 0 {
		t.Fatalf("根 fiber 的 uid 应为 0，实际 %v", rootUID)
	}
	uid := fiber.UID()
	if uid == nil || *uid != 1 {
		t.Fatalf("插件 fiber 的 uid 应为 1，实际 %v", uid)
	}
	if disposeCalls != 0 {
		t.Fatalf("销毁前清理器不应执行，实际 %d 次", disposeCalls)
	}
	if got := len(root.Fiber().Disposables()); got != 1 {
		t.Fatalf("根 fiber 应有 1 个登记项，实际 %d", got)
	}
	if err := root.Fiber().Dispose(ctxBg); err != nil {
		t.Fatalf("根 fiber dispose 失败：%v", err)
	}
	rootUID = root.Fiber().UID()
	if rootUID == nil || *rootUID != 0 {
		t.Fatalf("根 fiber 的 uid 应保持 0，实际 %v", rootUID)
	}
	if got := fiber.UID(); got != nil {
		t.Fatalf("插件 fiber 的 uid 应为 nil（已销毁），实际 %v", got)
	}
	if disposeCalls != 1 {
		t.Fatalf("清理器应恰好执行 1 次，实际 %d 次", disposeCalls)
	}
	if got := len(root.Fiber().Disposables()); got != 0 {
		t.Fatalf("根 fiber 的登记项应清空，实际 %d", got)
	}
	if err := root.Fiber().Dispose(ctxBg); err != nil {
		t.Fatalf("重复根 fiber dispose 失败：%v", err)
	}
	rootUID = root.Fiber().UID()
	if rootUID == nil || *rootUID != 0 {
		t.Fatalf("重复 dispose 后根 fiber 的 uid 应保持 0，实际 %v", rootUID)
	}
	if got := fiber.UID(); got != nil {
		t.Fatalf("重复 dispose 后插件 fiber 的 uid 应保持 nil，实际 %v", got)
	}
	if disposeCalls != 1 {
		t.Fatalf("重复 dispose 不应再执行清理器，实际 %d 次", disposeCalls)
	}
	if got := len(root.Fiber().Disposables()); got != 0 {
		t.Fatalf("重复 dispose 后登记项应保持空，实际 %d", got)
	}
}

// TestPluginServiceInit 对应 'Service.init'：init 的启动与返回的清理器随
// fiber 生命周期各执行一次（TS 的 [Service.init] 在 Go 由 Apply 显式承载）。
func TestPluginServiceInit(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	startCalls, stopCalls := 0, 0
	fiber, err := root.Plugin(&Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			startCalls++
			return func(context.Context) error {
				stopCalls++
				return nil
			}, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if startCalls != 1 || stopCalls != 0 {
		t.Fatalf("激活后应为 start=1 stop=0，实际 start=%d stop=%d", startCalls, stopCalls)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	if startCalls != 1 || stopCalls != 1 {
		t.Fatalf("销毁后应为 start=1 stop=1，实际 start=%d stop=%d", startCalls, stopCalls)
	}
}

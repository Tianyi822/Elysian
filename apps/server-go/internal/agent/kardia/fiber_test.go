package kardia

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia/clock"
)

// 生命周期测试通过通道屏障和 Manual 登记通知固定并发顺序。

// assertState 断言 fiber 状态。
func assertState(t *testing.T, f *Fiber, want FiberState) {
	t.Helper()
	if got := f.State(); got != want {
		t.Fatalf("fiber 状态应为 %s，实际 %s", want, got)
	}
}

// countErrors 统计日志缓冲中的 error 消息数（对应 TS 替换 root.logger.error
// 后的 error.mock.calls 计数）。
func countErrors(root *Context) int {
	n := 0
	for _, m := range root.LoggerService().Messages() {
		if m.Type == "error" {
			n++
		}
	}
	return n
}

// TestFiberInertiaLock1 覆盖依赖消失时迟到的资源：旧代清理结束前不能启动新代。
func TestFiberInertiaLock1(t *testing.T) {
	root := NewContext()
	lifetime := make(chan context.Context, 2)
	releaseApply := make(chan struct{})
	cleanupStarted := make(chan struct{})
	releaseCleanup := make(chan struct{})
	var generation atomic.Int64
	provider, err := root.Provide("foo", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		gen := generation.Add(1)
		lifetime <- c.Lifetime()
		if gen != 1 {
			return nil, nil
		}
		<-releaseApply
		return func(context.Context) error { close(cleanupStarted); <-releaseCleanup; return nil }, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	first := awaitTestSignal(t, lifetime, "首代加载")
	assertState(t, fiber, FiberLoading)
	removed := make(chan error, 1)
	go func() { removed <- provider(context.Background()) }()
	awaitTestSignal(t, first.Done(), "旧代取消")
	close(releaseApply)
	awaitTestSignal(t, cleanupStarted, "旧代资源清理")
	assertState(t, fiber, FiberUnloading)
	if _, err := root.Provide("foo", 2, nil); err != nil {
		t.Fatal(err)
	}
	if got := generation.Load(); got != 1 {
		t.Fatalf("旧代清理完成前启动了新代：%d", got)
	}
	close(releaseCleanup)
	if err := awaitTestSignal(t, removed, "原服务撤销"); err != nil {
		t.Fatal(err)
	}
	second := awaitTestSignal(t, lifetime, "第二代加载")
	if second.Err() != nil {
		t.Fatalf("第二代已被取消：%v", second.Err())
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertState(t, fiber, FiberActive)
	if err := root.Fiber().Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestFiberInertiaLock2 覆盖加载中的依赖短暂消失和恢复：已取消的激活代不能复活，
// 必须先释放旧资源，再使用新的 Lifetime 加载一次。
func TestFiberInertiaLock2(t *testing.T) {
	root := NewContext()
	started := make(chan context.Context, 2)
	allowExit := make(chan struct{})
	cleaned := make(chan struct{})
	var generation atomic.Int64
	provider, err := root.Provide("foo", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		gen := generation.Add(1)
		if gen != 1 {
			started <- c.Lifetime()
			select {
			case <-cleaned:
				return nil, nil
			default:
				return nil, errors.New("旧资源未清理就启动新代")
			}
		}
		if _, err := c.Effect("旧资源", func() (Disposable, error) {
			return func(context.Context) error { close(cleaned); return nil }, nil
		}); err != nil {
			return nil, err
		}
		started <- c.Lifetime()
		<-c.Lifetime().Done()
		<-allowExit
		return nil, c.Lifetime().Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	first := awaitTestSignal(t, started, "首代加载")
	assertState(t, fiber, FiberLoading)
	removed := make(chan error, 1)
	go func() { removed <- provider(context.Background()) }()
	awaitTestSignal(t, first.Done(), "首代取消")
	if _, err := root.Provide("foo", 2, nil); err != nil {
		t.Fatal(err)
	}
	close(allowExit)
	second := awaitTestSignal(t, started, "第二代加载")
	if second == first || second.Err() != nil {
		t.Fatal("第二代必须得到独立的活动 Lifetime")
	}
	awaitTestSignal(t, cleaned, "旧资源清理完成")
	if err := awaitTestSignal(t, removed, "原服务撤销"); err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertState(t, fiber, FiberActive)
	if got := generation.Load(); got != 2 {
		t.Fatalf("激活次数 %d，期望 2", got)
	}
	if err := root.Fiber().Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// inertiaLockFoo 对应 'inertia lock 3' 的 Foo 服务。
type inertiaLockFoo struct {
	Service
}

// TestFiberInertiaLock3 对应 'inertia lock 3'：服务插件销毁后注入 fiber 回到
// PENDING。
func TestFiberInertiaLock3(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		providerPlugin := &Plugin{
			Name: "Foo",
			Apply: func(c *Context, _ any) (Disposable, error) {
				s := &inertiaLockFoo{}
				s.Service = newTestService(c, "foo", s, nil)
				return nil, nil
			},
		}
		providerFiber, err := root.Plugin(providerPlugin, nil)
		if err != nil {
			t.Fatalf("装载 Foo 失败：%v", err)
		}
		if _, err := providerFiber.Await(context.Background()); err != nil {
			t.Fatalf("等待 Foo 失败：%v", err)
		}
		fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
			if err := root.Clock().Sleep(c.Lifetime(), time.Second); err != nil {
				return nil, err
			}
			return func(ctx context.Context) error {
				return root.Clock().Sleep(ctx, time.Second)
			}, nil
		})
		if err != nil {
			t.Fatalf("inject 失败：%v", err)
		}
		advanceRegisteredTimer(t, clk, 400*time.Millisecond)
		assertState(t, fiber, FiberLoading)
		clk.Advance(600 * time.Millisecond)
		if _, err := fiber.Await(context.Background()); err != nil {
			t.Fatal(err)
		}
		assertState(t, fiber, FiberActive)
		disposed := make(chan error, 1)
		go func() {
			disposed <- providerFiber.Dispose(context.Background())
		}()
		advanceRegisteredTimer(t, clk, time.Second)
		disErr := awaitTestSignal(t, disposed, "提供方销毁完成")
		if disErr != nil {
			t.Fatalf("provider 销毁不应失败：%v", disErr)
		}
		assertState(t, fiber, FiberPending)
	})(t)
}

// TestFiberPluginError 对应 'plugin error'：失败 fiber 的钩子随卸载移除，
// 错误恰好上报一次，健康 fiber 照常工作。
func TestFiberPluginError(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	calls := 0
	apply := func(c *Context, config any) (Disposable, error) {
		c.On(StringEvent("custom-event"), func(*EventCtx) (any, error) {
			calls++
			return nil, nil
		})
		if m, ok := config.(map[string]any); !ok || m["foo"] != true {
			return nil, errors.New("plugin error")
		}
		return nil, nil
	}
	plugin := &Plugin{Apply: apply}
	fiber1, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载 fiber1 失败：%v", err)
	}
	fiber2, err := root.Plugin(plugin, map[string]any{"foo": true})
	if err != nil {
		t.Fatalf("装载 fiber2 失败：%v", err)
	}
	if _, err := fiber1.Await(ctxBg); err == nil {
		t.Fatal("fiber1 应以 plugin error 失败")
	}
	if _, err := fiber2.Await(ctxBg); err != nil {
		t.Fatalf("fiber2 应激活成功：%v", err)
	}
	assertState(t, fiber1, FiberFailed)
	assertState(t, fiber2, FiberActive)
	if got := countErrors(root); got != 1 {
		t.Fatalf("应恰好上报 1 条错误，实际 %d", got)
	}
	if err := root.Emit(StringEvent("custom-event")); err != nil {
		t.Fatalf("emit 失败：%v", err)
	}
	if calls != 1 {
		t.Fatalf("emit 后回调应恰好执行 1 次，实际 %d", calls)
	}
}

// TestFiberFailedDoesNotReenter 对应 'failed fiber does not re-enter on
// dependency refresh'：失败 fiber 冻结，依赖刷新不重入。
func TestFiberFailedDoesNotReenter(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	applyCalls := 0
	apply := func(c *Context, _ any) (Disposable, error) {
		applyCalls++
		return nil, errors.New("boom")
	}
	provider, err := root.Provide("foo", 1, nil)
	if err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	fiber, err := root.Inject([]string{"foo"}, apply)
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err == nil {
		t.Fatal("fiber 应以 boom 失败")
	}
	assertState(t, fiber, FiberFailed)
	if err := provider(ctxBg); err != nil {
		t.Fatalf("撤销 provide 失败：%v", err)
	}
	if _, err := root.Provide("foo", 2, nil); err != nil {
		t.Fatalf("重新 provide foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err == nil {
		t.Fatal("失败 fiber 的 Await 应持续返回错误")
	}
	if applyCalls != 1 {
		t.Fatalf("apply 应恰好执行 1 次，实际 %d", applyCalls)
	}
	assertState(t, fiber, FiberFailed)
}

// TestFiberUpdateRecoversFailed 对应 'update recovers a failed fiber'：
// Update 清 _error 后 restart 恢复。
func TestFiberUpdateRecoversFailed(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	fail := true
	applyCalls := 0
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			applyCalls++
			if fail {
				return nil, errors.New("boom")
			}
			return nil, nil
		},
	}
	if _, err := root.Provide("foo", 1, nil); err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	fiber, err := root.Inject([]string{"foo"}, plugin.Apply)
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err == nil {
		t.Fatal("fiber 应以 boom 失败")
	}
	assertState(t, fiber, FiberFailed)
	fail = false
	if err := fiber.Update(ctxBg, nil, false); err != nil {
		t.Fatalf("update 应恢复失败 fiber：%v", err)
	}
	if applyCalls != 2 {
		t.Fatalf("apply 应恰好执行 2 次，实际 %d", applyCalls)
	}
	assertState(t, fiber, FiberActive)
}

// TestFiberUpdateSurfacesFailedReload 对应 'update surfaces a failed reload
// to its caller'：重载错误穿透给 Update 调用方。
func TestFiberUpdateSurfacesFailedReload(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	boom := false
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			if boom {
				return nil, errors.New("boom")
			}
			return nil, nil
		},
	}
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	boom = true
	err = fiber.Update(ctxBg, map[string]any{}, false)
	if err == nil || err.Error() != "boom" {
		t.Fatalf("update 应把重载错误返回给调用方，实际 %v", err)
	}
	assertState(t, fiber, FiberFailed)
}

// TestFiberUpdateDoesNotLeakDroppedFailure 对应 'update does not leak a
// dropped failure'：调用方丢弃返回值时错误只经 fiber 状态暴露。
func TestFiberUpdateDoesNotLeakDroppedFailure(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	boom := false
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			if boom {
				return nil, errors.New("boom")
			}
			return nil, nil
		},
	}
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	boom = true
	_ = fiber.Update(ctxBg, map[string]any{}, false)
	assertState(t, fiber, FiberFailed)
}

// TestFiberDisposeError 保证清理错误可通过 errors.Is 观察，且清理只执行一次。
func TestFiberDisposeError(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	disposeCalls := 0
	wantErr := errors.New("test")
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			return func(context.Context) error {
				disposeCalls++
				return wantErr
			}, nil
		},
	}
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if disposeCalls != 0 {
		t.Fatalf("销毁前清理器不应执行，实际 %d 次", disposeCalls)
	}
	if err := fiber.Dispose(ctxBg); !errors.Is(err, wantErr) {
		t.Fatalf("dispose 应返回清理错误：%v", err)
	}
	if err := fiber.Dispose(ctxBg); !errors.Is(err, wantErr) {
		t.Fatalf("重复 dispose 应观察相同错误：%v", err)
	}
	if disposeCalls != 1 {
		t.Fatalf("清理器应恰好执行 1 次，实际 %d 次", disposeCalls)
	}
	if got := countErrors(root); got != 1 {
		t.Fatalf("应恰好上报 1 条错误，实际 %d", got)
	}
}

// TestFiberUpdateConfigOnWrappedFiber 对应 'update config on wrapped fiber'：
// 每次 update 以新配置重载（TS 的 thenable 等待改写为 Await）。
func TestFiberUpdateConfigOnWrappedFiber(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var configs []any
	plugin := &Plugin{
		Apply: func(c *Context, config any) (Disposable, error) {
			configs = append(configs, config)
			return nil, nil
		},
	}
	fiber, err := root.Plugin(plugin, map[string]any{"msg": "hello"})
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if err := fiber.Update(ctxBg, map[string]any{"msg": "world"}, false); err != nil {
		t.Fatalf("update 失败：%v", err)
	}
	if err := fiber.Update(ctxBg, map[string]any{"msg": "!!!"}, false); err != nil {
		t.Fatalf("update 失败：%v", err)
	}
	want := []any{
		map[string]any{"msg": "hello"},
		map[string]any{"msg": "world"},
		map[string]any{"msg": "!!!"},
	}
	if len(configs) != len(want) {
		t.Fatalf("apply 应恰好执行 %d 次，实际 %d 次（%v）", len(want), len(configs), configs)
	}
	for i, cfg := range want {
		if !reflect.DeepEqual(configs[i], cfg) {
			t.Fatalf("第 %d 次配置不符：%v want %v", i+1, configs[i], cfg)
		}
	}
}

// TestFiberRestartWrappedFiber 对应 'restart wrapped fiber'：restart 重载一次；
// TS 的「wrapped 即 fiber 本身、无独立状态副本」断言在 Go 侧等价于注册表
// 持有的就是同一个 *Fiber。
func TestFiberRestartWrappedFiber(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	calls := 0
	plugin := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			calls++
			return nil, nil
		},
	}
	fiber, err := root.Plugin(plugin, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	if err := fiber.Restart(ctxBg); err != nil {
		t.Fatalf("restart 失败：%v", err)
	}
	if calls != 2 {
		t.Fatalf("apply 应恰好执行 2 次，实际 %d", calls)
	}
	assertState(t, fiber, FiberActive)
	runtime := root.Registry().Get(plugin)
	if runtime == nil {
		t.Fatal("插件运行时应已建档")
	}
	fibers := runtime.FiberSnapshot()
	if len(fibers) != 1 || fibers[0] != fiber {
		t.Fatalf("注册表持有的应就是 plugin() 返回的同一 fiber（wrapped 即 fiber 本身）")
	}
}

// specProvider 对应 'update config while injected service reloads' 的
// Provider 服务。
type specProvider struct {
	Service
	value int
}

// TestFiberUpdateWhileInjectedReloads 对应 'update config while injected
// service reloads'。TS 的两次 update 交错依赖 JS 微任务 FIFO；Go 并发模型下
// 改为串行调用并显式等待依赖刷新链收敛：首尾行为等价（首次 [1 old]、末次
// [2 new]），中间多一次依赖刷新触发的 [2 old] 重载（epoch 机制保证其读到
// 的一定是新实现）。
func TestFiberUpdateWhileInjectedReloads(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var applied [][2]any
	providerPlugin := &Plugin{
		Name: "Provider",
		Apply: func(c *Context, config any) (Disposable, error) {
			s := &specProvider{}
			s.Service = newTestService(c, "provider", s, nil)
			if m, ok := config.(map[string]int); ok {
				s.value = m["value"]
			}
			return nil, nil
		},
	}
	consumerPlugin := &Plugin{
		Name:   "Consumer",
		Inject: InjectMap{"provider": nil},
		Apply: func(c *Context, config any) (Disposable, error) {
			v, err := c.Get("provider")
			if err != nil {
				return nil, err
			}
			provider, ok := v.(*specProvider)
			if !ok {
				return nil, errors.New("provider 服务类型不符")
			}
			mode := ""
			if m, ok := config.(map[string]string); ok {
				mode = m["mode"]
			}
			applied = append(applied, [2]any{provider.value, mode})
			return nil, nil
		},
	}
	providerFiber, err := root.Plugin(providerPlugin, map[string]int{"value": 1})
	if err != nil {
		t.Fatalf("装载 Provider 失败：%v", err)
	}
	consumerFiber, err := root.Plugin(consumerPlugin, map[string]string{"mode": "old"})
	if err != nil {
		t.Fatalf("装载 Consumer 失败：%v", err)
	}
	if _, err := providerFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Provider 失败：%v", err)
	}
	if _, err := consumerFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Consumer 失败：%v", err)
	}
	if err := providerFiber.Update(ctxBg, map[string]int{"value": 2}, false); err != nil {
		t.Fatalf("更新 Provider 失败：%v", err)
	}
	if _, err := consumerFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待依赖刷新链收敛失败：%v", err)
	}
	if err := consumerFiber.Update(ctxBg, map[string]string{"mode": "new"}, false); err != nil {
		t.Fatalf("更新 Consumer 失败：%v", err)
	}
	want := [][2]any{{1, "old"}, {2, "old"}, {2, "new"}}
	if !reflect.DeepEqual(applied, want) {
		t.Fatalf("applied 序列不符：%v want %v", applied, want)
	}
	if !reflect.DeepEqual(consumerFiber.Config(), map[string]string{"mode": "new"}) {
		t.Fatalf("consumer 配置应为最新值：%v", consumerFiber.Config())
	}
	assertState(t, consumerFiber, FiberActive)
}

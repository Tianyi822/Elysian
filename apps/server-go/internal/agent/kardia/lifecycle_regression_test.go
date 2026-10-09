package kardia

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func lifecycleContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func awaitSignal(t *testing.T, ctx context.Context, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestEffectCancelledDisposeKeepsCleanup(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	expected := errors.New("清理失败")
	h, err := root.Scope().Iter("producer", func(lifetime context.Context, scope *EffectScope) error {
		close(started)
		<-lifetime.Done()
		<-release
		return scope.Defer(func(context.Context) error { calls.Add(1); return expected })
	})
	if err != nil {
		t.Fatal(err)
	}
	awaitSignal(t, ctx, started)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := h.Dispose(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消等待：%v", err)
	}
	close(release)
	if err := h.Dispose(ctx); !errors.Is(err, expected) {
		t.Fatalf("应共享清理错误：%v", err)
	}
	if err := h.Dispose(ctx); !errors.Is(err, expected) {
		t.Fatalf("重复清理结果：%v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("清理执行次数：%d", calls.Load())
	}
}

func TestEffectExplicitOwnershipDoesNotAdoptConcurrentResource(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	entered := make(chan struct{})
	h, err := root.Scope().Iter("producer", func(lifetime context.Context, scope *EffectScope) error {
		close(entered)
		<-lifetime.Done()
		return lifetime.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	awaitSignal(t, ctx, entered)
	var cleaned atomic.Int64
	other, err := root.Scope().Effect("independent", func() (Disposable, error) {
		return func(context.Context) error { cleaned.Add(1); return nil }, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if cleaned.Load() != 0 {
		t.Fatal("独立资源被其他生产者清理")
	}
	if got := root.Fiber().GetEffects(); len(got) != 1 || got[0].Label != "independent" {
		t.Fatalf("归属错误：%v", got)
	}
	if err := other.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if cleaned.Load() != 1 {
		t.Fatal("独立资源未清理")
	}
}

func TestOnceConcurrentClaim(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	start := make(chan struct{})
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	_, err := root.Once(StringEvent("claim"), func(*EventCtx) (any, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; _ = root.Emit(StringEvent("claim")) }()
	}
	close(start)
	awaitSignal(t, ctx, entered)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("Once执行%d次", calls.Load())
	}
}

func TestRestartCancelsLoadingGenerationAndRejectsOldRegistration(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	first := make(chan *Context, 1)
	var calls atomic.Int64
	var cleaned atomic.Int64
	f, err := root.Plugin(&Plugin{Apply: func(c *Context, _ any) (Disposable, error) {
		n := calls.Add(1)
		if n == 1 {
			first <- c
			<-c.Lifetime().Done()
		}
		return func(context.Context) error { cleaned.Add(1); return nil }, nil
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var old *Context
	select {
	case old = <-first:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := f.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || cleaned.Load() != 1 {
		t.Fatalf("激活=%d 清理=%d", calls.Load(), cleaned.Load())
	}
	if _, err := old.On(StringEvent("late"), noopListener); err == nil {
		t.Fatal("旧代仍能注册监听器")
	}
	if _, err := old.Plugin(&Plugin{Apply: func(*Context, any) (Disposable, error) { return nil, nil }}, nil); err == nil {
		t.Fatal("旧代仍能注册插件")
	}
	if root.Registry().Size() != 1 {
		t.Fatalf("失败注册泄漏运行时：%d", root.Registry().Size())
	}
	if err := f.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if cleaned.Load() != 2 {
		t.Fatal("新代未回收")
	}
}

type failingInitializer struct {
	cleanup Disposable
	failure error
}

func (s *failingInitializer) Init(context.Context) (Disposable, error) { return s.cleanup, s.failure }

type failingIterInitializer struct {
	cleanup Disposable
	failure error
}

func (s *failingIterInitializer) InitIter(ctx context.Context, yield func(Disposable) error) error {
	if err := yield(s.cleanup); err != nil {
		return err
	}
	return s.failure
}

func TestServicePluginInitializationFailureRollsBack(t *testing.T) {
	for _, iter := range []bool{false, true} {
		t.Run(map[bool]string{false: "return", true: "iter"}[iter], func(t *testing.T) {
			ctx := lifecycleContext(t)
			root := NewContext()
			failure := errors.New("初始化失败")
			var cleaned atomic.Int64
			p := ServicePlugin("service", nil, func(c *Context, _ any) (any, error) {
				cleanup := func(context.Context) error { cleaned.Add(1); return nil }
				var s any = &failingInitializer{cleanup, failure}
				if iter {
					s = &failingIterInitializer{cleanup, failure}
				}
				if _, err := c.Provide("value", s, nil); err != nil {
					return nil, err
				}
				return s, nil
			})
			f, err := root.Plugin(p, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.Await(ctx); !errors.Is(err, failure) {
				t.Fatalf("初始化错误不可见：%v", err)
			}
			if cleaned.Load() != 1 {
				t.Fatalf("资源未回滚：%d", cleaned.Load())
			}
			if v, err := root.Get("value"); err != nil || v != nil {
				t.Fatalf("失败服务仍存在：%v %v", v, err)
			}
			if err := f.Dispose(ctx); err != nil && !errors.Is(err, failure) {
				t.Fatal(err)
			}
		})
	}
}

func TestEffectCleanupAggregatesErrorsInReverseOrder(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	first, second := errors.New("一"), errors.New("二")
	var order []int
	h, err := root.Scope().Iter("errors", func(_ context.Context, s *EffectScope) error {
		if err := s.Defer(func(context.Context) error { order = append(order, 1); return first }); err != nil {
			return err
		}
		return s.Defer(func(context.Context) error { order = append(order, 2); return second })
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.Dispose(ctx); !errors.Is(err, first) || !errors.Is(err, second) {
		t.Fatalf("错误未汇总：%v", err)
	}
	if !reflect.DeepEqual(order, []int{2, 1}) {
		t.Fatalf("清理顺序：%v", order)
	}
}

func TestUpdateHooksBelongToActivation(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	var callbacks atomic.Int64
	f, err := root.Plugin(&Plugin{Apply: func(c *Context, _ any) (Disposable, error) {
		_, err := c.On(StringEvent("internal/update"), func(ev *EventCtx) (any, error) { callbacks.Add(1); return ev.Next() })
		return nil, err
	}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Await(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		if err := f.Update(ctx, i, false); err != nil {
			t.Fatal(err)
		}
	}
	if callbacks.Load() != 3 {
		t.Fatalf("旧激活钩子未释放：%d", callbacks.Load())
	}
	if err := f.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if f.hookList(StringEvent("internal/update")).Len() != 0 {
		t.Fatal("更新钩子泄漏")
	}
}

func TestServiceConfigMergePrecedence(t *testing.T) {
	root := NewContext()
	s := Service{Name: "sample"}
	c := root.Intercept("sample", map[string]any{"value": "outer", "outer": true}).Intercept("sample", map[string]any{"value": "inner", "inner": true})
	got, err := s.ResolveConfig(c, map[string]any{"value": "base", "base": true}, map[string]any{"value": "head"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"value": "head", "base": true, "outer": true, "inner": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("合并结果：%v", got)
	}
}

func TestDisposedChildrenReleaseParentRegistrations(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	parent, err := root.Scope().Effect("长寿命资源", func() (Disposable, error) { return nil, nil })
	if err != nil {
		t.Fatal(err)
	}
	var cleaned atomic.Int64
	for i := 0; i < 128; i++ {
		child, err := parent.Scope().Effect("短寿命资源", func() (Disposable, error) {
			return func(context.Context) error { cleaned.Add(1); return nil }, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := child.Dispose(ctx); err != nil {
			t.Fatal(err)
		}
	}
	root.mu.Lock()
	children, registrations := len(parent.state.children), len(parent.state.collected)
	retained := false
	for _, entry := range parent.state.collected[:cap(parent.state.collected)] {
		retained = retained || entry.child != nil || entry.fn != nil
	}
	root.mu.Unlock()
	if children != 0 || registrations != 0 || retained {
		t.Fatalf("父作用域仍持有已释放资源：子节点 %d，清理登记 %d，底层引用 %v", children, registrations, retained)
	}
	if err := parent.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if count := cleaned.Load(); count != 128 {
		t.Fatalf("清理执行次数 %d，期望 128", count)
	}
}

func TestStaleServiceCheckDoesNotOverwriteLatestDependency(t *testing.T) {
	ctx := lifecycleContext(t)
	root := NewContext()
	entered, release := make(chan struct{}), make(chan struct{})
	var blockNext atomic.Bool
	provider, err := root.Provide("checked", "旧值", func(*Context, any) (bool, error) {
		if blockNext.CompareAndSwap(true, false) {
			close(entered)
			<-release
		}
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	applied := make(chan any, 4)
	fiber, err := root.Inject([]string{"checked"}, func(c *Context, _ any) (Disposable, error) {
		value, err := c.Get("checked")
		if err == nil {
			applied <- value
		}
		return nil, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(ctx); err != nil {
		t.Fatal(err)
	}
	if value := awaitTestSignal(t, applied, "旧服务激活"); value != "旧值" {
		t.Fatal(value)
	}
	blockNext.Store(true)
	notified := make(chan error, 1)
	go func() { _, err := root.Reflect().Notify(root, []string{"checked"}); notified <- err }()
	awaitSignal(t, ctx, entered)
	if err := provider(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := root.Provide("checked", "新值", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(ctx); err != nil {
		t.Fatal(err)
	}
	if value := awaitTestSignal(t, applied, "新服务激活"); value != "新值" {
		t.Fatal(value)
	}
	close(release)
	if err := awaitTestSignal(t, notified, "旧检查退出"); err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(ctx); err != nil {
		t.Fatal(err)
	}
	fiber.mu.Lock()
	resolved := fiber.resolved["checked"]
	fiber.mu.Unlock()
	if resolved == nil || resolved.Value != "新值" {
		t.Fatalf("迟到检查覆盖新依赖：%+v", resolved)
	}
	if err := fiber.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	if value := awaitTestSignal(t, applied, "再次激活"); value != "新值" {
		t.Fatalf("再次激活使用过期依赖：%v", value)
	}
	if err := root.Fiber().Dispose(ctx); err != nil {
		t.Fatal(err)
	}
}

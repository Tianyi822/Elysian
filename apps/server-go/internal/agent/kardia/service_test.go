package kardia

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"testing"
)

// 对应 core/tests/service.spec.ts（5 个用例）。类插件改写为 Apply（构造 +
// 计数，方案 2.3）；TS 的 await sleep() 以「显式 Await 依赖 fiber」等价替换
// （确定性，不依赖真实时间）。

// pendingFoo 对应 'pending inject' 的 Foo：[Service.init] 等待 custom-event。
type pendingFoo struct {
	Service
}

func TestServicePendingInject(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	callbacks := 0

	injectFiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		callbacks++
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if callbacks != 0 {
		t.Fatalf("依赖未就绪时回调不应触发，得到 %d 次", callbacks)
	}

	registered := make(chan struct{})
	fooPlugin := &Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &pendingFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			// [Service.init]：阻塞等待 custom-event（监听挂本 fiber 的 ctx）。
			done := make(chan struct{})
			var once sync.Once
			c.On(StringEvent("custom-event"), func(ev *EventCtx) (any, error) {
				once.Do(func() { close(done) })
				return nil, nil
			})
			// fiber 的 Apply 在 goroutine 中异步执行：注册完成先发信号，
			// 主流程据此在事件发射前确定监听器已就位（等价 TS 的同步段）。
			close(registered)
			<-done
			return nil, nil
		},
	}
	fooFiber, err := root.Plugin(fooPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	<-registered
	// foo 的激活被 init 阻塞：事件未发出前回调不可能触发（等价 TS sleep 后断言 0）。
	if callbacks != 0 {
		t.Fatalf("init 未完成时回调不应触发，得到 %d 次", callbacks)
	}

	if err := root.Emit(StringEvent("custom-event")); err != nil {
		t.Fatalf("emit 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	if _, err := injectFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
	if callbacks != 1 {
		t.Fatalf("事件触发后回调应恰好执行 1 次，得到 %d 次", callbacks)
	}
}

// traceFoo 对应 'traceable effect' 两用例的 Foo：value/increase 经
// this.ctx.counter（Go 形态：CtxFor(access).Get("counter")）。
type traceFoo struct {
	Service
	err error
}

func (s *traceFoo) counterOf(access *Context) (*Counter, error) {
	v, err := s.CtxFor(access).Get("counter")
	if err != nil {
		return nil, err
	}
	counter, _ := v.(*Counter)
	if counter == nil {
		return nil, fmt.Errorf("counter 服务类型不符：%T", v)
	}
	return counter, nil
}

// Value 对应 TS 的 get value()。
func (s *traceFoo) Value(access *Context) int {
	counter, err := s.counterOf(access)
	if err != nil {
		s.err = err
		return -1
	}
	return counter.Value()
}

// Increase 对应 TS 的 increase()：effect 登记在访问点链的 fiber 上。
func (s *traceFoo) Increase(access *Context) {
	counter, err := s.counterOf(access)
	if err != nil {
		s.err = err
		return
	}
	counter.Increase(s.CtxFor(access))
}

func runTraceableEffect(t *testing.T, withInject bool) {
	t.Helper()
	ctxBg := context.Background()
	root := NewContext()

	if _, err := root.Provide("counter", nil, nil); err != nil {
		t.Fatalf("provide counter 失败：%v", err)
	}
	if err := root.Set("counter", NewCounter(root)); err != nil {
		t.Fatalf("set counter 失败：%v", err)
	}

	fooPlugin := &Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &traceFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}
	if withInject {
		fooPlugin.Inject = InjectMap{"counter": nil}
	}
	fooFiber, err := root.Plugin(fooPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}

	fooValue, err := root.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo, _ := fooValue.(*traceFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", fooValue)
	}

	foo.Increase(root)
	if got := foo.Value(root); got != 1 {
		t.Fatalf("第一次 increase 后 value 应为 1，得到 %d", got)
	}

	injectFiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		// TS: root.foo.increase() —— use site 是 root，effect 落 root fiber。
		foo.Increase(root)
		injectedValue, err := c.Get("foo")
		if err != nil {
			t.Errorf("注入 ctx 读取 foo 失败：%v", err)
			return nil, nil
		}
		injectedFoo, _ := injectedValue.(*traceFoo)
		if injectedFoo == nil {
			t.Errorf("注入 foo 类型不符：%T", injectedValue)
			return nil, nil
		}
		if got := injectedFoo.Value(c); got != 2 {
			t.Errorf("回调内 value 应为 2，得到 %d", got)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := injectFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
	if err := injectFiber.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 inject fiber 失败：%v", err)
	}

	foo.Increase(root)
	if got := foo.Value(root); got != 3 {
		t.Fatalf("销毁 inject fiber 后再 increase，value 应为 3，得到 %d", got)
	}
	if foo.err != nil {
		t.Errorf("解析过程不应出错：%v", foo.err)
	}
	if withInject {
		for _, m := range root.LoggerService().Messages() {
			if m.Type == "warn" {
				t.Errorf("with inject 场景不应产生告警：%v", m.Args)
			}
		}
	}
}

// TestServiceTraceableEffectWithInject 对应 'traceable effect (with inject)'。
func TestServiceTraceableEffectWithInject(t *testing.T) {
	runTraceableEffect(t, true)
}

// TestServiceTraceableEffectWithoutInject 对应 'traceable effect (without inject)'。
func TestServiceTraceableEffectWithoutInject(t *testing.T) {
	runTraceableEffect(t, false)
}

// TestServiceCompareSnapshot 对应 'compare snapshot'。
func TestServiceCompareSnapshot(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	testPlugin := &Plugin{
		Name: "Test",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &traceFoo{}
			s.Service = newTestService(c, "test", s, nil)
			if _, err := c.Inject([]string{"test"}, func(*Context, any) (Disposable, error) {
				return nil, nil
			}); err != nil {
				return nil, err
			}
			return nil, nil
		},
	}

	before := GetHookSnapshot(root)
	fiber, err := root.Plugin(testPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Test 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Test 失败：%v", err)
	}
	after := GetHookSnapshot(root)

	// 删除前收集 fiber，删除后显式等待其销毁（等价 TS 的 await sleep()）。
	runtime := root.Registry().Get(testPlugin)
	fibers := []*Fiber{}
	if runtime != nil {
		fibers = runtime.FiberSnapshot()
	}
	root.Registry().Delete(testPlugin)
	for _, f := range fibers {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 销毁失败：%v", err)
		}
	}
	if !reflect.DeepEqual(before, GetHookSnapshot(root)) {
		t.Fatalf("删除插件后钩子快照应回到 before：%v vs %v", before, GetHookSnapshot(root))
	}

	again, err := root.Plugin(testPlugin, nil)
	if err != nil {
		t.Fatalf("重新装载 Test 失败：%v", err)
	}
	if _, err := again.Await(ctxBg); err != nil {
		t.Fatalf("等待重新装载的 Test 失败：%v", err)
	}
	if !reflect.DeepEqual(after, GetHookSnapshot(root)) {
		t.Fatalf("重新装载后钩子快照应等于 after：%v vs %v", after, GetHookSnapshot(root))
	}
}

// TestServiceMultipleInjects 对应 'multiple injects'：init 计数挂在 Apply
// （fiber 激活体）内，依赖满足时恰好各执行一次。
func TestServiceMultipleInjects(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	fooCalls, barCalls, quxCalls := 0, 0, 0

	mk := func(name string, calls *int) func(c *Context, _ any) (Disposable, error) {
		return func(c *Context, _ any) (Disposable, error) {
			s := &traceFoo{}
			s.Service = newTestService(c, name, s, nil)
			*calls = *calls + 1
			return nil, nil
		}
	}

	fooPlugin := &Plugin{Name: "Foo", Inject: InjectMap{"qux": nil}, Apply: mk("foo", &fooCalls)}
	barPlugin := &Plugin{Name: "Bar", Inject: InjectMap{"foo": nil, "qux": nil}, Apply: mk("bar", &barCalls)}
	quxPlugin := &Plugin{Name: "Qux", Apply: mk("qux", &quxCalls)}

	fooFiber, err := root.Plugin(fooPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	barFiber, err := root.Plugin(barPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Bar 失败：%v", err)
	}
	if _, err := barFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Bar 失败：%v", err)
	}
	quxFiber, err := root.Plugin(quxPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Qux 失败：%v", err)
	}
	if _, err := quxFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Qux 失败：%v", err)
	}
	// TS 的 await sleep()：显式等待依赖 fiber 的刷新收敛。
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 激活失败：%v", err)
	}
	if _, err := barFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Bar 激活失败：%v", err)
	}

	if fooCalls != 1 || barCalls != 1 || quxCalls != 1 {
		t.Fatalf("各 init 应恰好执行 1 次：foo=%d bar=%d qux=%d", fooCalls, barCalls, quxCalls)
	}
}

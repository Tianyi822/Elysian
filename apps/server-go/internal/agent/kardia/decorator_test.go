package kardia

import (
	"context"
	"testing"
	"time"
)

// 对应 core/tests/decorator.spec.ts（1 个用例）：方法级 @Inject 装饰器映射
// 为 InjectMethod（方案 2.3 的装饰器映射）。断言「依赖就绪后回调恰好一次、
// 依赖消失后清理恰好一次」。回调以通道显式同步；watchdog 超时只作失败护栏。

type decoratorFoo struct {
	Service
}

type decoratorBar struct {
	Service
}

func TestDecoratorInjectOnClassMethod(t *testing.T) {
	ctxBg := context.Background()
	callbacks := 0
	disposed := 0
	ready := make(chan struct{})

	fooPlugin := &Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &decoratorFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}
	barPlugin := &Plugin{
		Name: "Bar",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &decoratorBar{}
			s.Service = newTestService(c, "bar", s, nil)
			// @Inject('foo') method()：宿主 fiber 激活时以注入就绪的 ctx 执行。
			InjectMethod(c, []string{"foo"}, func(injected *Context) (Disposable, error) {
				callbacks++
				close(ready)
				return func(context.Context) error {
					disposed++
					return nil
				}, nil
			})
			return nil, nil
		},
	}

	root := NewContext()
	barFiber, err := root.Plugin(barPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Bar 失败：%v", err)
	}
	if _, err := barFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Bar 失败：%v", err)
	}
	if callbacks != 0 || disposed != 0 {
		t.Fatalf("foo 未就绪时回调与清理都不应执行：callbacks=%d disposed=%d", callbacks, disposed)
	}

	fooFiber, err := root.Plugin(fooPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("foo 就绪后回调应被执行")
	}
	if callbacks != 1 {
		t.Fatalf("foo 就绪后回调应恰好执行 1 次，得到 %d 次", callbacks)
	}
	if disposed != 0 {
		t.Fatalf("foo 存续期间清理不应执行，得到 %d 次", disposed)
	}

	if err := fooFiber.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 Foo 失败：%v", err)
	}
	if callbacks != 1 {
		t.Fatalf("回调次数应保持 1，得到 %d 次", callbacks)
	}
	if disposed != 1 {
		t.Fatalf("依赖消失后清理应恰好执行 1 次，得到 %d 次", disposed)
	}
}

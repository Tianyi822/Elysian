package kardia

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 对应 core/tests/associate.spec.ts（6 个用例）。TS 的 `ctx.foo.bar` /
// `ctx['foo.bar']` 关联访问在 Go 统一经 ResolveAssociated；TS 的实例属性
// 取值（traceable getTrap）由 MixinSource 的 MixinInvoke 承载；TS 的
// `function(){return this}` 以返回服务实例的闭包承载（receiver 细节属
// 差异清单第 8 条）。

// assocFoo 对应 'service injection' 的 Foo（字段 qux=1）。
type assocFoo struct {
	Service
}

// MixinInvoke 实现 MixinSource：实例成员的按名取值。
func (s *assocFoo) MixinInvoke(_ *Context, key string) (any, error) {
	if key == "qux" {
		return 1, nil
	}
	return nil, nil
}

// assocFooBar 对应 'service injection' 的 FooBar（provide "foo.bar"）。
type assocFooBar struct {
	Service
}

// TestAssociateServiceInjection 对应 'service injection'：关联属性
// foo.qux 取实例成员；foo.bar 走声明的服务注入；fiber 销毁后失效。
func TestAssociateServiceInjection(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	fooFiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	fooBarFiber, err := root.Plugin(&Plugin{
		Name: "FooBar",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFooBar{}
			s.Service = newTestService(c, "foo.bar", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 FooBar 失败：%v", err)
	}
	if _, err := fooBarFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 FooBar 失败：%v", err)
	}

	fooValue, err := root.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo, _ := fooValue.(*assocFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", fooValue)
	}
	if qux, err := ResolveAssociated(root, "foo", "qux"); err != nil || qux != 1 {
		t.Fatalf("foo.qux 应为 1，实际 (%v, %v)", qux, err)
	}
	barValue, err := ResolveAssociated(root, "foo", "bar")
	if err != nil {
		t.Fatalf("读取 foo.bar 失败：%v", err)
	}
	if _, ok := barValue.(*assocFooBar); !ok {
		t.Fatalf("foo.bar 应是 FooBar 实例，实际 %T", barValue)
	}

	if err := fooBarFiber.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 FooBar 失败：%v", err)
	}
	v, err := root.Get("foo.bar")
	if err != nil {
		t.Fatalf("销毁后读取不应报错：%v", err)
	}
	if v != nil {
		t.Fatalf("销毁后 foo.bar 应为 nil，实际 %v", v)
	}
}

// assocPropFoo 对应 'property injection' 的 Foo。
type assocPropFoo struct {
	Service
	qux int
}

// MixinInvoke 实现 MixinSource：qux 与 baz（绑定函数）。
func (s *assocPropFoo) MixinInvoke(_ *Context, key string) (any, error) {
	switch key {
	case "qux":
		return s.qux, nil
	case "baz":
		// TS 的 function () { return this }：this 是访问视图，Go 以闭包
		// 显式携带服务实例（probe 验证 TS 断言 baz() instanceof Foo）。
		return func() any { return s }, nil
	}
	return nil, nil
}

// TestAssociatePropertyInjection 对应 'property injection'：声明的
// foo.bar/foo.baz 走受检路径；未声明的 foo.qux 按名访问报「未注入」错误。
func TestAssociatePropertyInjection(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	if _, err := root.Provide("foo.bar", nil, nil); err != nil {
		t.Fatalf("声明 foo.bar 失败：%v", err)
	}
	if _, err := root.Provide("foo.baz", nil, nil); err != nil {
		t.Fatalf("声明 foo.baz 失败：%v", err)
	}
	fooFiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocPropFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	fooValue, _ := root.Get("foo")
	foo, _ := fooValue.(*assocPropFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", fooValue)
	}
	foo.qux = 2
	if err := root.Set("foo.bar", 3); err != nil {
		t.Fatalf("设置 foo.bar 失败：%v", err)
	}
	// TS 的 root.foo.baz = function(){...} 经 traceable set 落实例字段；
	// Go 侧 provide 声明的属性经 Set 写入实现值（同 fiber 约束下等价）。
	if err := root.Set("foo.baz", func() any { return foo }); err != nil {
		t.Fatalf("设置 foo.baz 失败：%v", err)
	}

	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		if qux, err := ResolveAssociated(c, "foo", "qux"); err != nil || qux != 2 {
			t.Errorf("注入 ctx 上 foo.qux 应为 2，实际 (%v, %v)", qux, err)
		}
		if bar, err := ResolveAssociated(c, "foo", "bar"); err != nil || bar != 3 {
			t.Errorf("注入 ctx 上 foo.bar 应为 3，实际 (%v, %v)", bar, err)
		}
		if _, err := c.Get("foo.qux"); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "foo.qux"`) {
			t.Errorf("ctx['foo.qux'] 应报未注入错误，实际 %v", err)
		}
		if v, err := c.Get("foo.bar"); err != nil || v != 3 {
			t.Errorf("ctx['foo.bar'] 应为 3，实际 (%v, %v)", v, err)
		}
		bazValue, err := ResolveAssociated(c, "foo", "baz")
		if err != nil {
			t.Errorf("读取 foo.baz 失败：%v", err)
			return nil, nil
		}
		baz, ok := bazValue.(func() any)
		if !ok {
			t.Errorf("foo.baz 应为可调用形态，实际 %T", bazValue)
			return nil, nil
		}
		if self := baz(); self != foo {
			t.Errorf("foo.baz() 应返回 Foo 实例，实际 %v", self)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
}

// assocSession 对应关联类型用例的 Session（tracker associate 'session'）。
type assocSession struct {
	Ctx *Context
}

// assocFooWithCreate 对应 'associated type - service injection' 的 Foo。
type assocFooWithCreate struct {
	Service
}

// CreateSession 对应 createSession()：new Session(this.ctx)。
func (s *assocFooWithCreate) CreateSession(access *Context) *assocSession {
	return &assocSession{Ctx: s.CtxFor(access)}
}

// assocBarWithMixin 对应 Bar（inject foo；mixin 'bar' 的 answer 成员到
// 'session.answer'）。
type assocBarWithMixin struct {
	Service
}

// Answer 对应 answer(): 42。
func (s *assocBarWithMixin) Answer(_ *Context) int { return 42 }

// TestAssociateServiceTypeInjection 对应 'associated type - service
// injection'：'session.answer' 声明为 Bar 服务的成员 accessor；Bar 装载后
// 关联访问取得绑定函数。
func TestAssociateServiceTypeInjection(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	fooFiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFooWithCreate{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	fooValue, _ := root.Get("foo")
	foo, _ := fooValue.(*assocFooWithCreate)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", fooValue)
	}

	barPlugin := &Plugin{
		Name:   "Bar",
		Inject: InjectMap{"foo": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocBarWithMixin{}
			s.Service = newTestService(c, "bar", s, nil)
			// 对应 ctx.mixin('bar', { answer: 'session.answer' })：以
			// accessor 显式注册改名映射（Go 的 Mixin 仅列表形态）。
			_, err := c.Reflect().Accessor(c, "session.answer", Accessor{
				Get: func(rc *Context, _ error) (any, error) {
					v, err := rc.Get("bar")
					if err != nil {
						return nil, err
					}
					bar, _ := v.(*assocBarWithMixin)
					if bar == nil {
						return nil, fmt.Errorf("bar 服务类型不符：%T", v)
					}
					return func(access *Context) int { return bar.Answer(access) }, nil
				},
			})
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}

	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		session := foo.CreateSession(c)
		if session == nil {
			t.Errorf("createSession 应返回 Session 实例")
			return nil, nil
		}
		// TS 的关联宿主是 tracker 实例（非服务，bar 直接从实例取）；Go 的
		// ResolveAssociated 按名解析 associate，故以 Provide 显式登记实例
		// 承载（见 localGaps）。Session 无 bar 成员 → 解析得 nil。
		if _, err := c.Provide("session", session, nil); err != nil {
			t.Errorf("provide session 失败：%v", err)
			return nil, nil
		}
		if bar, err := ResolveAssociated(c, "session", "bar"); err != nil || bar != nil {
			t.Errorf("Bar 装载前 session.bar 应为 nil，实际 (%v, %v)", bar, err)
		}

		barFiber, err := c.Plugin(barPlugin, nil)
		if err != nil {
			t.Errorf("装载 Bar 失败：%v", err)
			return nil, nil
		}
		if _, err := barFiber.Await(ctxBg); err != nil {
			t.Errorf("等待 Bar 失败：%v", err)
			return nil, nil
		}
		inner, err := c.Inject([]string{"bar"}, func(c2 *Context, _ any) (Disposable, error) {
			answerValue, err := ResolveAssociated(c2, "session", "answer")
			if err != nil {
				t.Errorf("读取 session.answer 失败：%v", err)
				return nil, nil
			}
			answer, ok := answerValue.(func(*Context) int)
			if !ok {
				t.Errorf("session.answer 应为绑定函数，实际 %T", answerValue)
				return nil, nil
			}
			if got := answer(c2); got != 42 {
				t.Errorf("session.answer() 应为 42，实际 %d", got)
			}
			return nil, nil
		})
		if err != nil {
			t.Errorf("inject bar 失败：%v", err)
			return nil, nil
		}
		if _, err := inner.Await(ctxBg); err != nil {
			t.Errorf("等待 inject bar 失败：%v", err)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
}

// TestAssociateAccessorInjection 对应 'associated type - accessor
// injection'。TS 的 ctx.mixin(this, {...}) 以对象为源：ctx[source] 解析为
// "[object Object]" 键且无实现，get 恒失败；且 'bar' 服务从未提供，
// inject(['bar']) 恒 pending（回调不执行；TS 的 await 挂起 fiber 立即
// resolve）。以上行为经 bun 探针对照 TS 实测确认。
func TestAssociateAccessorInjection(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	fooFiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFooWithCreate{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fooFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	fooValue, _ := root.Get("foo")
	foo, _ := fooValue.(*assocFooWithCreate)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", fooValue)
	}

	barFiber, err := root.Plugin(&Plugin{
		Name: "Bar",
		Apply: func(c *Context, _ any) (Disposable, error) {
			_, err := c.Reflect().Accessor(c, "session.bar", Accessor{
				Get: func(rc *Context, _ error) (any, error) {
					// 对应 TS mixin 以对象为源时 ctx[source] 的解析失败
					return rc.Get("[object Object]")
				},
				Set: func(_ *Context, _ any, _ error) (bool, error) {
					return false, errors.New("源服务未提供，无法设置关联属性")
				},
			})
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Bar 失败：%v", err)
	}
	if _, err := barFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Bar 失败：%v", err)
	}

	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		session := foo.CreateSession(c)
		if session == nil {
			t.Errorf("session() 应返回 Session 实例")
			return nil, nil
		}
		if _, err := ResolveAssociated(c, "session", "bar"); err == nil || !strings.Contains(err.Error(), "[object Object]") {
			t.Errorf("session.bar 应解析失败，实际 %v", err)
		}

		injectCalls := 0
		pending, err := c.Inject([]string{"bar"}, func(*Context, any) (Disposable, error) {
			injectCalls++
			return nil, nil
		})
		if err != nil {
			t.Errorf("inject bar 失败：%v", err)
			return nil, nil
		}
		// 与 TS 一致：pending fiber 的 await 立即返回、回调不执行。
		if _, err := pending.Await(ctxBg); err != nil {
			t.Errorf("pending fiber 的 Await 不应报错：%v", err)
		}
		if injectCalls != 0 {
			t.Errorf("bar 服务永不存在，回调不应执行，实际 %d 次", injectCalls)
		}
		if pending.State() != FiberPending {
			t.Errorf("inject bar 的 fiber 应恒为 PENDING，实际 %s", pending.State())
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
}

// assocFooSimple / assocFooBarHello / assocBaz / assocQux 对应
// 'associated access follows the service fiber' 的四个服务。
type assocFooSimple struct {
	Service
}

type assocFooBarHello struct {
	Service
}

// Hello 对应 hello(): 'bar'。
func (s *assocFooBarHello) Hello() string { return "bar" }

// probeFooBar 是 Baz/Qux 共有的 foo.bar 探测体。
func probeFooBar(use *Context) (string, error) {
	v, err := ResolveAssociated(use, "foo", "bar")
	if err != nil {
		return "", err
	}
	fb, _ := v.(*assocFooBarHello)
	if fb == nil {
		return "", fmt.Errorf("foo.bar 服务类型不符：%T", v)
	}
	return fb.Hello(), nil
}

type assocBaz struct {
	Service
}

// Probe 对应 probe()：this.ctx.foo.bar.hello()。
func (s *assocBaz) Probe(access *Context) (string, error) {
	return probeFooBar(s.CtxFor(access))
}

type assocQux struct {
	Service
}

// Probe 对应 probe()。
func (s *assocQux) Probe(access *Context) (string, error) {
	return probeFooBar(s.CtxFor(access))
}

// TestAssociateAccessFollowsServiceFiber 对应 'associated access follows
// the service fiber'：ctx.foo.bar 与 ctx['foo.bar'] 由同一 fiber 支配——
// 即运行访问的服务，而非调用方。
func TestAssociateAccessFollowsServiceFiber(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	fooFiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFooSimple{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	fooBarFiber, err := root.Plugin(&Plugin{
		Name: "FooBar",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocFooBarHello{}
			s.Service = newTestService(c, "foo.bar", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 FooBar 失败：%v", err)
	}
	bazFiber, err := root.Plugin(&Plugin{
		Name:   "Baz",
		Inject: InjectMap{"foo": nil, "foo.bar": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocBaz{}
			s.Service = newTestService(c, "baz", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Baz 失败：%v", err)
	}
	quxFiber, err := root.Plugin(&Plugin{
		Name:   "Qux",
		Inject: InjectMap{"foo": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocQux{}
			s.Service = newTestService(c, "qux", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Qux 失败：%v", err)
	}
	for _, f := range []*Fiber{fooFiber, fooBarFiber, bazFiber, quxFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	bazValue, _ := root.Get("baz")
	baz, _ := bazValue.(*assocBaz)
	quxValue, _ := root.Get("qux")
	qux, _ := quxValue.(*assocQux)
	if baz == nil || qux == nil {
		t.Fatalf("服务类型不符：baz=%T qux=%T", bazValue, quxValue)
	}

	if got, err := baz.Probe(root); err != nil || got != "bar" {
		t.Fatalf("baz.probe() 应为 bar，实际 (%v, %v)", got, err)
	}
	if _, err := qux.Probe(root); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "foo.bar"`) {
		t.Fatalf("qux.probe() 应报未注入错误，实际 %v", err)
	}

	fiber, err := root.Inject([]string{"baz", "qux"}, func(c *Context, _ any) (Disposable, error) {
		bv, _ := c.Get("baz")
		qv, _ := c.Get("qux")
		b, _ := bv.(*assocBaz)
		q, _ := qv.(*assocQux)
		if b == nil || q == nil {
			t.Errorf("注入 ctx 服务类型不符：%T %T", bv, qv)
			return nil, nil
		}
		if got, err := b.Probe(c); err != nil || got != "bar" {
			t.Errorf("注入 ctx 内 baz.probe() 应为 bar，实际 (%v, %v)", got, err)
		}
		if _, err := q.Probe(c); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "foo.bar"`) {
			t.Errorf("注入 ctx 内 qux.probe() 应报未注入错误，实际 %v", err)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
}

// assocInspectFoo 对应 'inspect'（cordiverse/cordis#14）的 Foo：两级方法
// 透传参数。TS 断言 arg.toString() 含 'class X'；Go 以类型名断言承载。
type assocInspectFoo struct {
	Service
}

// Bar 对应 bar(arg)。
func (s *assocInspectFoo) Bar(access *Context, arg any) error {
	if !strings.Contains(fmt.Sprintf("%T", arg), "X") {
		return fmt.Errorf("参数应保留类型信息，实际 %T", arg)
	}
	return s.Baz(access, arg)
}

// Baz 对应 baz(arg)。
func (s *assocInspectFoo) Baz(_ *Context, arg any) error {
	if !strings.Contains(fmt.Sprintf("%T", arg), "X") {
		return fmt.Errorf("参数应保留类型信息，实际 %T", arg)
	}
	return nil
}

// assocInspectX 是透传的类型值（TS 的 class X）。
type assocInspectX struct {
	Mark int
}

// TestAssociateInspect 对应 'inspect'：服务方法透传参数不受影子机制干扰。
func TestAssociateInspect(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	fiber, err := root.Plugin(&Plugin{
		Name: "Foo",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &assocInspectFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	v, err := root.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo, _ := v.(*assocInspectFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", v)
	}
	if err := foo.Bar(root, assocInspectX{}); err != nil {
		t.Fatalf("foo.bar(X) 不应失败：%v", err)
	}
}

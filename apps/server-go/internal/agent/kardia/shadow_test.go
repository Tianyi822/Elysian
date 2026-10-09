package kardia

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// 对应 core/tests/shadow.spec.ts（7 个用例）。caller/shadow 断言经
// access.DefSite() 与 CtxFor(access).DefSite()（方案 2.1 规则 2）；影子
// 深度沿 ShadowSite() 链计数。TS 的 noShadow 用例断言
// this.ctx[symbols.shadow]===undefined，Go 以「CtxFor(access)==access
// （不叠加影子层）+ caller 指针等价」承载（原型链 receiver 细节无 Go
// 等价，差异清单第 8 条，见 localGaps）。

// shadowInner 对应 Inner（caller/shadow 元数据用例）。
type shadowInner struct {
	Service
}

// Inspect 对应 inspect()：{caller: this[symbols.caller], shadow:
// this.ctx[symbols.shadow]}。
func (s *shadowInner) Inspect(access *Context) (caller, shadow *Context) {
	return access.DefSite(), s.CtxFor(access).DefSite()
}

// shadowOuterWithInner 对应 Outer（inject inner）。
type shadowOuterWithInner struct {
	Service
}

// Inspect 对应 inspect()：转发 inner.inspect() 并附 outerShadow。
func (s *shadowOuterWithInner) Inspect(access *Context) (caller, shadow, outerShadow *Context) {
	shadowCtx := s.CtxFor(access)
	v, err := shadowCtx.Get("inner")
	if err != nil {
		return nil, nil, nil
	}
	inner, ok := v.(*shadowInner)
	if !ok {
		return nil, nil, nil
	}
	caller, shadow = inner.Inspect(shadowCtx)
	return caller, shadow, shadowCtx.DefSite()
}

// TestShadowCallerMetadata 对应 'keeps caller metadata separate from the
// service shadow'：caller 取访问方 def site（外层服务），shadow 取自身
// 服务 def site，两者互不混淆；从 root 直调同样成立。
func TestShadowCallerMetadata(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var innerOrigin, outerOrigin *Context
	innerFiber, err := root.Plugin(&Plugin{
		Name: "Inner",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowInner{}
			s.Service = newTestService(c, "inner", s, nil)
			innerOrigin = c
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Inner 失败：%v", err)
	}
	outerFiber, err := root.Plugin(&Plugin{
		Name:   "Outer",
		Inject: InjectMap{"inner": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowOuterWithInner{}
			s.Service = newTestService(c, "outer", s, nil)
			outerOrigin = c
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	for _, f := range []*Fiber{innerFiber, outerFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("outer")
		if err != nil {
			t.Errorf("读取 outer 失败：%v", err)
			return nil, nil
		}
		outer, _ := v.(*shadowOuterWithInner)
		if outer == nil {
			t.Errorf("outer 服务类型不符：%T", v)
			return nil, nil
		}
		caller, shadow, outerShadow := outer.Inspect(c)
		if caller != outerOrigin {
			t.Errorf("caller 应为 outer 构造 ctx")
		}
		if shadow != innerOrigin {
			t.Errorf("shadow 应为 inner 构造 ctx")
		}
		if outerShadow != outerOrigin {
			t.Errorf("outerShadow 应为 outer 构造 ctx")
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}

	// 从 root 访问不得坍缩影子
	v, err := root.Get("outer")
	if err != nil {
		t.Fatalf("读取 outer 失败：%v", err)
	}
	outer, _ := v.(*shadowOuterWithInner)
	if outer == nil {
		t.Fatalf("outer 服务类型不符：%T", v)
	}
	caller, shadow, outerShadow := outer.Inspect(root)
	if caller != outerOrigin {
		t.Errorf("root 直调：caller 应为 outer 构造 ctx，实际 %v", caller)
	}
	if shadow != innerOrigin {
		t.Errorf("root 直调：shadow 应为 inner 构造 ctx，实际 %v", shadow)
	}
	if outerShadow != outerOrigin {
		t.Errorf("root 直调：outerShadow 应为 outer 构造 ctx，实际 %v", outerShadow)
	}
}

// shadowInnerHello 对应 'applies the service inject' 的 Inner。
type shadowInnerHello struct {
	Service
}

// Hello 对应 hello()。
func (s *shadowInnerHello) Hello() string { return "hello" }

// shadowOuterNoInject 对应 Outer（刻意不注入 inner）。
type shadowOuterNoInject struct {
	Service
}

// Probe 对应 probe()：this.ctx['inner'].hello()。
func (s *shadowOuterNoInject) Probe(access *Context) (string, error) {
	v, err := s.CtxFor(access).Get("inner")
	if err != nil {
		return "", err
	}
	inner, ok := v.(*shadowInnerHello)
	if !ok {
		return "", fmt.Errorf("inner 服务类型不符：%T", v)
	}
	return inner.Hello(), nil
}

// TestShadowAppliesServiceInjectFromRoot 对应 'applies the service inject
// when entered from root'：无论从 root 直调还是注入 ctx 内调用，未声明
// inject 的服务取不到依赖。
func TestShadowAppliesServiceInjectFromRoot(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	innerFiber, err := root.Plugin(&Plugin{
		Name: "Inner",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowInnerHello{}
			s.Service = newTestService(c, "inner", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Inner 失败：%v", err)
	}
	outerFiber, err := root.Plugin(&Plugin{
		Name: "Outer",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowOuterNoInject{}
			s.Service = newTestService(c, "outer", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	for _, f := range []*Fiber{innerFiber, outerFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	v, err := root.Get("outer")
	if err != nil {
		t.Fatalf("读取 outer 失败：%v", err)
	}
	outer, _ := v.(*shadowOuterNoInject)
	if outer == nil {
		t.Fatalf("outer 服务类型不符：%T", v)
	}
	if _, err := outer.Probe(root); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "inner"`) {
		t.Fatalf("root 直调应报未注入错误，实际 %v", err)
	}

	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		cv, err := c.Get("outer")
		if err != nil {
			t.Errorf("读取 outer 失败：%v", err)
			return nil, nil
		}
		o, _ := cv.(*shadowOuterNoInject)
		if o == nil {
			t.Errorf("outer 服务类型不符：%T", cv)
			return nil, nil
		}
		if _, err := o.Probe(c); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "inner"`) {
			t.Errorf("注入 ctx 内调用应报未注入错误，实际 %v", err)
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

// shadowHolder 对应 'resolves dependencies through a captured shadow'
// 的 Holder：捕获服务的 this.ctx 的普通对象。
type shadowHolder struct {
	Ctx *Context
}

// Probe 对应 probe()：[this.ctx['outer'].tag(), this.ctx['inner'].hello()]。
func (h *shadowHolder) Probe() ([2]string, error) {
	outerV, err := h.Ctx.Get("outer")
	if err != nil {
		return [2]string{}, err
	}
	outer, ok := outerV.(*shadowOuterWithHolder)
	if !ok {
		return [2]string{}, fmt.Errorf("outer 服务类型不符：%T", outerV)
	}
	innerV, err := h.Ctx.Get("inner")
	if err != nil {
		return [2]string{}, err
	}
	inner, ok := innerV.(*shadowInnerHello)
	if !ok {
		return [2]string{}, fmt.Errorf("inner 服务类型不符：%T", innerV)
	}
	return [2]string{outer.Tag(), inner.Hello()}, nil
}

// Depth 对应 depth()：沿 symbols.shadow 链计数（Go 的 ShadowSite 链）。
func (h *shadowHolder) Depth() int {
	depth := 0
	cursor := h.Ctx
	for cursor != nil && cursor.ShadowSite() != nil {
		depth++
		cursor = cursor.ShadowSite()
	}
	return depth
}

// shadowOuterWithHolder 对应 Outer（inject inner；create 返回 Holder）。
type shadowOuterWithHolder struct {
	Service
}

// Tag 对应 tag()。
func (s *shadowOuterWithHolder) Tag() string { return "outer" }

// Create 对应 create()：new Holder(this.ctx)。
func (s *shadowOuterWithHolder) Create(access *Context) *shadowHolder {
	return &shadowHolder{Ctx: s.CtxFor(access)}
}

// TestShadowCapturedShadow 对应 'resolves dependencies through a captured
// shadow'：Holder 自身的 ctx 是影子，但依赖沿它解析可行，且影子深度恰为 1。
func TestShadowCapturedShadow(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	innerFiber, err := root.Plugin(&Plugin{
		Name: "Inner",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowInnerHello{}
			s.Service = newTestService(c, "inner", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Inner 失败：%v", err)
	}
	outerFiber, err := root.Plugin(&Plugin{
		Name:   "Outer",
		Inject: InjectMap{"inner": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowOuterWithHolder{}
			s.Service = newTestService(c, "outer", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	for _, f := range []*Fiber{innerFiber, outerFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	getOuter := func(c *Context) *shadowOuterWithHolder {
		v, err := c.Get("outer")
		if err != nil {
			t.Fatalf("读取 outer 失败：%v", err)
		}
		outer, _ := v.(*shadowOuterWithHolder)
		if outer == nil {
			t.Fatalf("outer 服务类型不符：%T", v)
		}
		return outer
	}

	probe, err := getOuter(root).Create(root).Probe()
	if err != nil {
		t.Fatalf("root 直调 probe 失败：%v", err)
	}
	if probe != [2]string{"outer", "hello"} {
		t.Fatalf("root 直调 probe 应为 [outer hello]，实际 %v", probe)
	}
	if depth := getOuter(root).Create(root).Depth(); depth != 1 {
		t.Fatalf("root 直调影子深度应为 1，实际 %d", depth)
	}

	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		probe, err := getOuter(c).Create(c).Probe()
		if err != nil {
			t.Errorf("注入 ctx 内 probe 失败：%v", err)
			return nil, nil
		}
		if probe != [2]string{"outer", "hello"} {
			t.Errorf("注入 ctx 内 probe 应为 [outer hello]，实际 %v", probe)
		}
		if depth := getOuter(c).Create(c).Depth(); depth != 1 {
			t.Errorf("注入 ctx 内影子深度应为 1，实际 %d", depth)
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

// shadowRooted 对应 'keeps unchecked access for services provided on the
// root ctx' 的 Rooted（tracker property 'ctx'，在根上提供、永不声明 inject）。
type shadowRooted struct {
	Ctx *Context
}

// Probe 对应 probe()：this.ctx['inner'].hello()（不受检路径）。
func (s *shadowRooted) Probe() (string, error) {
	v, err := s.Ctx.Get("inner")
	if err != nil {
		return "", err
	}
	inner, ok := v.(*shadowInnerHello)
	if !ok {
		return "", fmt.Errorf("inner 服务类型不符：%T", v)
	}
	return inner.Hello(), nil
}

// TestShadowUncheckedAccessOnRoot 对应 'keeps unchecked access for
// services provided on the root ctx'：根 ctx 上的持有者按未受检路径取依赖。
func TestShadowUncheckedAccessOnRoot(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	innerFiber, err := root.Plugin(&Plugin{
		Name: "Inner",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowInnerHello{}
			s.Service = newTestService(c, "inner", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Inner 失败：%v", err)
	}
	if _, err := innerFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Inner 失败：%v", err)
	}
	if _, err := root.Provide("rooted", &shadowRooted{Ctx: root}, nil); err != nil {
		t.Fatalf("provide rooted 失败：%v", err)
	}

	v, err := root.Get("rooted")
	if err != nil {
		t.Fatalf("读取 rooted 失败：%v", err)
	}
	rooted, _ := v.(*shadowRooted)
	if rooted == nil {
		t.Fatalf("rooted 类型不符：%T", v)
	}
	if got, err := rooted.Probe(); err != nil || got != "hello" {
		t.Fatalf("rooted.probe() 应为 hello，实际 (%v, %v)", got, err)
	}
}

// shadowProbeNoShadow 对应 noShadow 的 Probe（tracker noShadow:true）。
type shadowProbeNoShadow struct {
	Service
}

// Inspect 对应 inspect()：{caller: this[symbols.caller], shadow:
// this.ctx[symbols.shadow]}。Go 落点：caller=access.DefSite()；shadow 的
// 「无影子」语义以 CtxFor(access)==access（不叠加影子层）承载。
func (s *shadowProbeNoShadow) Inspect(access *Context) (caller *Context, noShadowLayer bool) {
	return access.DefSite(), s.CtxFor(access) == access
}

// shadowOuterWithProbe 对应 Outer（inject probe）。
type shadowOuterWithProbe struct {
	Service
}

// Inspect 对应 inspect()：转发 probe.inspect()。
func (s *shadowOuterWithProbe) Inspect(access *Context) (caller *Context, noShadowLayer bool) {
	shadowCtx := s.CtxFor(access)
	v, err := shadowCtx.Get("probe")
	if err != nil {
		return nil, false
	}
	probe, ok := v.(*shadowProbeNoShadow)
	if !ok {
		return nil, false
	}
	return probe.Inspect(shadowCtx)
}

// TestShadowNoShadowServiceCaller 对应 'exposes the caller without
// preserving shadow for noShadow services'：caller 暴露且调用链影子不被
// 保留到方法内。
func TestShadowNoShadowServiceCaller(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var outerOrigin *Context
	probe := &shadowProbeNoShadow{}
	probe.Service = Service{
		Ctx:     root,
		Name:    "probe",
		Tracker: Tracker{Property: "ctx", NoShadow: true},
	}
	if _, err := root.Provide("probe", probe, nil); err != nil {
		t.Fatalf("provide probe 失败：%v", err)
	}
	outerFiber, err := root.Plugin(&Plugin{
		Name:   "Outer",
		Inject: InjectMap{"probe": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowOuterWithProbe{}
			s.Service = newTestService(c, "outer", s, nil)
			outerOrigin = c
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	if _, err := outerFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Outer 失败：%v", err)
	}

	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("outer")
		if err != nil {
			t.Errorf("读取 outer 失败：%v", err)
			return nil, nil
		}
		outer, _ := v.(*shadowOuterWithProbe)
		if outer == nil {
			t.Errorf("outer 服务类型不符：%T", v)
			return nil, nil
		}
		caller, noShadowLayer := outer.Inspect(c)
		if caller != outerOrigin {
			t.Errorf("caller 应为 outer 构造 ctx，实际 %v", caller)
		}
		if !noShadowLayer {
			t.Errorf("noShadow 服务的 CtxFor 不应叠加影子层")
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

// shadowCallable 对应 'exposes the caller to callable services' 的
// Callable（invoke 返回 caller）。
type shadowCallable struct {
	Service
}

// InvokeC 实现 Caller（对应 [Service.invoke] 返回 this[symbols.caller]）。
func (s *shadowCallable) InvokeC(caller *Context, _ []any) (any, error) {
	return caller, nil
}

// shadowOuterCall 对应 Outer（inject callable）。
type shadowOuterCall struct {
	Service
}

// Call 对应 call()：this.ctx['callable']()（thisArg 链上的 caller 传递）。
func (s *shadowOuterCall) Call(access *Context) (*Context, error) {
	v, err := s.CtxFor(access).Call("callable")
	if err != nil {
		return nil, err
	}
	caller, ok := v.(*Context)
	if !ok {
		return nil, fmt.Errorf("callable 应返回 Context，实际 %T", v)
	}
	return caller, nil
}

// TestShadowCallerToCallableServices 对应 'exposes the caller to callable
// services'：可调用服务收到调用方的 def site。
func TestShadowCallerToCallableServices(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var outerOrigin *Context
	callableFiber, err := root.Plugin(&Plugin{
		Name: "Callable",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowCallable{}
			s.Service = newTestService(c, "callable", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Callable 失败：%v", err)
	}
	outerFiber, err := root.Plugin(&Plugin{
		Name:   "Outer",
		Inject: InjectMap{"callable": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowOuterCall{}
			s.Service = newTestService(c, "outer", s, nil)
			outerOrigin = c
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	for _, f := range []*Fiber{callableFiber, outerFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("outer")
		if err != nil {
			t.Errorf("读取 outer 失败：%v", err)
			return nil, nil
		}
		outer, _ := v.(*shadowOuterCall)
		if outer == nil {
			t.Errorf("outer 服务类型不符：%T", v)
			return nil, nil
		}
		caller, err := outer.Call(c)
		if err != nil {
			t.Errorf("outer.call() 失败：%v", err)
			return nil, nil
		}
		if caller != outerOrigin {
			t.Errorf("callable 的 caller 应为 outer 构造 ctx，实际 %v", caller)
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

// shadowLoaderSvc 对应 'strips service shadow before creating plugins'
// 的 Loader。
type shadowLoaderSvc struct {
	Service
}

// Load 对应 load(plugin)：this.ctx.plugin(plugin)——按方案 2.1 规则 5，
// 注册一律在 use-site 链的 ctx 上（不套 CtxFor）。
func (s *shadowLoaderSvc) Load(access *Context, p *Plugin) (*Fiber, error) {
	return access.Plugin(p, nil)
}

// shadowServer 对应 Server。
type shadowServer struct {
	Service
}

// TestShadowStripsShadowBeforePlugins 对应 'strips service shadow before
// creating plugins'：服务内经 use-site ctx 注册的插件其注入正常挂载，
// 全程无错误日志。
func TestShadowStripsShadowBeforePlugins(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	loaderFiber, err := root.Plugin(&Plugin{
		Name: "Loader",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowLoaderSvc{}
			s.Service = newTestService(c, "loader", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Loader 失败：%v", err)
	}
	if _, err := loaderFiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Loader 失败：%v", err)
	}

	serverPlugin := &Plugin{
		Name: "Server",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &shadowServer{}
			s.Service = newTestService(c, "server", s, nil)
			return nil, nil
		},
	}
	injected := false
	consumerPlugin := &Plugin{
		Name: "Consumer",
		Apply: func(c *Context, _ any) (Disposable, error) {
			_, err := c.Inject([]string{"server"}, func(c2 *Context, _ any) (Disposable, error) {
				v, err := c2.Get("server")
				if err != nil {
					t.Errorf("读取 server 失败：%v", err)
					return nil, nil
				}
				_, injected = v.(*shadowServer)
				return nil, nil
			})
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}

	fiber, err := root.Inject([]string{"loader"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("loader")
		if err != nil {
			t.Errorf("读取 loader 失败：%v", err)
			return nil, nil
		}
		loader, _ := v.(*shadowLoaderSvc)
		if loader == nil {
			t.Errorf("loader 服务类型不符：%T", v)
			return nil, nil
		}
		serverFiber, err := loader.Load(c, serverPlugin)
		if err != nil {
			t.Errorf("load Server 失败：%v", err)
			return nil, nil
		}
		if _, err := serverFiber.Await(ctxBg); err != nil {
			t.Errorf("等待 Server 失败：%v", err)
			return nil, nil
		}
		consumerFiber, err := loader.Load(c, consumerPlugin)
		if err != nil {
			t.Errorf("load Consumer 失败：%v", err)
			return nil, nil
		}
		if _, err := consumerFiber.Await(ctxBg); err != nil {
			t.Errorf("等待 Consumer 失败：%v", err)
			return nil, nil
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
	// Consumer 内嵌套注入 fiber 的回调在独立 goroutine：显式收敛全部框架
	// 任务后再断言（方案 2.0 的测试确定性契约）。
	if err := root.Tasks().Wait(ctxBg); err != nil {
		t.Fatalf("等待框架任务收敛失败：%v", err)
	}

	if !injected {
		t.Fatalf("Consumer 的注入回调应确认 server 已注入")
	}
	for _, m := range root.LoggerService().Messages() {
		if m.Type == LoggerTypeError {
			t.Fatalf("全程不应产生错误日志：%v", m.Args)
		}
	}
}

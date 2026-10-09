package kardia

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

// 对应 core/tests/invoke.spec.ts（2 个用例）。TS 的可调用服务
// （[Service.invoke]/[Service.extend]）在 Go 以 Caller/Extender 接口承载：
// InvokeC 的 caller 是发起调用的 Context（TS 的 symbols.caller=defSite），
// 方法内 this.ctx 以 CtxFor(caller) 等价；扩展实例记住捕获的 caller 链，
// 其 InvokeC(nil, ...) 沿用捕获链（方案 2.3）。'context traceability'
// 的 foo1.invoke() 在 Go 显式传入取出时的 ctx（TS 的 traceable proxy
// 闭包捕获无 Go 等价，差异清单第 8 条）。

// invokeFoo 对应 'functional service' 的 Foo：invoke 合并
// config、intercept.foo 与调用参数。
type invokeFoo struct {
	Service
	config  map[string]any
	capture *Context // 扩展实例捕获的 caller 链（非扩展为 nil）
}

// merged 返回 config + 沿 use 链收集的 intercept.foo（近端覆盖远端，
// 对应 TS invoke 内沿 this.ctx[intercept] 原型链 Object.assign）。
func (s *invokeFoo) merged(use *Context) map[string]any {
	result := map[string]any{}
	for k, v := range s.config {
		result[k] = v
	}
	configs := use.InterceptAll("foo")
	for i := len(configs) - 1; i >= 0; i-- {
		if m, ok := configs[i].(map[string]any); ok {
			for k, v := range m {
				result[k] = v
			}
		}
	}
	return result
}

// useSite 解析调用链：显式 caller > 扩展捕获 > 构造 ctx。
func (s *invokeFoo) useSite(caller *Context) *Context {
	if caller != nil {
		return caller
	}
	if s.capture != nil {
		return s.capture
	}
	return s.Ctx
}

// InvokeC 实现 Caller（对应 [Service.invoke]）。
func (s *invokeFoo) InvokeC(caller *Context, args []any) (any, error) {
	result := s.merged(s.useSite(caller))
	if len(args) > 0 {
		if m, ok := args[0].(map[string]any); ok {
			for k, v := range m {
				result[k] = v
			}
		}
	}
	return result, nil
}

// ExtendC 实现 Extender（对应 [Service.extend]）。
func (s *invokeFoo) ExtendC(caller *Context, props map[string]any) any {
	cfg := map[string]any{}
	for k, v := range s.config {
		cfg[k] = v
	}
	if m, ok := props["config"].(map[string]any); ok {
		for k, v := range m {
			cfg[k] = v
		}
	}
	clone := &invokeFoo{
		Service: Service{Ctx: s.Ctx, Name: s.Name, Tracker: s.Tracker},
		config:  cfg,
		capture: caller,
	}
	return clone
}

// invokeResult 把 any 归一为 map[string]any 便于断言。
func invokeResult(t *testing.T, v any, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatalf("调用失败：%v", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("结果应为 map，实际 %T", v)
	}
	return m
}

// TestInvokeFunctionalService 对应 'functional service'。
func TestInvokeFunctionalService(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	fooPlugin := &Plugin{
		Name: "Foo",
		Apply: func(c *Context, config any) (Disposable, error) {
			cfg, _ := config.(map[string]any)
			if cfg == nil {
				cfg = map[string]any{}
			}
			s := &invokeFoo{config: cfg}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}
	fiber, err := root.Plugin(fooPlugin, map[string]any{"a": 1})
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}

	// 从 ctx 调用
	callFoo, callErr := root.Call("foo")
	if got := invokeResult(t, callFoo, callErr); !reflect.DeepEqual(got, map[string]any{"a": 1}) {
		t.Fatalf("root.foo() 应为 {a:1}，实际 %v", got)
	}
	ctx1 := root.Intercept("foo", map[string]any{"b": 2})
	callFoo, callErr = ctx1.Call("foo")
	if got := invokeResult(t, callFoo, callErr); !reflect.DeepEqual(got, map[string]any{"a": 1, "b": 2}) {
		t.Fatalf("ctx1.foo() 应为 {a:1,b:2}，实际 %v", got)
	}
	foo1Value, err := ctx1.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo1, ok := foo1Value.(*invokeFoo)
	if !ok {
		t.Fatalf("ctx1.foo 应是 Foo 实例，实际 %T", foo1Value)
	}

	// 创建扩展
	foo2Value := foo1.ExtendC(root, map[string]any{"config": map[string]any{"c": 3}})
	foo2, ok := foo2Value.(*invokeFoo)
	if !ok {
		t.Fatalf("extend 应返回 Foo 实例，实际 %T", foo2Value)
	}
	invoked, invokeErr := foo2.InvokeC(nil, nil)
	if got := invokeResult(t, invoked, invokeErr); !reflect.DeepEqual(got, map[string]any{"a": 1, "c": 3}) {
		t.Fatalf("foo2() 应为 {a:1,c:3}，实际 %v", got)
	}
	foo3Value := foo1.ExtendC(ctx1, map[string]any{"config": map[string]any{"d": 4}})
	foo3, ok := foo3Value.(*invokeFoo)
	if !ok {
		t.Fatalf("extend 应返回 Foo 实例，实际 %T", foo3Value)
	}
	invoked, invokeErr = foo3.InvokeC(nil, nil)
	if got := invokeResult(t, invoked, invokeErr); !reflect.DeepEqual(got, map[string]any{"a": 1, "b": 2, "d": 4}) {
		t.Fatalf("foo3() 应为 {a:1,b:2,d:4}，实际 %v", got)
	}

	// 上下文可追溯：原实例按取出时的 ctx 解析（TS 的 foo1.invoke()，
	// Go 显式传 ctx1）
	invoked, invokeErr = foo1.InvokeC(ctx1, nil)
	if got := invokeResult(t, invoked, invokeErr); !reflect.DeepEqual(got, map[string]any{"a": 1, "b": 2}) {
		t.Fatalf("foo1.invoke() 应为 {a:1,b:2}，实际 %v", got)
	}
}

// invokeDependency 对应 'uses the service shadow for callable extensions'
// 的 Dependency。
type invokeDependency struct {
	Service
}

// invokeCallable 对应 Callable（inject dependency；invoke 返回依赖实例）。
type invokeCallable struct {
	Service
	capture *Context
}

// InvokeC 实现 Caller：this.ctx['dependency'] 经 CtxFor(caller) 的影子解析
// （依赖按 Callable 自身的 inject 声明裁决）。
func (s *invokeCallable) InvokeC(caller *Context, _ []any) (any, error) {
	use := caller
	if use == nil {
		use = s.capture
	}
	if use == nil {
		use = s.Ctx
	}
	return s.CtxFor(use).Get("dependency")
}

// ExtendC 实现 Extender。
func (s *invokeCallable) ExtendC(caller *Context, _ map[string]any) any {
	return &invokeCallable{
		Service: Service{Ctx: s.Ctx, Name: s.Name, Tracker: s.Tracker},
		capture: caller,
	}
}

// invokeOuter 对应 Outer（inject callable）。
type invokeOuter struct {
	Service
}

// Call 对应 call()：this.ctx['callable'] 的直调与扩展调用都应解析出依赖。
func (s *invokeOuter) Call(access *Context) ([2]any, error) {
	shadowCtx := s.CtxFor(access)
	v, err := shadowCtx.Get("callable")
	if err != nil {
		return [2]any{}, err
	}
	callable, ok := v.(*invokeCallable)
	if !ok {
		return [2]any{}, fmt.Errorf("callable 服务类型不符：%T", v)
	}
	first, err := callable.InvokeC(shadowCtx, nil)
	if err != nil {
		return [2]any{}, err
	}
	extValue := callable.ExtendC(shadowCtx, nil)
	ext, ok := extValue.(*invokeCallable)
	if !ok {
		return [2]any{}, fmt.Errorf("callable 扩展类型不符：%T", extValue)
	}
	second, err := ext.InvokeC(shadowCtx, nil)
	if err != nil {
		return [2]any{}, err
	}
	return [2]any{first, second}, nil
}

// TestInvokeShadowForExtensions 对应 'uses the service shadow for callable
// extensions'：直调与扩展实例的调用都沿服务影子解析依赖。
func TestInvokeShadowForExtensions(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	depFiber, err := root.Plugin(&Plugin{
		Name: "Dependency",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &invokeDependency{}
			s.Service = newTestService(c, "dependency", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Dependency 失败：%v", err)
	}
	callableFiber, err := root.Plugin(&Plugin{
		Name:   "Callable",
		Inject: InjectMap{"dependency": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &invokeCallable{}
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
			s := &invokeOuter{}
			s.Service = newTestService(c, "outer", s, nil)
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载 Outer 失败：%v", err)
	}
	for _, f := range []*Fiber{depFiber, callableFiber, outerFiber} {
		if _, err := f.Await(ctxBg); err != nil {
			t.Fatalf("等待 fiber 失败：%v", err)
		}
	}

	var result [2]any
	fiber, err := root.Inject([]string{"outer"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("outer")
		if err != nil {
			t.Errorf("读取 outer 失败：%v", err)
			return nil, nil
		}
		outer, _ := v.(*invokeOuter)
		if outer == nil {
			t.Errorf("outer 服务类型不符：%T", v)
			return nil, nil
		}
		got, err := outer.Call(c)
		if err != nil {
			t.Errorf("outer.call() 失败：%v", err)
			return nil, nil
		}
		result = got
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}

	for i, item := range result {
		if _, ok := item.(*invokeDependency); !ok {
			t.Errorf("result[%d] 应是 Dependency 实例，实际 %T", i, item)
		}
	}
}

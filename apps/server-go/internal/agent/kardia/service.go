// service.go 对应 TS core/src/service.ts：Service 基类以「嵌入结构体 +
// 构造辅助」实现（Go 无类继承），CtxFor 是服务方法内 this.ctx 的等价物。
package kardia

import (
	"context"
	"errors"
	"fmt"
)

// Service 对应 TS abstract class Service。具体服务嵌入本结构体，构造时
// 调用 NewService 完成基类初始化与 ctx.reflect.provide。
type Service struct {
	// Ctx 是构造 ctx（即 def site / 影子持有者）。
	Ctx *Context
	// Name 是服务名（provide 键）。
	Name string
	// Tracker 对应 [Service.tracker]，默认 {Associate: name, Property: "ctx"}。
	Tracker Tracker
	dispose Disposable
	merge   func(...map[string]any) (map[string]any, error)
}

// NewService 完成基类初始化与 ctx.reflect.provide（service.ts:18-35 的等价）。
// self 是外层具体服务实例（供 check 与关联包装使用）；check 对应
// [Service.check]（按实现值裁决注入可见性），无则传 nil。
//
// 注册失败直接返回错误，调用者可用 Close 回滚后续构造步骤。
func NewService(ctx *Context, name string, self any, check ServiceCheck) (Service, error) {
	base := Service{
		Ctx:     ctx,
		Name:    name,
		Tracker: Tracker{Associate: name, Property: "ctx"},
	}
	dispose, err := ctx.Reflect().Provide(ctx, name, self, check)
	if err != nil {
		return Service{}, err
	}
	base.dispose = dispose
	if merger, ok := self.(ServiceConfigMerger); ok {
		base.merge = merger.MergeConfig
	}
	return base, nil
}

// Close 撤销服务提供；与所属插件的清理共享同一完成任务。
func (s *Service) Close(ctx context.Context) error {
	if s.dispose == nil {
		return nil
	}
	return s.dispose(ctx)
}

// CordisFilter 对应 TS Service[symbols.filter]（service.ts:37-39）：以服务名
// 的 isolate 符号相等判定事件可见性。Go 侧实现 FilterCarrier 形态，供以
// 服务实例为 thisArg 的事件派发过滤（events._resolve，isolate.spec 的
// isolated event 用例）。
func (s *Service) CordisFilter(target *Context) bool {
	a, _ := target.isolateSym(s.Name)
	b, _ := s.Ctx.isolateSym(s.Name)
	return a == b
}

// CtxFor 是服务方法内 this.ctx 的等价物（方案 2.1 影子使用规则 1/4）：
// Tracker.NoShadow 时直接返回 access（依赖按调用方 ctx 裁决），否则
// access.Shadow(s.Ctx)——链 = access（use site），影子 = 构造 ctx（def site）。
func (s *Service) CtxFor(access *Context) *Context {
	if s.Tracker.NoShadow {
		return access
	}
	return access.Shadow(s.Ctx)
}

// Initializer 对应 [Service.init] 的「返回型」实现。
type Initializer interface {
	Init(ctx context.Context) (Disposable, error)
}

// InitializerIter 对应 [Service.init] 的生成器形态（如 Include/Group：
// yield 清理器后继续做异步工作）。
type InitializerIter interface {
	InitIter(ctx context.Context, yield func(Disposable) error) error
}

// Caller 对应 [Service.invoke]：可调用服务（如 logger）。经 Context.Call
// 调用，caller 为发起调用的 Context（TS 的 symbols.caller）。
type Caller interface {
	InvokeC(caller *Context, args []any) (any, error)
}

// Extender 对应 [Service.extend]：扩展实例须记住捕获的 caller 链，其后续
// InvokeC 在未显式给 caller 时沿用该链（invoke.spec.ts:51-59 的行为依据）。
type Extender interface {
	ExtendC(caller *Context, props map[string]any) any
}

// InjectMethod 对应方法级 @Inject 装饰器（registry.ts:25-35）：在插件构造
// （Apply）时调用，宿主 fiber 激活时以「注入就绪的 ctx」执行 method，其
// 返回的清理器挂在注入 fiber 上（decorator.spec 的行为契约）。
func InjectMethod(ctx *Context, deps []string, method func(injected *Context) (Disposable, error)) (*Fiber, error) {
	return ctx.Registry().Inject(ctx, deps, func(injected *Context, _ any) (Disposable, error) {
		return method(injected)
	})
}

// ServiceFactory 构造服务实例；构造期间的资源归属同一个激活作用域。
type ServiceFactory func(*Context, any) (any, error)

// ServicePlugin 以 Go 接口接入服务初始化，无需模拟类构造或装饰器。
func ServicePlugin(name string, inject InjectMap, factory ServiceFactory) *Plugin {
	return &Plugin{Name: name, Inject: inject, Apply: func(c *Context, config any) (Disposable, error) {
		instance, err := factory(c, config)
		if err != nil {
			return nil, err
		}
		if init, ok := instance.(InitializerIter); ok {
			h, err := c.Scope().Iter("service.init", func(ctx context.Context, scope *EffectScope) error { return init.InitIter(ctx, scope.Defer) })
			if err != nil {
				return nil, err
			}
			if err := h.Wait(c.Lifetime()); err != nil {
				return nil, errors.Join(err, h.Dispose(context.Background()))
			}
			return nil, nil
		}
		if init, ok := instance.(Initializer); ok {
			return init.Init(c.Lifetime())
		}
		return nil, nil
	}}
}

// ServiceConfigMerger 可选地为服务提供自定义合并规则，输入按覆盖优先级排序。
type ServiceConfigMerger interface {
	MergeConfig(...map[string]any) (map[string]any, error)
}

// ResolveConfig 按基础值、外层拦截、内层拦截、显式覆盖的次序合并配置。
func (s *Service) ResolveConfig(access *Context, base, head map[string]any) (result map[string]any, err error) {
	defer func() {
		if v := recover(); v != nil {
			result = nil
			err = fmt.Errorf("服务配置合并发生 panic: %v", v)
		}
	}()
	configs := []map[string]any{}
	appendConfig := func(m map[string]any) {
		if m != nil {
			configs = append(configs, CloneConfig(m).(map[string]any))
		}
	}
	appendConfig(base)
	layers := access.InterceptAll(s.Name)
	for i := len(layers) - 1; i >= 0; i-- {
		if layers[i] == nil {
			continue
		}
		m, ok := layers[i].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("服务 %q 的拦截配置必须为对象", s.Name)
		}
		appendConfig(m)
	}
	appendConfig(head)
	if s.merge != nil {
		return s.merge(configs...)
	}
	result = map[string]any{}
	for _, m := range configs {
		for k, v := range m {
			result[k] = v
		}
	}
	return result, nil
}

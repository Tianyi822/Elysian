// reflect.go 对应 TS core/src/reflect.ts。Proxy handler（reflect.ts:62-135）
// 的受检读写路径在此显式化为 Context.Get/Set/GetLoose；影子机制以
// DefSite/use site 原语重表达（方案 2.1，差异清单第 8 条）。
package kardia

import (
	"context"
	"errors"
	"fmt"
)

// PropertyKind 对应 Property.Service['type'] 与 Property.Accessor['type']。
type PropertyKind string

const (
	PropertyService  PropertyKind = "service"
	PropertyAccessor PropertyKind = "accessor"
)

// Accessor 对应 Property.Accessor 的 get/set。TS 的 receiver/withProps 绑定
// 无完整等价（差异清单第 8 条）：回调直接收到请求方 *Context。
type Accessor struct {
	// Get 以请求方 ctx 解析属性；err 为框架预置错误（透传给需要抛错的实现）。
	Get func(c *Context, err error) (any, error)
	// Set 可为 nil（属性不可写）。
	Set func(c *Context, value any, err error) (bool, error)
}

// Property 对应 TS Property 联合类型。
type Property struct {
	Type PropertyKind
	Acc  Accessor // Type == PropertyAccessor 时有效
}

// ServiceCheck 按访问方的隔离与拦截配置检查服务是否可用。
type ServiceCheck func(access *Context, value any) (bool, error)

// Impl 对应 TS Impl（reflect.ts:54-59）。
type Impl struct {
	Name  string
	Fiber *Fiber
	Value any
	Check ServiceCheck
}

// MixinSource 由 mixin 源服务实现：以 access 调用源服务的指定成员，返回
// 绑定形态（对应 TS 的 Reflect.get(service, key, mixin) + value.bind(mixin)；
// timer 的六方法经此暴露为 ctx.Get("timeout") 等，方案 2.1/2.6）。
type MixinSource interface {
	MixinInvoke(access *Context, key string) (any, error)
}

// ReflectService 对应 TS ReflectService。store 按隔离符号索引全局实现表，
// props 按名索引属性声明；两者一切读写持 root 锁（方案 2.10）。
type ReflectService struct {
	ctx   *Context
	store map[*Symbol]*Impl
	props map[string]*Property
}

func newReflectService(ctx *Context) *ReflectService {
	// TS 构造器里的 self-mixin（reflect/fiber/registry/events 五组方法）在 Go
	// 侧是 Context 的便捷方法，无需登记。
	return &ReflectService{
		ctx:   ctx,
		store: make(map[*Symbol]*Impl),
		props: make(map[string]*Property),
	}
}

// Get 对应 reflect.get(name, strict=true)（mixin 的 ctx.get 路径）：按 c 的
// isolate 链查全局实现表，strict 时仅 ACTIVE 实现可见。
func (r *ReflectService) Get(c *Context, name string) (any, error) {
	impl := r.getImpl(c, name, true)
	if impl == nil {
		return nil, nil
	}
	c.mu.Lock()
	value := impl.Value
	c.mu.Unlock()
	return value, nil
}

// Set 对应 reflect.set（mixin 的 ctx.set 原始路径，不走 internal/set 瀑布）。
func (r *ReflectService) Set(c *Context, name string, value any) error {
	return r.set(c, name, value)
}

// getImpl 对应 _getImpl（reflect.ts:156-162）。
func (r *ReflectService) getImpl(c *Context, name string, strict bool) *Impl {
	c.mu.Lock()
	key, ok := c.isolateSym(name)
	if !ok {
		c.mu.Unlock()
		return nil
	}
	impl := r.store[key]
	c.mu.Unlock()
	if impl == nil {
		return nil
	}
	if strict && impl.Fiber.State() != FiberActive {
		return nil
	}
	return impl
}

// set 对应 reflect.set（reflect.ts:164-175）。
func (r *ReflectService) set(c *Context, name string, value any) error {
	scope := c.Scope()
	c.mu.Lock()
	defer c.mu.Unlock()
	if scope.generation != scope.fiber.generation || scope.lifetime.Err() != nil {
		return &CordisError{Code: "INACTIVE_EFFECT"}
	}
	key, ok := c.isolateSym(name)
	var impl *Impl
	if ok {
		impl = r.store[key]
	}
	if impl == nil {
		return fmt.Errorf("无法在未提供的情况下设置属性 %q", name)
	}
	if impl.Fiber != c.Fiber() {
		return fmt.Errorf("无法在多个 fiber 中设置属性 %q", name)
	}
	impl.Value = value
	return nil
}

// Provide 对应 reflect.provide（reflect.ts:177-205）：在 c 的 fiber 上以
// effect 登记服务提供，fiber 销毁自动撤销。可失败部分（属性冲突、重复
// 注册）同步返回错误（TS 在 effect 内同步 throw 的路径，见 deviations）。
func (r *ReflectService) Provide(c *Context, name string, value any, check ServiceCheck) (Disposable, error) {
	f := c.Fiber()
	return c.Effect(fmt.Sprintf("ctx.provide(%q)", name), func() (Disposable, error) {
		c.mu.Lock()
		if p, ok := r.props[name]; ok && p.Type != PropertyService {
			c.mu.Unlock()
			return nil, fmt.Errorf("属性 %q 已被声明为 %s", name, p.Type)
		}
		rootIso := c.Root().nearestIsolate()
		rootIso.Ensure(name, func() *Symbol { return NewSymbol(name) })
		key, _ := c.isolateSym(name)
		if old := r.store[key]; old != nil {
			c.mu.Unlock()
			return nil, fmt.Errorf("服务 %q 已注册于 <%s>", name, old.Fiber.Name())
		}
		impl := &Impl{Name: name, Fiber: f, Value: value, Check: check}
		r.props[name] = &Property{Type: PropertyService}
		r.store[key] = impl
		if f.store == nil {
			f.store = map[string]*Impl{}
		}
		f.store[name] = impl
		active := f.state == FiberActive
		c.mu.Unlock()
		cleanup := func(dctx context.Context) error {
			c.mu.Lock()
			for key, current := range r.store {
				if current == impl {
					delete(r.store, key)
				}
			}
			c.mu.Unlock()
			fibers, err := r.Notify(c, []string{name})
			for _, dependent := range fibers {
				if dependent != f {
					waitErr := dependent.drainInertia(dctx)
					err = errors.Join(err, waitErr)
				}
			}
			c.mu.Lock()
			if f.store[name] == impl {
				delete(f.store, name)
			}
			c.mu.Unlock()
			return err
		}
		if active {
			_, err := r.Notify(c, []string{name})
			return cleanup, err
		}
		return cleanup, nil
	})
}

// Notify 对应 reflect.notify（reflect.ts:207-229，默认 filter：目标 ctx 与
// provider 在 name 上的隔离符号相等）：刷新受影响注入 fiber 并派发
// internal/service；返回被刷新的 fiber。
func (r *ReflectService) Notify(provider *Context, names []string) ([]*Fiber, error) {
	return r.notify(provider, names, func(target *Context, name string) bool { return target.Isolation(name) == provider.Isolation(name) })
}

func (r *ReflectService) notify(provider *Context, names []string, filter func(*Context, string) bool) ([]*Fiber, error) {
	fibers := make([]*Fiber, 0)
	for _, runtime := range r.ctx.Registry().Values() {
		for _, fiber := range runtime.fibers.Values() {
			hasUpdate := false
			inject := fiber.Inject()
			for _, name := range names {
				if _, ok := inject[name]; !ok {
					continue
				}
				if !filter(fiber.Ctx(), name) {
					continue
				}
				hasUpdate = true
				fiber.checkImpl(name)
			}
			if !hasUpdate {
				continue
			}
			fiber.refresh()
			fibers = append(fibers, fiber)
		}
	}
	var lastErr error
	for _, name := range names {
		filterCtx := provider.Extend(ExtendMeta{Filter: func(target *Context) bool {
			return filter(target, name)
		}})
		var value any
		if impl := r.getImpl(provider, name, false); impl != nil {
			r.ctx.mu.Lock()
			value = impl.Value
			r.ctx.mu.Unlock()
		}
		if err := r.ctx.Events().EmitTo(filterCtx, StringEvent("internal/service"), name, value); err != nil {
			lastErr = err
		}
	}
	return fibers, lastErr
}

// Accessor 对应 reflect.accessor（reflect.ts:231-239）。
func (r *ReflectService) Accessor(c *Context, name string, opts Accessor) (Disposable, error) {
	return c.Effect(fmt.Sprintf("ctx.accessor(%q)", name), func() (Disposable, error) {
		c.mu.Lock()
		if p, exists := r.props[name]; exists {
			c.mu.Unlock()
			return nil, fmt.Errorf("属性 %q 已被声明为 %s", name, p.Type)
		}
		r.props[name] = &Property{Type: PropertyAccessor, Acc: opts}
		c.mu.Unlock()
		return func(context.Context) error {
			c.mu.Lock()
			delete(r.props, name)
			c.mu.Unlock()
			return nil
		}, nil
	})
}

// Mixin 对应 reflect.mixin（reflect.ts:241-267，列表形态）：为每个 key 注册
// accessor，其 get 以请求方 ctx 解析 source 服务并返回成员值或绑定闭包。
// TS 的生成器嵌套 effect 树（children）不移植（无 spec 断言，见 localGaps）。
func (r *ReflectService) Mixin(c *Context, source string, keys []string) (Disposable, error) {
	var disposers []Disposable
	for _, key := range keys {
		d, err := r.Accessor(c, key, Accessor{
			Get: func(rc *Context, err error) (any, error) { return mixinGet(rc, source, key, err) },
			Set: func(rc *Context, value any, err error) (bool, error) { return mixinSet(rc, source, key, value, err) },
		})
		if err != nil {
			for i := len(disposers) - 1; i >= 0; i-- {
				err = errors.Join(err, disposers[i](context.Background()))
			}
			return nil, err
		}
		disposers = append(disposers, d)
	}
	return func(ctx context.Context) error {
		var err error
		for i := len(disposers) - 1; i >= 0; i-- {
			err = errors.Join(err, disposers[i](ctx))
		}
		return err
	}, nil
}

// mixinGet 对应 mixin accessor 的 get：服务缺失返回 nil（TS isNullable 分支），
// 值形态经 map/MixinSource 分派。
func mixinGet(rc *Context, source, key string, _ error) (any, error) {
	v, err := rc.Get(source)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	switch s := v.(type) {
	case MixinSource:
		return s.MixinInvoke(rc, key)
	case map[string]any:
		return s[key], nil
	}
	return nil, nil
}

// mixinSet 对应 mixin accessor 的 set。
func mixinSet(rc *Context, source, key string, value any, _ error) (bool, error) {
	v, err := rc.Get(source)
	if err != nil {
		return false, err
	}
	if v == nil {
		return false, nil
	}
	switch s := v.(type) {
	case map[string]any:
		s[key] = value
		return true, nil
	}
	return false, nil
}

// ResolveAssociated 以 use 为访问点解析关联属性（TS utils.ts:161-216 中
// `ctx.foo.bar` 与 `ctx['foo.bar']` 由同一 fiber 支配的规则，
// associate.spec.ts:176-232）：先查 reflect.props 是否声明了 "associate.prop"
// （声明则走受检 Get），否则从 associate 的实现值上取 prop。
func ResolveAssociated(use *Context, associate, prop string) (any, error) {
	full := associate + "." + prop
	root := use.Root()
	root.mu.Lock()
	_, declared := root.reflect.props[full]
	root.mu.Unlock()
	if declared {
		return use.Get(full)
	}
	v, err := use.Get(associate)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	switch s := v.(type) {
	case MixinSource:
		return s.MixinInvoke(use, prop)
	case map[string]any:
		return s[prop], nil
	}
	return nil, nil
}

// —— Proxy handler 的受检路径（reflect.ts:62-135 的显式化）——

// Get 对应 Proxy handler.get 的受检路径：先查本链已有属性（Props），再查
// reflect.props 的 accessor；服务沿 isolate 链解析（defSite=c.DefSite()，
// 逐级 fiber.store → inject 检查 → runtime 检查 → 父级跳转条件 fiber.parent
// 的 isolate 键相等），全程经 events.WaterfallTo(c, "internal/get", …)。
// 错误文案为 TS 中文化版本。
func (c *Context) Get(name string) (any, error) {
	if isSpecialProperty(name) {
		v, _ := c.Prop(name)
		return v, nil
	}
	if v, ok := c.Prop(name); ok {
		return v, nil
	}
	getErr := fmt.Errorf("无法在未注入的情况下读取属性 %q", name)
	root := c.Root()
	root.mu.Lock()
	def := root.reflect.props[name]
	root.mu.Unlock()
	if def != nil && def.Type == PropertyAccessor {
		if def.Acc.Get == nil {
			return nil, getErr
		}
		return def.Acc.Get(c, getErr)
	}
	// defSite 的 fiber 无 runtime（根 fiber）时走 loose 路径（reflect.ts:80-81）：
	// 根上不可声明 inject，保持未受检访问。
	if c.DefSite().Fiber().Runtime() == nil {
		return c.GetLoose(name)
	}
	return c.Events().WaterfallTo(c, StringEvent("internal/get"), func(ev *EventCtx) (any, error) {
		return c.Root().reflect.resolveStrict(c, name, getErr)
	}, c, name, getErr)
}

// GetLoose 对应 reflect.get(name, strict=false)：跳过 ACTIVE 检查与注入检查。
func (c *Context) GetLoose(name string) (any, error) {
	impl := c.Root().reflect.getImpl(c, name, false)
	if impl == nil {
		return nil, nil
	}
	c.mu.Lock()
	value := impl.Value
	c.mu.Unlock()
	return value, nil
}

// Set 对应受检 set 路径（accessor.set / internal/set waterfall / reflect.set
// 的同 fiber 约束；reflect.ts:102-126）。
func (c *Context) Set(name string, value any) error {
	if isSpecialProperty(name) {
		c.setOwn(name, value)
		return nil
	}
	setErr := fmt.Errorf("无法在未提供的情况下设置属性 %q", name)
	root := c.Root()
	root.mu.Lock()
	def := root.reflect.props[name]
	root.mu.Unlock()
	if def == nil {
		if c.Fiber().Runtime() == nil {
			// 根 fiber 无 runtime：普通属性写（TS Reflect.set(target, prop, value, ctx)）。
			c.setOwn(name, value)
			return nil
		}
		return setErr
	}
	if def.Type == PropertyAccessor {
		if def.Acc.Set == nil {
			return fmt.Errorf("无法设置属性 %q：accessor 不可写", name)
		}
		ok, err := def.Acc.Set(c, value, setErr)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("无法设置属性 %q", name)
		}
		return nil
	}
	_, err := c.Events().WaterfallTo(c, StringEvent("internal/set"), func(ev *EventCtx) (any, error) {
		return true, c.Root().reflect.set(c, name, value)
	}, c, name, value, setErr)
	return err
}

// resolveStrict 对应 internal/get 瀑布的终端（reflect.ts:83-95）：
// 从 defSite.fiber 起逐级向上解析。key 取根 isolate 表（TS 的
// target[symbols.isolate][prop]，target 恒为根实例）；父级跳转要求
// fiber.parent 沿链解析的 isolate 键与根表一致。
func (r *ReflectService) resolveStrict(c *Context, name string, baseErr error) (any, error) {
	var key *Symbol
	if m := c.Root().nearestIsolate(); m != nil {
		key, _ = m.Lookup(name)
	}
	fiber := c.DefSite().Fiber()
	for {
		c.mu.Lock()
		var impl *Impl
		if fiber.store != nil {
			impl = fiber.store[name]
		}
		_, injected := fiber.inject[name]
		runtime := fiber.runtime
		parent := fiber.parent
		c.mu.Unlock()
		if impl != nil {
			c.mu.Lock()
			value := impl.Value
			c.mu.Unlock()
			return value, nil
		}
		if injected {
			return nil, fmt.Errorf("无法在非激活上下文中获取必需服务 %q", name)
		}
		if runtime == nil {
			return nil, baseErr
		}
		pkey, _ := parent.isolateSym(name)
		if pkey != key {
			return nil, baseErr
		}
		fiber = parent.Fiber()
	}
}

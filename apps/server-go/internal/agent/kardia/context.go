// context.go 对应 TS core/src/context.ts：Context 的 Go 形态是
// 「parent 指针 + 显式覆盖层」（TS 的 Object.create 原型链 + Proxy 拦截，
// 见方案 2.1 与差异清单第 8 条）。
package kardia

import (
	"context"
	"fmt"
	"sync"

	"elysian/server/internal/agent/kardia/clock"
)

// ExtendMeta 对应 TS extend(meta) 的具名属性集合；其余符号键走 Props。
type ExtendMeta struct {
	// Isolate 在 ctx.isolate() 时设置（链式符号表）。
	Isolate *IsolateMap
	// Intercept 在 ctx.intercept() 时设置（本层新增键）。
	Intercept map[string]any
	// Filter 对应 symbols.filter。
	Filter func(target *Context) bool
	// Fiber 由 registry.plugin 内部挂载。
	Fiber *Fiber
	// Shadow 是影子 def-site（TS symbols.shadow）。
	Shadow *Context
	// Props 承载其余键（loader 的 EntryKey 等）。
	Props map[any]any
	// BaseURL 与 HasBaseURL 对应 TS 的 baseUrl 可选属性。
	BaseURL string
	// HasBaseURL 报告本层是否显式设置 BaseURL。
	HasBaseURL bool
}

// contextOptions 是 NewContext 的可选配置载体。
type contextOptions struct {
	clk clock.Clock
}

// ContextOption 是 NewContext 的选项。
type ContextOption func(*contextOptions)

// WithClock 注入时钟，默认 clock.Real{}。
func WithClock(clk clock.Clock) ContextOption {
	return func(o *contextOptions) { o.clk = clk }
}

// Context 对应 TS Context。字段私有，经方法访问；mu 为 root 锁（方案 2.10），
// 在根上创建、影子/子 ctx 直接共享同一指针。
type Context struct {
	mu       *sync.Mutex
	chainMu  *sync.RWMutex
	scope    *EffectScope
	parent   *Context
	root     *Context
	meta     *ExtendMeta
	events   *EventsService
	logger   *LoggerService
	reflect  *ReflectService
	registry *RegistryService
	clk      clock.Clock
	tasks    *clock.TaskGroup
}

// NewContext 按方案 2.1 的构造顺序创建根 Context（对应 context.ts:36-49）：
// 先建 isolate/intercept 空层，再建根 fiber（runtime=nil 分支：uid=0、
// state=ACTIVE、store 空表），再建 reflect/registry/events/logger，最后清空
// 根 fiber 的 _disposables（剥离构造期 events 服务登记的两个内建钩子 effect）。
func NewContext(opts ...ContextOption) *Context {
	o := contextOptions{clk: clock.Real{}}
	for _, opt := range opts {
		opt(&o)
	}
	root := &Context{
		meta: &ExtendMeta{
			Isolate:   &IsolateMap{},
			Intercept: map[string]any{},
		},
		clk: o.clk,
	}
	root.mu = &sync.Mutex{}
	root.chainMu = &sync.RWMutex{}
	root.root = root
	root.tasks = &clock.TaskGroup{}
	root.tasks.SetPanicHandler(func(v any) {
		// 方案 2.10 第 4 条：goroutine 内 panic 转错误经 logger 上报。
		if root.logger != nil {
			root.Logger().Error(fmt.Errorf("任务发生 panic: %v", v))
		}
	})
	rootFiber, _ := newFiber(root, map[string]any{}, InjectMap{}, nil)
	root.meta.Fiber = rootFiber
	root.reflect = newReflectService(root)
	root.registry = newRegistryService(root)
	root.events = newEventsService(root)
	root.logger = newLoggerService(root)
	rootFiber.disposables.Clear()
	return root
}

// derive 以 c 为父链派生新层，共享 root 单例与 root 锁。
func (c *Context) derive(meta *ExtendMeta) *Context {
	return &Context{
		mu:       c.mu,
		chainMu:  c.chainMu,
		scope:    c.scope,
		parent:   c,
		root:     c.root,
		meta:     meta,
		events:   c.events,
		logger:   c.logger,
		reflect:  c.reflect,
		registry: c.registry,
		clk:      c.clk,
		tasks:    c.tasks,
	}
}

// Extend 影子语义照搬 context.ts:55-63：以 c 为原型造新层并落 meta；
// 本层持有 shadow 时新层继承同一 shadow（TS 的 Object.assign(Object.create(self), …)）。
func (c *Context) Extend(meta ExtendMeta) *Context {
	m := meta
	if meta.Intercept != nil {
		m.Intercept = CloneConfig(meta.Intercept).(map[string]any)
	}
	if meta.Props != nil {
		m.Props = make(map[any]any, len(meta.Props))
		for k, v := range meta.Props {
			m.Props[k] = v
		}
	}
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	child := c.derive(&m)
	if meta.Fiber != nil {
		child.scope = nil
	}
	if child.meta.Shadow == nil && c.meta != nil {
		child.meta.Shadow = c.meta.Shadow
	}
	return child
}

// Shadow 造影子：新 ctx 的 parent 链 = c（use site），ShadowSite = defSite
// （方案 2.1 影子原语，对应 TS createShadow）。
func (c *Context) Shadow(defSite *Context) *Context {
	child := c.derive(&ExtendMeta{})
	child.meta.Shadow = defSite
	return child
}

// ShadowSite 返回原始影子指针，无影子时返回 nil。
func (c *Context) ShadowSite() *Context {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	if c.meta != nil {
		return c.meta.Shadow
	}
	return nil
}

// DefSite 等价 TS 的 (ctx[symbols.shadow] ?? ctx)：ShadowSite 非 nil 则返回之。
func (c *Context) DefSite() *Context {
	if s := c.ShadowSite(); s != nil {
		return s
	}
	return c
}

// Isolate 对应 context.ts:65-69：label 为 nil 时新建 Symbol(name)。
func (c *Context) Isolate(name string, label *Symbol) *Context {
	var layer *IsolateMap
	if nearest := c.nearestIsolate(); nearest != nil {
		layer = nearest.child()
	} else {
		layer = &IsolateMap{}
	}
	if label == nil {
		label = NewSymbol(name)
	}
	layer.Set(name, label)
	return c.Extend(ExtendMeta{Isolate: layer})
}

// Intercept 对应 context.ts:73-77：本层新增键；跨层收集见 InterceptAll。
func (c *Context) Intercept(name string, config any) *Context {
	return c.Extend(ExtendMeta{Intercept: map[string]any{name: config}})
}

// InterceptAll 沿 parent 链收集某服务的拦截配置，近端（最里层）优先
// （等价 TS 原型链自内向外收集后 unshift 的顺序）；返回 nil 表示链上无配置。
func (c *Context) InterceptAll(name string) []any {
	c.chainMu.RLock()
	var out []any
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta == nil || cur.meta.Intercept == nil {
			continue
		}
		if v, ok := cur.meta.Intercept[name]; ok {
			out = append(out, v)
		}
	}
	c.chainMu.RUnlock()
	for i, v := range out {
		out[i] = CloneConfig(v)
	}
	return out
}

// Root 返回根 Context。
func (c *Context) Root() *Context { return c.root }

// Fiber 沿链查 ExtendMeta.Fiber（根层恒有）。
func (c *Context) Fiber() *Fiber {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta != nil && cur.meta.Fiber != nil {
			return cur.meta.Fiber
		}
	}
	return c.root.meta.Fiber
}

// BaseURL 沿链取最近设置的 BaseURL，未设置为空串。
func (c *Context) BaseURL() string {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta != nil && cur.meta.HasBaseURL {
			return cur.meta.BaseURL
		}
	}
	return ""
}

// Clock 返回注入时钟。
func (c *Context) Clock() clock.Clock { return c.clk }

// Tasks 返回任务组（框架内 goroutine 登记处）。
func (c *Context) Tasks() *clock.TaskGroup { return c.tasks }

// Events 返回事件服务（root 单例，影子共享）。
func (c *Context) Events() *EventsService { return c.events }

// LoggerService 返回日志服务（root 单例，影子共享）。
func (c *Context) LoggerService() *LoggerService { return c.logger }

// Reflect 返回反射服务（root 单例，影子共享）。
func (c *Context) Reflect() *ReflectService { return c.reflect }

// Registry 返回注册表服务（root 单例，影子共享）。
func (c *Context) Registry() *RegistryService { return c.registry }

// String 对应 nodejs util.inspect.custom：返回 "Context <fiber name>"。
func (c *Context) String() string {
	return fmt.Sprintf("Context <%s>", c.Fiber().Name())
}

// nearestIsolate 返回链上最近的 isolate 表。
func (c *Context) nearestIsolate() *IsolateMap {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta != nil && cur.meta.Isolate != nil {
			return cur.meta.Isolate
		}
	}
	return nil
}

// isolateSym 对应 TS ctx[symbols.isolate][name]（沿链解析）。
func (c *Context) isolateSym(name string) (*Symbol, bool) {
	m := c.nearestIsolate()
	if m == nil {
		return nil, false
	}
	return m.Lookup(name)
}

// nearestFilter 沿链取 ExtendMeta.Filter。
func (c *Context) nearestFilter() func(*Context) bool {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta != nil && cur.meta.Filter != nil {
			return cur.meta.Filter
		}
	}
	return nil
}

// Prop 沿 Props 链查（EntryKey 等）。
func (c *Context) Prop(key any) (any, bool) {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for cur := c; cur != nil; cur = cur.parent {
		if cur.meta != nil && cur.meta.Props != nil {
			if v, ok := cur.meta.Props[key]; ok {
				return v, ok
			}
		}
	}
	return nil, false
}

// setOwn 对应 TS handler.set 里 Reflect.set(target, prop, value, ctx) 的
// 普通属性写：落到访问层的 Props（持 root 锁）。
func (c *Context) setOwn(name string, value any) {
	c.chainMu.Lock()
	defer c.chainMu.Unlock()
	if c.meta == nil {
		c.meta = &ExtendMeta{}
	}
	if c.meta.Props == nil {
		c.meta.Props = make(map[any]any)
	}
	c.meta.Props[name] = value
}

// —— 事件便捷方法（全部转发 Events()，语义见方案 2.4）——

// On 注册监听器，返回退订函数。
func (c *Context) On(name EventName, listener Listener, opts ...EventOptions) (func() bool, error) {
	return c.events.On(c, name, listener, opts...)
}

// Once 注册一次性监听器。
func (c *Context) Once(name EventName, listener Listener, opts ...EventOptions) (func() bool, error) {
	return c.events.Once(c, name, listener, opts...)
}

// Emit 同步派发事件。
func (c *Context) Emit(name EventName, args ...any) error {
	return c.events.Emit(name, args...)
}

// EmitTo 以 thisArg 同步派发事件。
func (c *Context) EmitTo(thisArg any, name EventName, args ...any) error {
	return c.events.EmitTo(thisArg, name, args...)
}

// Parallel 并行派发并等待全部完成。
func (c *Context) Parallel(ctx context.Context, name EventName, args ...any) error {
	return c.events.Parallel(ctx, name, args...)
}

// ParallelTo 以 thisArg 并行派发。
func (c *Context) ParallelTo(ctx context.Context, thisArg any, name EventName, args ...any) error {
	return c.events.ParallelTo(ctx, thisArg, name, args...)
}

// Serial 串行派发，可被非空结果拦截。
func (c *Context) Serial(ctx context.Context, name EventName, args ...any) (any, error) {
	return c.events.Serial(ctx, name, args...)
}

// SerialTo 以 thisArg 串行派发。
func (c *Context) SerialTo(ctx context.Context, thisArg any, name EventName, args ...any) (any, error) {
	return c.events.SerialTo(ctx, thisArg, name, args...)
}

// Bail 同步串行派发，可被非空结果拦截。
func (c *Context) Bail(name EventName, args ...any) (any, error) {
	return c.events.Bail(name, args...)
}

// BailTo 以 thisArg 同步串行派发。
func (c *Context) BailTo(thisArg any, name EventName, args ...any) (any, error) {
	return c.events.BailTo(thisArg, name, args...)
}

// Waterfall 瀑布派发。
func (c *Context) Waterfall(name EventName, terminal func(ev *EventCtx) (any, error), args ...any) (any, error) {
	return c.events.Waterfall(name, terminal, args...)
}

// WaterfallTo 以 thisArg 瀑布派发。
func (c *Context) WaterfallTo(thisArg any, name EventName, terminal func(ev *EventCtx) (any, error), args ...any) (any, error) {
	return c.events.WaterfallTo(thisArg, name, terminal, args...)
}

// —— 生命周期便捷方法（转发 Fiber()/Registry()）——

// Scope 返回此调用上下文绑定的激活代；旧代不会跳到重启后的新代。
func (c *Context) Scope() *EffectScope {
	if c.scope != nil {
		return c.scope
	}
	return c.Fiber().Scope()
}

// Lifetime 是插件当次激活的协作取消信号。
func (c *Context) Lifetime() context.Context { return c.Scope().Context() }

func (c *Context) withScope(scope *EffectScope) *Context {
	child := c.Extend(ExtendMeta{})
	child.scope = scope
	return child
}

// Effect 登记同步副作用并返回错误。
func (c *Context) Effect(label string, execute EffectFunc) (Disposable, error) {
	h, err := c.Scope().Effect(label, execute)
	if err != nil {
		return nil, err
	}
	return h.Dispose, nil
}

// EffectIter 登记生产者。嵌套作用域使用 Scope.Iter 显式传递。
func (c *Context) EffectIter(label string, gen EffectGen) (Disposable, error) {
	h, err := c.Scope().Iter(label, func(ctx context.Context, s *EffectScope) error { return gen(ctx, s.Defer) })
	if err != nil {
		return nil, err
	}
	return h.Dispose, nil
}

// Plugin 在 c 的 fiber 上装载插件。
func (c *Context) Plugin(p *Plugin, config any) (*Fiber, error) {
	return c.registry.Plugin(c, p, config)
}

// Inject 声明依赖并在就绪时回调。
func (c *Context) Inject(deps []string, cb PluginCallback) (*Fiber, error) {
	return c.registry.Inject(c, deps, cb)
}

// Provide 在 c 的 fiber 上提供命名服务。
func (c *Context) Provide(name string, value any, check ServiceCheck) (Disposable, error) {
	return c.reflect.Provide(c, name, value, check)
}

// Mixin 把 source 服务的指定成员以 accessor 暴露到 ctx 上。
func (c *Context) Mixin(source string, keys []string) (Disposable, error) {
	return c.reflect.Mixin(c, source, keys)
}

// Accessor 声明受检访问器。
func (c *Context) Accessor(name string, opts Accessor) (Disposable, error) {
	return c.reflect.Accessor(c, name, opts)
}

// Logger 对应 ctx.logger(...)：转发 logger 服务的 InvokeC，caller 为
// c 本身（名字解析链见方案 2.5：intercept 沿 caller 链即 use site 链
// 收集——影子 ctx 的 parent 链即外层调用链，外层 intercept 因此能覆盖
// 服务派生名；fiber 归属在 InvokeC 内取 caller.DefSite()）。
func (c *Context) Logger(name ...string) *Logger {
	args := make([]any, 0, len(name))
	for _, n := range name {
		args = append(args, n)
	}
	v, err := c.logger.InvokeC(c, args)
	if err != nil {
		// TS 此路径不抛错；出错时返回 nil 由调用方兜底（理论上不可达）。
		return nil
	}
	l, _ := v.(*Logger)
	return l
}

// Call 对应可调用服务的调用路径（TS apply trap → symbols.invoke）：以 c 为
// caller 解析服务并调用其 InvokeC。
func (c *Context) Call(name string, args ...any) (any, error) {
	v, err := c.Get(name)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, fmt.Errorf("无法调用未提供的服务 %q", name)
	}
	caller, ok := v.(Caller)
	if !ok {
		return nil, fmt.Errorf("服务 %q 不可调用", name)
	}
	return caller.InvokeC(c.DefSite(), args)
}

// registry.go 对应 TS core/src/registry.ts。TS 的三形态插件（函数/构造器/
// 对象）统一为 Plugin 描述符，装饰器映射见方案 2.3。RegistryService 的方法
// 一律显式接收 use-site ctx（TS 经 traceable 的 this.ctx 取调用方 ctx，Go 无
// Proxy，等价于基础层 Context.Plugin/Inject 转发时传入的 c）。
package kardia

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// PluginCallback 对应 TS 函数插件 (ctx, config) => any：返回插件级清理器。
type PluginCallback func(ctx *Context, config any) (Disposable, error)

// ConfigValidator 对应 Standard Schema 的 '~standard'.validate（仅同步形态，
// fiber.ts:34-46）：返回净化后的 config 或校验错误（*ValidationError）。
type ConfigValidator func(config any) (any, error)

// InjectMap 是名→拦截配置的注入声明表；声明必依赖（无配置）时值为 nil。
type InjectMap map[string]any

// Plugin 对应 TS Plugin 三形态（函数/构造器/对象，registry.ts:63-100）的统一
// 描述符。指针身份即 TS 的函数引用身份（RegistryService 以 *Plugin 为键）。
type Plugin struct {
	// Name 对应 plugin.name（对象插件的 name 字段/类名）。
	Name string
	// Inject 对应 static inject（含原型链继承，装载前经 ResolveInject 展开）。
	Inject InjectMap
	// Provide 对应 static provide。
	Provide []string
	// Config 对应 plugin.Config，可为 nil。
	Config ConfigValidator
	// Simplify 对应 runtime.Config['simplify']（loader 用于 unparse），可为 nil。
	Simplify func(any) any
	// Apply 必填；类插件在 Go 中改写为 Apply（构造 + initHooks + Init 调用）。
	Apply PluginCallback
}

// ResolveInject 对应 Inject.resolve（registry.ts:43-61）：按声明顺序合并多条
// 注入声明（含继承链），后者覆盖前者；数组形态由调用方转换为全 nil 的
// InjectMap（见 RegistryService.Inject）。
func ResolveInject(dst InjectMap, sources ...InjectMap) InjectMap {
	if dst == nil {
		dst = InjectMap{}
	}
	for _, src := range sources {
		for name, config := range src {
			dst[name] = CloneConfig(config)
		}
	}
	return dst
}

// PluginRuntime 对应 TS Plugin.Runtime（registry.ts:94-99）。
type PluginRuntime struct {
	Name     string
	Callback *Plugin
	fibers   *DisposableList[*Fiber]
	Config   ConfigValidator
	Simplify func(any) any
	apply    PluginCallback
	pending  int
	deleted  bool
}

// Apply 执行插件回调（fiber 的 runner.execute 经此调用插件本体；TS 的
// runtime.Callback 本身可调用，Go 侧以转发方法承载）。无效运行时返回
// 中文错误（fiber 的 reload 会把它记为 _error 并经 logger 上报）。
func (r *PluginRuntime) Apply(ctx *Context, config any) (Disposable, error) {
	if r == nil || r.apply == nil {
		return nil, fmt.Errorf("无效的插件运行时：缺少可执行的回调")
	}
	return r.apply(ctx, config)
}

// RegistryService 对应 TS RegistryService（registry.ts:125-214）。internal 与
// counter 的一切读写持 root 锁（方案 2.10 第 1 条）。
type RegistryService struct {
	ctx      *Context
	mu       *sync.Mutex
	counter  int64
	internal map[*Plugin]*PluginRuntime
}

func newRegistryService(ctx *Context) *RegistryService {
	return &RegistryService{
		ctx:      ctx,
		mu:       ctx.mu,
		internal: make(map[*Plugin]*PluginRuntime),
	}
}

// Size 返回已建档的插件运行时数（TS 的 size getter）。
func (r *RegistryService) Size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.internal)
}

// Counter 对应 TS 的 counter getter：自增计数并返回（插件 fiber 的 uid 来源）。
func (r *RegistryService) Counter() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counter++
	return r.counter
}

// Get 返回插件的运行时，未建档时返回 nil。
func (r *RegistryService) Get(p *Plugin) *PluginRuntime {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.internal[p]
}

// Has 报告插件是否已建档。
func (r *RegistryService) Has(p *Plugin) bool {
	return r.Get(p) != nil
}

// Delete 对应 TS delete（registry.ts:162-171）：移除档案并销毁其全部 fiber；
// 未建档返回 nil。等待全部 fiber 的共享清理任务，并汇总清理错误。
func (r *RegistryService) Delete(p *Plugin) (*PluginRuntime, error) {
	r.mu.Lock()
	runtime := r.internal[p]
	if runtime == nil {
		r.mu.Unlock()
		return nil, nil
	}
	delete(r.internal, p)
	runtime.deleted = true
	fibers := runtime.fibers.Values()
	r.mu.Unlock()
	var err error
	for _, fiber := range fibers {
		err = errors.Join(err, fiber.Dispose(context.Background()))
	}
	return runtime, err
}

// Values 返回全部运行时的快照（方案 2.10 第 5 条：锁内取快照，锁外迭代）。
func (r *RegistryService) Values() []*PluginRuntime {
	r.mu.Lock()
	defer r.mu.Unlock()
	values := make([]*PluginRuntime, 0, len(r.internal))
	for _, runtime := range r.internal {
		values = append(values, runtime)
	}
	return values
}

// Plugin 对应 ctx.plugin（registry.ts:193-213）。c 为 use-site ctx（TS 经
// traceable 的 this.ctx 取调用方 ctx；方案 2.1 规则 5 的落点）。Apply 为 nil
// 时返回错误（TS 同步 throw「invalid plugin」的中文版，plugin.spec.ts:29/36
// 的断言据此移植）；assertActive 失败返回错误；runtime 去重建档并在父 fiber
// 上登记 'ctx.plugin()' effect（注册即触发加载）。Apply 的执行错误不穿透给
// 调用方，只经 fiber 状态与 _error 暴露（TS 同）。
func (r *RegistryService) Plugin(c *Context, p *Plugin, config any) (*Fiber, error) {
	if p == nil || p.Apply == nil {
		return nil, fmt.Errorf("无效的插件：期望函数或带 %q 方法的对象，实际收到 %T", "apply", p)
	}
	if err := c.Fiber().AssertActive(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	runtime := r.internal[p]
	if runtime == nil {
		name := p.Name
		if name == "apply" {
			name = ""
		}
		runtime = &PluginRuntime{
			Name:     name,
			Callback: p,
			fibers:   &DisposableList[*Fiber]{},
			Config:   p.Config,
			Simplify: p.Simplify,
			apply:    p.Apply,
		}
		r.internal[p] = runtime
	}
	runtime.pending++
	r.mu.Unlock()
	fiber, err := newFiber(c, config, ResolveInject(nil, p.Inject), runtime)
	r.mu.Lock()
	runtime.pending--
	if runtime.pending == 0 && runtime.fibers.Len() == 0 && r.internal[p] == runtime {
		delete(r.internal, p)
	}
	r.mu.Unlock()
	return fiber, err
}

// Inject 对应 ctx.inject(deps, callback)（registry.ts:189-191）：数组形态的
// 注入声明转换为全 nil 的 InjectMap 后走 Plugin。
func (r *RegistryService) Inject(c *Context, deps []string, callback PluginCallback) (*Fiber, error) {
	inject := InjectMap{}
	for _, name := range deps {
		inject[name] = nil
	}
	return r.Plugin(c, &Plugin{Inject: inject, Apply: callback}, nil)
}

// FiberSnapshot 返回运行时的 fiber 快照。
func (r *PluginRuntime) FiberSnapshot() []*Fiber { return r.fibers.Values() }

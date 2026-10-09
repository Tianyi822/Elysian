// fiber.go 对应 TS core/src/fiber.ts。Fiber 的异步生命周期在 Go 侧映射为
// goroutine + context.Context + root 锁（方案 2.2 与 2.10）：TS 的微任务
// （Promise.resolve、async 函数体）统一改写为经 ctx.Tasks() 登记的 goroutine；
// _reload/_unload 的同步段（store 浅拷贝、disposables 清空）保持在触发点
// 原地执行，与 TS「async 函数首个 await 前的代码同步运行」一致。TS 的
// thenable 包装（wrapped fiber）无 Go 等价，Await 即等待通道。
package kardia

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// FiberState 对应 TS FiberState 枚举（fiber.ts:78-85），取值是协议值。
type FiberState int

const (
	FiberPending   FiberState = iota // TS FiberState.PENDING
	FiberLoading                     // LOADING
	FiberActive                      // ACTIVE
	FiberFailed                      // FAILED
	FiberDisposed                    // DISPOSED
	FiberUnloading                   // UNLOADING
)

// String 返回协议文案（英文原样保留）。
func (s FiberState) String() string {
	switch s {
	case FiberPending:
		return "PENDING"
	case FiberLoading:
		return "LOADING"
	case FiberActive:
		return "ACTIVE"
	case FiberFailed:
		return "FAILED"
	case FiberDisposed:
		return "DISPOSED"
	case FiberUnloading:
		return "UNLOADING"
	default:
		return "UNKNOWN"
	}
}

// epochInactive 对应 TS 的 '__INACTIVE__' 哨兵（fiber.ts:101，跨端协议值）。
const epochInactive = "__INACTIVE__"

// CordisError 保留 Cordis 错误码，面向使用者的错误文案为中文。
type CordisError struct {
	Code string // 目前仅 "INACTIVE_EFFECT"
	Msg  string
}

func (e *CordisError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	if e.Code == "INACTIVE_EFFECT" {
		return "无法在非激活上下文中创建副作用"
	}
	return e.Code
}

// Issue 对应 Standard Schema 的校验问题项。
type Issue struct {
	Path    string
	Message string
}

// ValidationError 对应 fiber.ts:16-32 的校验错误。
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	var b strings.Builder
	b.WriteString("无效的配置：")
	for _, issue := range e.Issues {
		if issue.Path != "" {
			fmt.Fprintf(&b, "\n  - %s（位于 %s）", issue.Message, issue.Path)
		} else {
			fmt.Fprintf(&b, "\n  - %s", issue.Message)
		}
	}
	return b.String()
}

// resolveConfig 对应 fiber.ts:34-46：经运行时校验器净化 config；无校验器时
// 直通。校验错误（含 *ValidationError）原样返回。
func resolveConfig(runtime *PluginRuntime, config any) (out any, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("配置校验发生 panic: %v", v)
		}
	}()
	if runtime == nil || runtime.Config == nil {
		return CloneConfig(config), nil
	}
	out, err = runtime.Config(CloneConfig(config))
	return CloneConfig(out), err
}

// Disposable 对应 TS 的 `() => Awaitable<void>`：同步或异步清理器统一形态。
// 重复调用必须幂等（effect 包装器与插件级清理器都遵守）。
type Disposable func(ctx context.Context) error

// EffectFunc 同步「返回型」副作用：对应 TS effect 返回 Disposable 的形态。
type EffectFunc func() (Disposable, error)

// EffectGen 迭代型副作用：对应 TS 同步/异步生成器 effect。gen 在独立
// goroutine（经 ctx.Tasks() 登记启动）中被拉取：每 yield 一个清理器即刻
// 登记；epoch 变化（dispose/restart）时以 ctx 取消拉取，gen 应在阻塞等待处
// 感知 ctx 退出。gen 体内的等待只能用注入时钟（Clock/After）或 select
// ctx.Done()，不得真实 sleep。
type EffectGen func(ctx context.Context, yield func(Disposable) error) error

// EffectMeta 对应 fiber.ts:66-69 的 effect 元树。
type EffectMeta struct {
	Label    string
	Children []EffectMeta
}

// errEffectStopped 由 yield 返回：epoch 已翻转，生成器应尽快返回；拉取侧
// 将其视为协作停止而非失败。
var errEffectStopped = errors.New("effect 已停止")

// fiberRunner 对应 TS EffectRunner<string>（fiber.ts:71-76）：epoch 驱动
// reload/unload 的翻转。
type fiberRunner struct {
	epoch   string
	execute func(config any) (Disposable, error)
	collect func(Disposable)
}

// inertiaTask 是 fiber 惯性任务（TS inertia: Promise<void> | undefined）：
// reload/unload 的执行句柄，完成即关闭 done。实现 Task 供 loader 的
// EntryTree.GetTasks 收集（方案 2.7）。
type inertiaTask struct {
	done chan struct{}
}

func newInertiaTask() *inertiaTask {
	return &inertiaTask{done: make(chan struct{})}
}

// Wait 实现 Task：等待任务完成或 ctx 取消。
func (t *inertiaTask) Wait(ctx context.Context) error {
	select {
	case <-t.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// disposableEntry 是 fiberDisposables 的条目；st 非 nil 表示 effect 包装器
// （meta 为其元数据；树形 children 经 st.children 在查询时递归展开）。
type disposableEntry struct {
	sn   uint64
	fn   Disposable
	meta *EffectMeta
	st   *effectState
}

// fiberDisposables 对应 TS Fiber._disposables（DisposableList<Disposable>）。
// Go 函数值不可比较（无法按值删除，也无法复用 DisposableList），改按条目
// 指针管理删除。方法自身不加锁：由调用方持 root 锁（方案 2.10）。
type fiberDisposables struct {
	sn    uint64
	order []*disposableEntry
}

// Len 返回当前长度。
func (l *fiberDisposables) Len() int { return len(l.order) }

// push 登记清理器并返回条目（remove 按条目指针删除）。
func (l *fiberDisposables) push(fn Disposable, meta *EffectMeta, st *effectState) *disposableEntry {
	l.sn++
	entry := &disposableEntry{sn: l.sn, fn: fn, meta: meta, st: st}
	l.order = append(l.order, entry)
	return entry
}

// remove 删除给定条目（不存在时为 no-op）。
func (l *fiberDisposables) remove(entry *disposableEntry) {
	if entry == nil {
		return
	}
	for i, e := range l.order {
		if e == entry {
			l.order = append(l.order[:i], l.order[i+1:]...)
			return
		}
	}
}

// Clear 清空并按插入序逆序返回全部清理器（TS clear 的 dispose 顺序）。
func (l *fiberDisposables) Clear() []Disposable {
	fns := make([]Disposable, 0, len(l.order))
	for _, e := range l.order {
		fns = append(fns, e.fn)
	}
	l.order = nil
	for i, j := 0, len(fns)-1; i < j; i, j = i+1, j-1 {
		fns[i], fns[j] = fns[j], fns[i]
	}
	return fns
}

// wrappers 返回插入序快照（测试内省，对应 _disposables 的展开）。
func (l *fiberDisposables) wrappers() []Disposable {
	fns := make([]Disposable, 0, len(l.order))
	for _, e := range l.order {
		fns = append(fns, e.fn)
	}
	return fns
}

// effectMetas 返回根级 effect 的元树（对应 getEffects：st 为 nil 的插件级
// 清理器不计入；嵌套 effect 出现在 children，查询时经 st.children 递归展开——
// 迭代型子 effect 的树在其生成器收敛后才完整）。
func (l *fiberDisposables) effectMetas() []EffectMeta {
	metas := make([]EffectMeta, 0, len(l.order))
	for _, e := range l.order {
		if e.st != nil {
			metas = append(metas, effectMetaTree(e.st))
		}
	}
	return metas
}

// effectMetaTree 以 st 为根递归展开元树（Label 取自身、children 取创建时
// 登记的嵌套 effect 状态）。
func effectMetaTree(st *effectState) EffectMeta {
	m := EffectMeta{Label: st.meta.Label, Children: []EffectMeta{}}
	for _, child := range st.children {
		m.Children = append(m.Children, effectMetaTree(child))
	}
	return m
}

// hookEntry 是 fiber 级钩子表条目。
type hookEntry struct {
	sn uint64
	cb Listener
}

// hookList 对应 TS _hooks[name] 的 DisposableList<Function>（fiber.ts:112）：
// Go 函数值不可比较，改按序号登记。全部方法自行持所属 fiber 的 root 锁
// （方案 2.10）；events 服务的内建钩子（internal/listener / internal-update，
// 方案 2.4）经 Fiber.hookList 使用。
type hookList struct {
	fiber *Fiber
	sn    uint64
	order []hookEntry
}

// Push 尾部追加，返回按序号移除函数。
func (l *hookList) Push(cb Listener) func() {
	l.fiber.mu.Lock()
	defer l.fiber.mu.Unlock()
	l.sn++
	sn := l.sn
	l.order = append(l.order, hookEntry{sn: sn, cb: cb})
	return func() { l.remove(sn) }
}

// Unshift 头部前插，返回按序号移除函数。
func (l *hookList) Unshift(cb Listener) func() {
	l.fiber.mu.Lock()
	defer l.fiber.mu.Unlock()
	l.sn++
	sn := l.sn
	l.order = append([]hookEntry{{sn: sn, cb: cb}}, l.order...)
	return func() { l.remove(sn) }
}

// Values 返回回调快照（登记顺序）。
func (l *hookList) Values() []Listener {
	l.fiber.mu.Lock()
	defer l.fiber.mu.Unlock()
	values := make([]Listener, 0, len(l.order))
	for _, e := range l.order {
		values = append(values, e.cb)
	}
	return values
}

// Len 返回当前长度。
func (l *hookList) Len() int {
	l.fiber.mu.Lock()
	defer l.fiber.mu.Unlock()
	return len(l.order)
}

func (l *hookList) remove(sn uint64) {
	l.fiber.mu.Lock()
	defer l.fiber.mu.Unlock()
	for i, e := range l.order {
		if e.sn == sn {
			l.order = append(l.order[:i], l.order[i+1:]...)
			return
		}
	}
}

// Fiber 对应 TS Fiber（fiber.ts:103-496）。字段私有，全部可变字段的读写持
// root 锁（方案 2.10 第 1 条）；回调（Apply、生成器、清理器）一律锁外调用。
type Fiber struct {
	initializing   bool
	mu             *sync.Mutex
	parent         *Context
	own            *Context
	uidVal         int64
	uidLive        bool
	config         any
	state          FiberState
	inject         InjectMap
	runtime        *PluginRuntime
	store          map[string]*Impl
	resolved       map[string]*Impl
	checkRevision  map[string]uint64
	inertia        *inertiaTask
	hooks          map[EventName]*hookList
	disposables    *fiberDisposables
	err            error
	runner         *fiberRunner
	disposeFn      Disposable
	generation     uint64
	scope          *EffectScope
	closing        bool
	cleanupErr     error
	updateRevision uint64
}

// newFiber 对应 TS Fiber 构造器（fiber.ts:122-213）。runtime 非 nil 走插件
// 分支：uid 取自注册表计数、own 为挂载本 fiber 的扩展层（注入项带拦截配置
// 时叠加本层 intercept）、注册即派发 internal/plugin、逐注入名 checkImpl，
// 并在父 fiber 上登记 'ctx.plugin()' effect（注册即触发加载，其清理器承载
// 卸载语义：uid 置空、撤销 runtime 登记、epoch 置 INACTIVE 并等惯性排空）。
// runtime 为 nil 走根分支：uid=0、ACTIVE、store 空表、dispose=restart。
// config 经 effect 内的 resolveConfig 解析后才落到 fiber.config（解析失败
// 记 _error 且不触发加载，TS 同）。
func newFiber(parent *Context, config any, inject InjectMap, runtime *PluginRuntime) (*Fiber, error) {
	f := &Fiber{
		mu:          parent.mu,
		parent:      parent,
		inject:      inject,
		runtime:     runtime,
		resolved:    make(map[string]*Impl),
		disposables: &fiberDisposables{},
		hooks:       make(map[EventName]*hookList),
	}
	if runtime == nil {
		f.uidVal = 0
		f.uidLive = true
		f.own = parent
		f.state = FiberActive
		f.store = make(map[string]*Impl)
		f.runner = &fiberRunner{
			epoch: "",
			execute: func(any) (Disposable, error) {
				return nil, nil
			},
			collect: f.collectDisposable,
		}
		f.scope = newEffectScope(f, 0)
		f.disposeFn = func(ctx context.Context) error {
			return f.Restart(ctx)
		}
		return f, nil
	}
	f.scope = newEffectScope(f, 0)
	f.initializing = true
	f.uidVal = parent.Registry().Counter()
	f.uidLive = true
	f.own = parent.Extend(ExtendMeta{Fiber: f})
	if len(inject) > 0 {
		// TS：this.ctx[Context.intercept] = Object.create(parent[...]) 后写入
		// 非空注入配置（fiber.ts:137-144）；Go 侧为本层独立的 Intercept 表，
		// 沿链收集语义等价（Context.InterceptAll）。
		intercept := make(map[string]any)
		for name, cfg := range inject {
			if cfg != nil {
				intercept[name] = cfg
			}
		}
		f.own.meta.Intercept = intercept
	}
	f.runner = &fiberRunner{
		epoch: epochInactive,
		execute: func(cfg any) (Disposable, error) {
			return runtime.Apply(f.own.withScope(f.Scope()), cfg)
		},
		collect: f.collectDisposable,
	}
	var disposeFn Disposable
	disposeReady := make(chan struct{})
	f.disposeFn = func(ctx context.Context) error {
		select {
		case <-disposeReady:
			return disposeFn(ctx)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	var err error
	disposeFn, err = parent.Effect("ctx.plugin()", func() (Disposable, error) {
		cfg, cfgErr := resolveConfig(runtime, config)
		f.mu.Lock()
		if runtime.deleted {
			f.mu.Unlock()
			return nil, fmt.Errorf("插件运行时已卸载")
		}
		remove := runtime.fibers.Push(f)
		if cfgErr == nil {
			f.config = cfg
		}
		f.mu.Unlock()
		// 先把 fiber 发布到注册表，再读取依赖，避免错过并发提供者的就绪通知。
		if eventErr := f.own.Events().EmitTo(f.own, StringEvent("internal/plugin"), f); cfgErr == nil {
			cfgErr = eventErr
		}
		for _, name := range sortedInjectNames(f.Inject()) {
			f.checkImpl(name)
		}
		f.mu.Lock()
		f.initializing = false
		f.mu.Unlock()
		if cfgErr != nil {
			f.own.Logger().Error(cfgErr)
			f.mu.Lock()
			f.err = cfgErr
			f.mu.Unlock()
		} else {
			f.refresh()
		}
		return func(dctx context.Context) error {
			f.mu.Lock()
			f.uidLive = false
			f.mu.Unlock()
			_ = f.own.Events().EmitTo(f.own, StringEvent("internal/plugin"), f)
			reg := f.own.Registry()
			reg.mu.Lock()
			remove()
			if reg.internal[runtime.Callback] == runtime && runtime.pending == 0 && runtime.fibers.Len() == 0 {
				delete(reg.internal, runtime.Callback)
			}
			reg.mu.Unlock()
			f.setEpoch(epochInactive)
			if err := f.drainInertia(dctx); err != nil {
				return err
			}
			f.mu.Lock()
			err := f.cleanupErr
			f.mu.Unlock()
			return err
		}, nil
	})
	if err != nil {
		f.mu.Lock()
		f.uidLive = false
		f.scope.cancel()
		f.mu.Unlock()
		disposeFn = func(context.Context) error { return err }
	}
	close(disposeReady)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// collectDisposable 对应 TS 构造器内的 collect：插件级清理器直接进
// _disposables（无 effect 元数据，getEffects 不可见）。
func (f *Fiber) collectDisposable(d Disposable) {
	if d == nil {
		return
	}
	f.mu.Lock()
	f.disposables.push(d, nil, nil)
	f.mu.Unlock()
}

// UID 返回 uid（nil=已销毁；根 fiber 恒为 0，对应 TS uid: number | null）。
func (f *Fiber) UID() *int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.uidLive {
		return nil
	}
	v := f.uidVal
	return &v
}

// uidString 返回 uid 的字符串形态（须持锁；对应 TS 的 `${impl.fiber.uid}`）。
func (f *Fiber) uidString() string {
	if !f.uidLive {
		return "null"
	}
	return strconv.FormatInt(f.uidVal, 10)
}

// Ctx 返回挂载本 fiber 的 ctx（根 fiber 为根 ctx 本身）。
func (f *Fiber) Ctx() *Context { return f.own }

// Config 返回当前配置（Update 的瀑布终点写入）。
func (f *Fiber) Config() any {
	f.mu.Lock()
	value := f.config
	f.mu.Unlock()
	return CloneConfig(value)
}

// State 返回当前状态字段（TS 的 fiber.state）。
func (f *Fiber) State() FiberState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

// Store 返回活跃实现表快照（TS 的 fiber.store，UNLOADING/PENDING 时为空）。
func (f *Fiber) Store() map[string]*Impl {
	f.mu.Lock()
	defer f.mu.Unlock()
	store := make(map[string]*Impl, len(f.store))
	for k, v := range f.store {
		store[k] = v
	}
	return store
}

// Inject 返回注入声明表快照（名→拦截配置）。
func (f *Fiber) Inject() map[string]any {
	f.mu.Lock()
	inject := make(map[string]any, len(f.inject))
	for k, v := range f.inject {
		inject[k] = v
	}
	f.mu.Unlock()
	for k, v := range inject {
		inject[k] = CloneConfig(v)
	}
	return inject
}

// MergeInject 对应 loader 侧 Inject.resolve(entry.options.inject,
// fiber.inject) 的合并入口（loader/src/index.ts:94，resolve 的写入侧是
// 第二个参数即 fiber 的实例表）：把 extra 的键值无条件并入本 fiber 的
// 注入声明（同名以 extra 为准，值 nil 表示必依赖）。仅应在 fiber 创建
// 事件（internal/plugin 且 uid 仍在）的监听器中调用——构造器在该事件
// 之后才逐名 checkImpl 并触发加载刷新，合并结果因此参与依赖解析；
// 拦截叠加发生在事件之前，extra 不再进入本层 intercept（与 TS 同序）。
func (f *Fiber) MergeInject(extra InjectMap) {
	if len(extra) == 0 {
		return
	}
	extra = ResolveInject(nil, extra)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.inject == nil {
		f.inject = make(InjectMap, len(extra))
	}
	for name, cfg := range extra {
		f.inject[name] = cfg
	}
}

// Runtime 返回插件运行时（根 fiber 为 nil）。
func (f *Fiber) Runtime() *PluginRuntime {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runtime
}

// Disposables 返回 _disposables 的插入序快照（测试内省，对应
// plugin.spec 的 _disposables.length 断言）。
func (f *Fiber) Disposables() []Disposable {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.disposables.wrappers()
}

// GetEffects 对应 getEffects（fiber.ts:342-346）：只含根级 effect 的元树；
// 通过同一个 EffectScope 显式创建的子资源出现在 children。
func (f *Fiber) GetEffects() []EffectMeta {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.disposables.effectMetas()
}

// Name 对应 fiber.ts:215-221 的沿父查找：自身 runtime 无名则沿 parent.fiber
// 上溯，根为 "root"。
func (f *Fiber) Name() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := f
	for {
		if cur.runtime != nil && cur.runtime.Name != "" {
			return cur.runtime.Name
		}
		if cur.parent == nil {
			break
		}
		parentFiber := cur.parent.Fiber()
		if parentFiber == cur {
			break
		}
		cur = parentFiber
	}
	return "root"
}

// AssertActive 对应 assertActive（fiber.ts:224-227）：uid 已置空（已销毁）时
// 返回 INACTIVE_EFFECT 协议错误。
func (f *Fiber) AssertActive() error {
	f.mu.Lock()
	live := f.uidLive
	f.mu.Unlock()
	if live {
		return nil
	}
	return &CordisError{Code: "INACTIVE_EFFECT"}
}

// Dispose 对应 TS fiber.dispose()：幂等。插件 fiber 为父 fiber 上
// 'ctx.plugin()' effect 的包装器（卸载语义见 newFiber）；根 fiber 等价
// restart。清理错误聚合返回，既有加载失败由 Await 返回。
func (f *Fiber) Dispose(ctx context.Context) error {
	return f.disposeFn(ctx)
}

// Await 对应 fiber.ts:462-468：循环等待惯性排空；存在 _error 时返回它
// （TS 的 await fiber 抛错通道，thenable 断言的 Go 等价物）。
func (f *Fiber) Await(ctx context.Context) (*Fiber, error) {
	for {
		f.mu.Lock()
		t := f.inertia
		f.mu.Unlock()
		if t == nil {
			break
		}
		if err := t.Wait(ctx); err != nil {
			return nil, err
		}
	}
	f.mu.Lock()
	err := errors.Join(f.err, f.cleanupErr)
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return f, nil
}

// Inertia 返回当前惯性任务；无惯性（未启动或已排空）时返回 nil，
// 对应 TS fiber.inertia 的 undefined。供 loader 的 EntryTree.GetTasks
// 收集（方案 2.7；方案 2.2 之外的补充导出），收集方须跳过 nil
// （tree.ts:52-55 的 filter(isNonNullable)）。nil 判断必须落在具体类型
// 上：f.inertia 为 *inertiaTask，直接返回会把 typed-nil 包进接口。
func (f *Fiber) Inertia() Task {
	f.mu.Lock()
	t := f.inertia
	f.mu.Unlock()
	if t == nil {
		return nil
	}
	return t
}

// Restart 对应 fiber.ts:470-476：assertActive 后置 INACTIVE、刷新 epoch 并
// 等待惯性排空；排空后的加载错误（若有）作为返回值。
func (f *Fiber) Restart(ctx context.Context) error {
	if err := f.AssertActive(); err != nil {
		return err
	}
	f.setEpoch(epochInactive)
	f.refresh()
	_, err := f.Await(ctx)
	return err
}

// CancelActivation 请求停止当次激活而保留插件身份；后续 Update 可重新激活。
// 调用不等待用户回调退出，回调必须响应 Lifetime 的协作取消信号。
func (f *Fiber) CancelActivation() { f.setEpoch(epochInactive) }

// CancelLoading 仅取消尚未完成的加载，不触发回调或等待。
// 返回 true 表示调用者需在旧代清理完成后提交下一次更新。
func (f *Fiber) CancelLoading() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != FiberLoading || f.inertia == nil || !f.uidLive {
		return false
	}
	f.runner.epoch = epochInactive
	f.closing = true
	f.scope.cancel()
	return true
}

// updateApplied 是 Update 瀑布终点的哨兵值：瀑布结果为其时表示未被否决。
type updateApplied struct{}

// Update 对应 fiber.ts:478-495。config 先经 resolveConfig；随后以 thisArg=
// 本 fiber 派发 internal/update 瀑布，终点写入新 config、清 _error 并触发
// restart。监听者未调用 next 且正常返回即否决（不等待、不重启、返回 nil）；
// 瀑布错误中止并穿透；未被否决时等待惯性排空并把加载错误返回给调用方
// （调用方不等待也不产生未处理错误：错误同时经 fiber 状态暴露）。
func (f *Fiber) Update(ctx context.Context, config any, noSave bool) error {
	f.mu.Lock()
	fiber := f.own.Fiber()
	runtime := fiber.runtime
	f.mu.Unlock()
	if err := fiber.AssertActive(); err != nil {
		return err
	}
	if runtime == nil {
		return fmt.Errorf("无法在根 fiber 上更新配置")
	}
	f.mu.Lock()
	fiber.updateRevision++
	revision := fiber.updateRevision
	f.mu.Unlock()
	cfg, err := resolveConfig(runtime, config)
	if err != nil {
		return err
	}
	result, werr := f.own.Events().WaterfallTo(fiber, StringEvent("internal/update"), func(ev *EventCtx) (any, error) {
		f.mu.Lock()
		if !fiber.uidLive || fiber.updateRevision != revision {
			f.mu.Unlock()
			return nil, fmt.Errorf("插件配置更新已过期")
		}
		fiber.config = cfg
		fiber.err = nil
		f.mu.Unlock()
		fiber.setEpoch(epochInactive)
		fiber.refresh()
		return updateApplied{}, nil
	}, cfg, noSave)
	if werr != nil {
		return werr
	}
	if _, ok := result.(updateApplied); !ok {
		// 被监听者否决：无重启可等待。
		return nil
	}
	_, err = fiber.Await(ctx)
	return err
}

// Scope 返回当前激活代的资源作用域。异步代码应捕获调用方 Context.Scope()。
func (f *Fiber) Scope() *EffectScope {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scope
}

// Effect 在当前激活代登记同步副作用。
func (f *Fiber) Effect(label string, execute EffectFunc) (Disposable, error) {
	h, err := f.Scope().Effect(label, execute)
	if err != nil {
		return nil, err
	}
	return h.Dispose, nil
}

// EffectIter 在当前激活代登记生产者；嵌套资源必须使用显式 Scope。
func (f *Fiber) EffectIter(label string, gen EffectGen) (Disposable, error) {
	h, err := f.Scope().Iter(label, func(ctx context.Context, scope *EffectScope) error {
		return gen(ctx, scope.Defer)
	})
	if err != nil {
		return nil, err
	}
	return h.Dispose, nil
}

// hookList 取（或惰性创建）fiber 级事件钩子表（events 服务内建钩子使用，
// events.ts:54-69 的 Go 侧落点）。方法与表的全部操作均自行持 root 锁。
func (f *Fiber) hookList(name EventName) *hookList {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hooks == nil {
		f.hooks = make(map[EventName]*hookList)
	}
	l := f.hooks[name]
	if l == nil {
		l = &hookList{fiber: f}
		f.hooks[name] = l
	}
	return l
}

// —— 状态机（fiber.ts:348-468）——

// transition 对应 _updateState（fiber.ts:355-369）：compute 在锁内执行（可
// 翻转 inertia 等并返回新状态；ok=false 时回落 _getState 的推导）。状态
// 变化时锁外派发 internal/status，且仅在 ACTIVE↔非 ACTIVE 沿上通知本
// fiber 提供的服务刷新（reflect.notify）。
func (f *Fiber) transition(compute func() (FiberState, bool)) {
	f.mu.Lock()
	oldState := f.state
	next, ok := compute()
	if !ok {
		next = f.getStateLocked()
	}
	f.state = next
	var notifyNames []string
	if oldState != next && (oldState == FiberActive || next == FiberActive) {
		for _, impl := range f.own.Reflect().store {
			if impl.Fiber == f {
				notifyNames = append(notifyNames, impl.Name)
			}
		}
	}
	f.mu.Unlock()
	if oldState == next {
		return
	}
	sort.Strings(notifyNames)
	if err := f.own.Events().EmitTo(f.own, StringEvent("internal/status"), f, oldState); err != nil {
		f.own.Logger().Error(err)
	}
	for _, name := range notifyNames {
		if _, err := f.own.Reflect().Notify(f.own, []string{name}); err != nil {
			f.own.Logger().Error(err)
		}
	}
}

// getStateLocked 对应 _getState（fiber.ts:348-353），须持锁。
func (f *Fiber) getStateLocked() FiberState {
	if !f.uidLive {
		return FiberDisposed
	}
	if f.err != nil {
		return FiberFailed
	}
	if f.runner.epoch != epochInactive {
		return FiberActive
	}
	return FiberPending
}

// checkImpl 对应 _checkImpl（fiber.ts:371-383）：按当前实现表刷新 _store；
// 实现缺失或 check 不通过时删除。
func (f *Fiber) checkImpl(name string) {
	f.mu.Lock()
	if f.checkRevision == nil {
		f.checkRevision = map[string]uint64{}
	}
	f.checkRevision[name]++
	revision := f.checkRevision[name]
	f.mu.Unlock()
	impl := f.own.Reflect().getImpl(f.own, name, true)
	ready := impl != nil
	if ready && impl.Check != nil {
		ready = f.checkService(impl)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.checkRevision[name] != revision {
		return
	}
	if ready {
		f.resolved[name] = impl
	} else {
		delete(f.resolved, name)
	}
}

// refresh 对应 _refresh（fiber.ts:385-397）：按注入声明的键序拼接 epoch 串
// （':' + 各注入 impl.fiber.uid 依次拼接；实现缺失则为 INACTIVE 哨兵）。
func (f *Fiber) refresh() {
	f.mu.Lock()
	if f.initializing {
		f.mu.Unlock()
		return
	}
	epoch := ""
	for _, name := range sortedInjectNames(f.inject) {
		impl := f.resolved[name]
		if impl == nil {
			epoch = epochInactive
			break
		}
		epoch += ":" + impl.Fiber.uidString()
	}
	if !f.uidLive {
		epoch = epochInactive
	}
	launch := f.setEpochLocked(epoch)
	f.mu.Unlock()
	if launch != nil {
		launch()
	}
}

// setEpoch 在同一临界区接纳目标并登记任务，回调在锁外运行。
func (f *Fiber) setEpoch(epoch string) {
	f.mu.Lock()
	launch := f.setEpochLocked(epoch)
	f.mu.Unlock()
	if launch != nil {
		launch()
	}
}

// setEpochLocked 的返回闭包负责锁外通知和调度，调用方必须执行它。
func (f *Fiber) setEpochLocked(epoch string) func() {
	oldEpoch := f.runner.epoch
	if epoch == oldEpoch || f.err != nil && epoch != epochInactive {
		return nil
	}
	f.runner.epoch = epoch
	if epoch == epochInactive {
		f.closing = true
		f.scope.cancel()
	}
	if f.inertia != nil {
		return nil
	}
	task := newInertiaTask()
	f.inertia = task
	loading := epoch != epochInactive && oldEpoch == epochInactive
	var items []Disposable
	if loading {
		f.copyStoreLocked()
	} else {
		f.closing = true
		f.scope.cancel()
		items = f.disposables.Clear()
	}
	return func() {
		if loading {
			f.transition(func() (FiberState, bool) { return FiberLoading, true })
			f.own.Tasks().Go(func() { f.reloadBody(task, epoch) })
		} else {
			f.transition(func() (FiberState, bool) { return FiberUnloading, true })
			f.own.Tasks().Go(func() { f.unloadBody(task, items) })
		}
	}
}

// copyStoreLocked 对应 _reload 的 `this.store = { ...this._store }`，须持锁。
func (f *Fiber) copyStoreLocked() {
	f.generation++
	f.scope = newEffectScope(f, f.generation)
	f.closing = false
	store := make(map[string]*Impl, len(f.resolved))
	for k, v := range f.resolved {
		store[k] = v
	}
	f.store = store
}

// reloadBody 对应 _reload（fiber.ts:417-437）：执行插件 Apply（锁外），失败
// 记 _error、置 epoch=INACTIVE 并经 logger 上报；随后按 epoch 是否回摆决定
// 收尾（inertia 排空）或链接 _unload。oldEpoch 是本次 reload 启动时的 epoch。
func (f *Fiber) reloadBody(task *inertiaTask, oldEpoch string) {
	defer close(task.done)
	f.mu.Lock()
	execute := f.runner.execute
	collect := f.runner.collect
	cfg := f.config
	runtime := f.runtime
	cancelledBeforeStart := f.closing
	f.mu.Unlock()
	if runtime != nil && !cancelledBeforeStart {
		d, err := safeExecute(func() (Disposable, error) {
			return execute(CloneConfig(cfg))
		})
		collect(d)
		if err != nil {
			f.mu.Lock()
			// 被停止的激活代只负责回收，不能把取消错误写回后继激活代。
			cancelled := f.closing
			if !cancelled {
				f.err = err
				f.runner.epoch = epochInactive
			}
			f.mu.Unlock()
			var inactive *CordisError
			expectedStop := errors.Is(err, context.Canceled) || errors.As(err, &inactive) && inactive.Code == "INACTIVE_EFFECT"
			if !cancelled || !expectedStop {
				f.own.Logger().Error(err)
			}
		}
	}
	// 先发布状态与依赖通知，再完成惯性任务；Await 不会早于通知返回。
	f.transition(func() (FiberState, bool) {
		if f.runner.epoch == oldEpoch && !f.closing {
			return 0, false
		}
		return FiberUnloading, true
	})
	f.mu.Lock()
	if f.runner.epoch == oldEpoch && !f.closing {
		f.inertia = nil
		f.mu.Unlock()
		return
	}
	unloadTask := newInertiaTask()
	f.inertia = unloadTask
	f.closing = true
	f.scope.cancel()
	items := f.disposables.Clear()
	f.mu.Unlock()
	f.transition(func() (FiberState, bool) { return FiberUnloading, true })
	f.own.Tasks().Go(func() { f.unloadBody(unloadTask, items) })
}

// unloadBody 逆序回收全部资源，聚合清理错误，随后兑现最新的目标激活代。
func (f *Fiber) unloadBody(task *inertiaTask, items []Disposable) {
	defer close(task.done)
	var cleanupErr error
	for _, d := range items {
		cleanupErr = errors.Join(cleanupErr, safeDispose(d, context.Background()))
	}
	if cleanupErr != nil {
		f.own.Logger().Error(cleanupErr)
	}
	f.mu.Lock()
	f.store = nil
	f.cleanupErr = errors.Join(f.cleanupErr, cleanupErr)
	f.mu.Unlock()
	f.transition(func() (FiberState, bool) {
		if f.runner.epoch == epochInactive {
			return 0, false
		}
		return FiberLoading, true
	})
	f.mu.Lock()
	if f.runner.epoch == epochInactive {
		f.inertia = nil
		f.mu.Unlock()
		return
	}
	reloadTask := newInertiaTask()
	reloadEpoch := f.runner.epoch
	f.inertia = reloadTask
	f.copyStoreLocked()
	f.mu.Unlock()
	f.transition(func() (FiberState, bool) { return FiberLoading, true })
	f.own.Tasks().Go(func() { f.reloadBody(reloadTask, reloadEpoch) })
}

// drainInertia 对应插件卸载清理器里的 `while (this.inertia) await this.inertia`
// （fiber.ts:195-197）：循环等待惯性排空，不抛加载错误。
func (f *Fiber) drainInertia(ctx context.Context) error {
	for {
		f.mu.Lock()
		t := f.inertia
		f.mu.Unlock()
		if t == nil {
			return nil
		}
		if err := t.Wait(ctx); err != nil {
			return err
		}
	}
}

// sortedInjectNames 返回注入声明的确定性键序。TS 用 Object.keys 的插入序
// 拼 epoch 串；Go map 无插入序，改按字典序（同一 fiber 的 epoch 相等性判定
// 不受影响）。
func sortedInjectNames(inject InjectMap) []string {
	names := make([]string, 0, len(inject))
	for name := range inject {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// safeExecute 在副作用执行边界 recover panic 并转为错误（方案 2.10 第 4 条）。
func safeExecute(execute EffectFunc) (d Disposable, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("副作用执行发生 panic: %v", v)
		}
	}()
	return execute()
}

// safeDispose 在清理器调用边界 recover panic 并转为错误（方案 2.10 第 4 条）。
func safeDispose(d Disposable, ctx context.Context) (err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("清理器发生 panic: %v", v)
		}
	}()
	return d(ctx)
}

// checkService 把检查器错误作为不可用依赖报告，禁止 panic 穿越框架边界。
func (f *Fiber) checkService(impl *Impl) (ready bool) {
	defer func() {
		if v := recover(); v != nil {
			f.own.Logger().Error(fmt.Errorf("服务检查发生 panic: %v", v))
			ready = false
		}
	}()
	f.mu.Lock()
	check, value := impl.Check, impl.Value
	f.mu.Unlock()
	ready, err := check(f.own, value)
	if err != nil {
		f.own.Logger().Error(err)
		return false
	}
	return ready
}

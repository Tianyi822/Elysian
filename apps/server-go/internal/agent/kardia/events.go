// events.go 对应 TS core/src/events.ts。四种（加 parallel 共五种）分发模式
// 按 events.ts 的行为契约移植（方案 2.4）：emit/serial/bail 同步逐个派发，
// parallel 全部完成后聚合失败，waterfall 以 next 链逐层穿透。TS 的
// reflect.bind(listener)（对 thisArg 与参数做 trace 包装）依赖 Proxy，Go 无
// 对应（差异清单第 8 条）：监听器直接收到原始 This/Args。
//
// On/Once 显式接收 use-site ctx（TS EventsService 的 noShadow tracker 使
// this.ctx 解析到调用方 ctx，events.ts:49-52；Go 侧由 Context.On 转发时
// 传入，见 deviations）。
package kardia

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
)

// DispatchMode 对应 TS DispatchMode（跨端协议值，保留英文）。
type DispatchMode string

const (
	ModeEmit      DispatchMode = "emit"
	ModeParallel  DispatchMode = "parallel"
	ModeSerial    DispatchMode = "serial"
	ModeBail      DispatchMode = "bail"
	ModeWaterfall DispatchMode = "waterfall"
)

// EventOptions 对应 TS EventOptions（events.ts:35-38）。
type EventOptions struct {
	Prepend bool
	Global  bool
}

// EventCtx 携带 thisArg 与参数；Waterfall 模式下 Next 非空（对应 TS 监听器
// 的最后一个 next 参数）。This 对应 TS 的 this（thisArg），可为 nil。
type EventCtx struct {
	Context context.Context
	This    any
	Args    []any
	Next    func() (any, error)
}

// Listener 返回 (结果, 错误)：错误是该监听器在此分发模式下的失败通道
// （TS 的同步 throw / 异步 reject），各模式对错误的处理见方案 2.4。
type Listener func(ev *EventCtx) (any, error)

// Hook 对应 TS Hook（events.ts:40-43）。
type Hook struct {
	Ctx      *Context
	Callback Listener
	Global   bool
	Prepend  bool
}

// FilterCarrier 对应 TS 的 `[Context.filter]`（service.ts:37-39 的 Service
// 实现与测试的 Session 实现）：以 thisArg 的视角裁决 hook.Ctx 是否可见。
type FilterCarrier interface {
	CordisFilter(target *Context) bool
}

// AggregateError 对应 TS 的 AggregateError（parallel 模式的失败聚合，
// 方案 2.4/2.11），通过 Unwrap 支持标准库 errors.Is/As。
type AggregateError struct {
	Errors []error
}

// Unwrap 保留标准库 errors.Is/As 的聚合错误语义。
func (e *AggregateError) Unwrap() []error { return e.Errors }

// Error 返回聚合中文文案。
func (e *AggregateError) Error() string {
	msgs := make([]string, 0, len(e.Errors))
	for _, err := range e.Errors {
		msgs = append(msgs, err.Error())
	}
	return fmt.Sprintf("聚合错误（共 %d 个）：%s", len(e.Errors), strings.Join(msgs, "；"))
}

// errNextTwice 对应 TS 'next() called multiple times' 的中文版（方案 2.4）。
var errNextTwice = errors.New("next() 已被调用")

// EventsService 对应 TS EventsService。hooks 表的一切读写持 root 锁
// （方案 2.10 第 1 条）；监听器一律锁外调用（第 2 条），调用边界 recover
// panic 转错误（第 4 条）。
type EventsService struct {
	ctx   *Context
	mu    *sync.Mutex
	hooks map[EventName][]*Hook
}

// newEventsService 构造事件服务并登记两个内建钩子（events.ts:54-69）：
// internal/listener 把非 global 的 internal/update 登记到 fiber 级钩子表；
// internal/update 自身以 {Global, Prepend} 注册、把 fiber 级钩子链式调用
// 后落 next。两个钩子的 effect 登记随后被 NewContext 的
// rootFiber.disposables.Clear() 丢弃（清理器不执行、钩子永留，对应
// context.ts:47 的 this.fiber._disposables.clear()）。
func newEventsService(ctx *Context) *EventsService {
	e := &EventsService{
		ctx:   ctx,
		mu:    ctx.mu,
		hooks: make(map[EventName][]*Hook),
	}
	_, _ = e.On(ctx, StringEvent("internal/listener"), func(ev *EventCtx) (any, error) {
		c, _ := ev.This.(*Context)
		if c == nil || len(ev.Args) < 3 {
			return nil, nil
		}
		name, ok := ev.Args[0].(EventName)
		if !ok {
			return nil, nil
		}
		listener, ok := ev.Args[1].(Listener)
		if !ok {
			return nil, nil
		}
		options, ok := ev.Args[2].(EventOptions)
		if !ok {
			return nil, nil
		}
		if name.String() != "internal/update" || options.Global {
			return nil, nil
		}
		hooks := c.Fiber().hookList(StringEvent("internal/update"))
		var remove func()
		if options.Prepend {
			remove = hooks.Unshift(listener)
		} else {
			remove = hooks.Push(listener)
		}
		var done atomic.Bool
		return func() bool {
			if !done.CompareAndSwap(false, true) {
				return false
			}
			remove()
			return true
		}, nil
	})
	_, _ = e.On(ctx, StringEvent("internal/update"), func(ev *EventCtx) (any, error) {
		fiber, _ := ev.This.(*Fiber)
		if fiber == nil {
			return nil, fmt.Errorf("internal/update 的 thisArg 必须是 *Fiber")
		}
		var config, noSave any
		if len(ev.Args) > 0 {
			config = ev.Args[0]
		}
		if len(ev.Args) > 1 {
			noSave = ev.Args[1]
		}
		next := ev.Next
		if next == nil {
			return nil, fmt.Errorf("internal/update 的瀑布缺少 next")
		}
		fiber.mu.Lock()
		list := fiber.hooks[StringEvent("internal/update")]
		fiber.mu.Unlock()
		var cbs []Listener
		if list != nil {
			cbs = list.Values()
		}
		var run func(int) (any, error)
		run = func(index int) (any, error) {
			if index == len(cbs) {
				return next()
			}
			var used atomic.Bool
			return safeListener(cbs[index], &EventCtx{Context: ev.Context, This: fiber, Args: []any{config, noSave}, Next: func() (any, error) {
				if !used.CompareAndSwap(false, true) {
					return nil, errNextTwice
				}
				return run(index + 1)
			}})
		}
		return run(0)
	}, EventOptions{Global: true, Prepend: true})
	return e
}

// HookSnapshot 供测试泄漏检查（tests/utils.ts 的 getHookSnapshot）：
// 非空事件桶的「事件名→钩子数」快照。
func (e *EventsService) HookSnapshot() map[string]int {
	e.mu.Lock()
	defer e.mu.Unlock()
	snapshot := make(map[string]int)
	for name, bucket := range e.hooks {
		if len(bucket) > 0 {
			snapshot[name.String()] = len(bucket)
		}
	}
	return snapshot
}

// On 对应 TS on（events.ts:154-167）：注册前 assertActive、先走
// BailTo(c, "internal/listener", ...)（internal/update 的登记被内建钩子
// 拦截转入 fiber 级钩子表），再经 effect 登记到 c 的 fiber。返回的退订
// 函数在桶空时删除桶（unregister），注册失败直接返回 error。
func (e *EventsService) On(c *Context, name EventName, listener Listener, opts ...EventOptions) (func() bool, error) {
	options := EventOptions{}
	if len(opts) > 0 {
		options = opts[0]
	}
	if err := c.Fiber().AssertActive(); err != nil {
		return nil, err
	}
	result, err := e.BailTo(c, StringEvent("internal/listener"), name, listener, options)
	if err != nil {
		return nil, err
	}
	if isBailed(result) {
		var release func()
		switch dispose := result.(type) {
		case func() bool:
			release = func() { dispose() }
		case func():
			release = dispose
		default:
			return nil, fmt.Errorf("监听器注册拦截器返回了无效的清理器")
		}
		var done atomic.Bool
		cleanup := func(context.Context) error {
			if done.CompareAndSwap(false, true) {
				release()
			}
			return nil
		}
		d, err := c.Effect(onLabel(name), func() (Disposable, error) { return cleanup, nil })
		if err != nil {
			return nil, errors.Join(err, safeDispose(cleanup, context.Background()))
		}
		return func() bool {
			if !done.CompareAndSwap(false, true) {
				return false
			}
			release()
			_ = d(context.Background())
			return true
		}, nil
	}
	return e.register(c, onLabel(name), name, listener, options)
}

// Once 对应 TS once（events.ts:169-175）：首次触发先退订再执行监听器。
func (e *EventsService) Once(c *Context, name EventName, listener Listener, opts ...EventOptions) (func() bool, error) {
	var claimed atomic.Bool
	var mu sync.Mutex
	var dispose func() bool
	wrapped := func(ev *EventCtx) (any, error) {
		if !claimed.CompareAndSwap(false, true) {
			return nil, nil
		}
		mu.Lock()
		d := dispose
		mu.Unlock()
		if d != nil {
			d()
		}
		return listener(ev)
	}
	d, err := e.On(c, name, wrapped, opts...)
	if err != nil {
		return nil, err
	}
	mu.Lock()
	dispose = d
	mu.Unlock()
	if claimed.Load() {
		d()
	}
	return d, nil
}

// register 对应 TS register（events.ts:134-141）：钩子经 c 的 fiber 的
// effect 登记（fiber 销毁自动退订）。Go 函数值不可比较，退订按 *Hook
// 指针定位（等价 TS 按 callback 引用 findIndex）。
func (e *EventsService) register(c *Context, label string, name EventName, callback Listener, options EventOptions) (func() bool, error) {
	wrapper, err := c.Effect(label, func() (Disposable, error) {
		h := &Hook{Ctx: c, Callback: callback, Global: options.Global, Prepend: options.Prepend}
		e.mu.Lock()
		bucket := e.hooks[name]
		if options.Prepend {
			bucket = append([]*Hook{h}, bucket...)
		} else {
			bucket = append(bucket, h)
		}
		e.hooks[name] = bucket
		e.mu.Unlock()
		return func(context.Context) error {
			e.unregister(name, h)
			return nil
		}, nil
	})
	if err != nil {
		// On 已先 assertActive，此处不可达；保守返回空退订。
		return nil, err
	}
	var removed atomic.Bool
	return func() bool {
		if !removed.CompareAndSwap(false, true) {
			return false
		}
		return wrapper(context.Background()) == nil
	}, nil
}

// unregister 对应 TS unregister（events.ts:143-152）：移除指定登记，
// 桶空时删除桶。
func (e *EventsService) unregister(name EventName, h *Hook) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	bucket := e.hooks[name]
	for i, item := range bucket {
		if item == h {
			bucket = append(bucket[:i], bucket[i+1:]...)
			if len(bucket) == 0 {
				delete(e.hooks, name)
			} else {
				e.hooks[name] = bucket
			}
			return true
		}
	}
	return false
}

// Emit 同步派发事件（events.ts:96-99）：任一监听器返回错误即刻返回该
// 错误、不再调用后续监听器（TS 的同步 throw 传播）。
func (e *EventsService) Emit(name EventName, args ...any) error {
	return e.emitResolved(nil, name, args)
}

// EmitTo 以 thisArg 同步派发事件。
func (e *EventsService) EmitTo(thisArg any, name EventName, args ...any) error {
	return e.emitResolved(thisArg, name, args)
}

func (e *EventsService) emitResolved(thisArg any, name EventName, args []any) error {
	hooks, err := e.resolve(ModeEmit, thisArg, name, args)
	if err != nil {
		return err
	}
	for _, h := range hooks {
		if _, lerr := safeListener(h.Callback, &EventCtx{Context: eventLifetime(thisArg), This: thisArg, Args: args}); lerr != nil {
			return lerr
		}
	}
	return nil
}

// Parallel 对应 TS parallel（events.ts:89-94）：全部监听器并发执行、
// 等待全部完成后聚合失败为 *AggregateError；单个失败不得中断其它
// （events.spec.ts:116-131）。TS 的 _resolve 第一参数传 'emit'（源码事实）。
func (e *EventsService) Parallel(ctx context.Context, name EventName, args ...any) error {
	return e.ParallelTo(ctx, nil, name, args...)
}

// ParallelTo 以 thisArg 并行派发。ctx 形态上保留（TS 是异步方法），Go 的
// 监听器为同步函数，等待由内部 WaitGroup 收敛。
func (e *EventsService) ParallelTo(ctx context.Context, thisArg any, name EventName, args ...any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	hooks, err := e.resolve(ModeEmit, thisArg, name, args)
	if err != nil {
		return err
	}
	type result struct {
		index int
		err   error
	}
	results := make(chan result, len(hooks))
	for i, h := range hooks {
		e.ctx.Tasks().Go(func() {
			_, err := safeListener(h.Callback, &EventCtx{Context: ctx, This: thisArg, Args: append([]any(nil), args...)})
			results <- result{i, err}
		})
	}
	errs := make([]error, len(hooks))
	for range hooks {
		select {
		case r := <-results:
			errs[r.index] = r.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	var failures []error
	for _, err := range errs {
		if err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) > 0 {
		return &AggregateError{Errors: failures}
	}
	return nil
}

// Serial 对应 TS serial（events.ts:101-108）：逐个执行，监听器错误即刻
// 返回并中止；无错误时结果非 nil 且非 false（isBailed）即拦截返回。
func (e *EventsService) Serial(ctx context.Context, name EventName, args ...any) (any, error) {
	return e.SerialTo(ctx, nil, name, args...)
}

// SerialTo 以 thisArg 串行派发。
func (e *EventsService) SerialTo(ctx context.Context, thisArg any, name EventName, args ...any) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	hooks, err := e.resolve(ModeSerial, thisArg, name, args)
	if err != nil {
		return nil, err
	}
	for _, h := range hooks {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, lerr := safeListener(h.Callback, &EventCtx{Context: ctx, This: thisArg, Args: args})
		if lerr != nil {
			return nil, lerr
		}
		if isBailed(result) {
			return result, nil
		}
	}
	return nil, nil
}

// Bail 对应 TS bail（events.ts:109-115）：同步版 Serial。
func (e *EventsService) Bail(name EventName, args ...any) (any, error) {
	return e.BailTo(nil, name, args...)
}

// BailTo 以 thisArg 同步串行派发。
func (e *EventsService) BailTo(thisArg any, name EventName, args ...any) (any, error) {
	hooks, err := e.resolve(ModeBail, thisArg, name, args)
	if err != nil {
		return nil, err
	}
	for _, h := range hooks {
		result, lerr := safeListener(h.Callback, &EventCtx{Context: eventLifetime(thisArg), This: thisArg, Args: args})
		if lerr != nil {
			return nil, lerr
		}
		if isBailed(result) {
			return result, nil
		}
	}
	return nil, nil
}

// Waterfall 对应 TS waterfall（events.ts:117-132）：terminal 为最内层回调；
// 监听器收到的 Args = args 原样（next 经 ev.Next 传递）。重复 next（含外层
// 帧延续）返回错误；监听器、next 链或 terminal 的错误逐层穿透；监听器未
// 调用 next 且正常返回值即为否决，返回值成为瀑布结果。
func (e *EventsService) Waterfall(name EventName, terminal func(ev *EventCtx) (any, error), args ...any) (any, error) {
	return e.WaterfallTo(nil, name, terminal, args...)
}

// WaterfallTo 以 thisArg 瀑布派发（internal/update 等机制的依赖：thisArg
// 为 *Fiber，监听者经 ev.This.(*Fiber) 取自身钩子表）。
func (e *EventsService) WaterfallTo(thisArg any, name EventName, terminal func(ev *EventCtx) (any, error), args ...any) (any, error) {
	hooks, err := e.resolve(ModeWaterfall, thisArg, name, args)
	if err != nil {
		return nil, err
	}
	callbacks := make([]Listener, 0, len(hooks))
	for _, h := range hooks {
		callbacks = append(callbacks, h.Callback)
	}
	var dispatch func(int) (any, error)
	dispatch = func(index int) (any, error) {
		if index == len(callbacks) {
			if terminal == nil {
				return nil, nil
			}
			return safeListener(func(ev *EventCtx) (any, error) {
				return terminal(ev)
			}, &EventCtx{Context: eventLifetime(thisArg), This: thisArg, Args: args})
		}
		cb := callbacks[index]
		var called atomic.Bool
		next := func() (any, error) {
			if !called.CompareAndSwap(false, true) {
				return nil, errNextTwice
			}
			return dispatch(index + 1)
		}
		return safeListener(cb, &EventCtx{Context: eventLifetime(thisArg), This: thisArg, Args: args, Next: next})
	}
	return dispatch(0)
}

// resolve 对应 TS _resolve（events.ts:72-81）：先按需转发 internal/dispatch
// （非 internal/ 前缀且存在钩子时；错误穿透），再解析过滤器并产出钩子
// 快照。过滤器：thisArg 为 nil 时不过滤；为 *Context 时沿其 ExtendMeta.Filter
// 链取；其余实现 FilterCarrier 时用其方法；命中过滤器时只保留
// hook.Global || filter(hook.Ctx) 的钩子。filter 是用户回调，锁外调用
// （方案 2.10 第 2 条）。
func (e *EventsService) resolve(mode DispatchMode, thisArg any, name EventName, args []any) ([]*Hook, error) {
	if !isInternalEventName(name) && e.bucketLen(StringEvent("internal/dispatch")) > 0 {
		if err := e.emitResolved(nil, StringEvent("internal/dispatch"), []any{mode, name, args, thisArg}); err != nil {
			return nil, err
		}
	}
	var filter func(*Context) bool
	if thisArg != nil {
		if c, ok := thisArg.(*Context); ok {
			filter = c.nearestFilter()
		} else if carrier, ok := thisArg.(FilterCarrier); ok {
			filter = carrier.CordisFilter
		}
	}
	e.mu.Lock()
	bucket := append([]*Hook(nil), e.hooks[name]...)
	e.mu.Unlock()
	if filter == nil {
		return bucket, nil
	}
	hooks := make([]*Hook, 0, len(bucket))
	for _, h := range bucket {
		if h.Global || filter(h.Ctx) {
			hooks = append(hooks, h)
		}
	}
	return hooks, nil
}

// bucketLen 返回指定事件桶的当前长度。
func (e *EventsService) bucketLen(name EventName) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.hooks[name])
}

// safeListener 在监听器/terminal 调用边界 recover panic 并转为错误
// （方案 2.10 第 4 条）。
func safeListener(cb Listener, ev *EventCtx) (result any, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("监听器发生 panic: %v", v)
		}
	}()
	return cb(ev)
}

// isBailed 对应 TS isBailed（events.ts:6-8）：无错误时结果非 nil 且非
// false 即拦截（契约要求监听器避免返回类型化 nil 指针）。
func isBailed(value any) bool {
	return value != nil && value != false
}

// onLabel 对应 TS 的 `ctx.on(${JSON.stringify(name) | name.toString()})`
// （events.ts:165）：字符串名带引号、符号名为 "Symbol(name)"。
func onLabel(name EventName) string {
	if name.sym != nil {
		return "ctx.on(" + name.String() + ")"
	}
	return fmt.Sprintf("ctx.on(%q)", name.str)
}

// isInternalEventName 对应 TS 的 `typeof name !== 'string' ||
// !name.startsWith('internal/')`：符号事件名恒非 internal。
func isInternalEventName(name EventName) bool {
	return name.sym == nil && strings.HasPrefix(name.str, "internal/")
}

func eventLifetime(thisArg any) context.Context {
	switch v := thisArg.(type) {
	case *Context:
		return v.Lifetime()
	case *Fiber:
		return v.Scope().Context()
	}
	return context.Background()
}

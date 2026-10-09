// Package timer 提供绑定调用方激活周期的 timeout、interval、throttle 与 debounce。
// 注册同步返回错误；时间由注入时钟驱动，清理停止实际计时器。
package timer

import (
	"context"
	"errors"
	"sync"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/clock"
)

var errDisposed = errors.New("上下文已销毁")

var mixinKeys = []string{"timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"}

type TimerService struct{ kardia.Service }

var Plugin = &kardia.Plugin{
	Name: "timer",
	Apply: func(ctx *kardia.Context, _ any) (kardia.Disposable, error) {
		_, err := New(ctx)
		return nil, err
	},
}

func New(ctx *kardia.Context) (*TimerService, error) {
	t := &TimerService{}
	var err error
	t.Service, err = kardia.NewService(ctx, "timer", t, nil)
	if err != nil {
		return nil, err
	}
	if _, err := ctx.Mixin("timer", mixinKeys); err != nil {
		return nil, errors.Join(err, t.Close(context.Background()))
	}
	return t, nil
}

func (t *TimerService) MixinInvoke(access *kardia.Context, key string) (any, error) {
	switch key {
	case "timeout", "setTimeout":
		return func(cb func(), delay time.Duration) (func(), error) { return t.Timeout(access, cb, delay) }, nil
	case "interval", "setInterval":
		return func(cb func(), delay time.Duration) (func(), error) { return t.Interval(access, cb, delay) }, nil
	case "throttle":
		return func(cb func(...any), delay time.Duration, noTrailing bool) (*ScheduledFunc, error) {
			return t.Throttle(access, cb, delay, noTrailing)
		}, nil
	case "debounce":
		return func(cb func(...any), delay time.Duration) (*ScheduledFunc, error) {
			return t.Debounce(access, cb, delay)
		}, nil
	}
	return nil, nil
}

// timerWait 串行化计时器换代与停止。先完成 effect 登记，再启动消费者，
// 因而零时长到期也不会读到尚未登记的清理句柄。
type timerWait struct {
	mu     sync.Mutex
	stop   chan struct{}
	timer  clock.Timer
	closed bool
}

func newTimerWait(clk clock.Clock, delay time.Duration) *timerWait {
	return &timerWait{stop: make(chan struct{}), timer: clk.NewTimer(delay)}
}

func (w *timerWait) wait(ctx context.Context) bool {
	w.mu.Lock()
	timer := w.timer
	closed := w.closed
	w.mu.Unlock()
	if closed {
		return false
	}
	select {
	case <-timer.Chan():
	case <-ctx.Done():
		return false
	case <-w.stop:
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return !w.closed && ctx.Err() == nil
}

func (w *timerWait) arm(clk clock.Clock, delay time.Duration) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return false
	}
	w.timer.Stop()
	w.timer = clk.NewTimer(delay)
	return true
}

func (w *timerWait) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	w.timer.Stop()
	close(w.stop)
}

func disposeFunc(d kardia.Disposable) func() {
	return func() { _ = d(context.Background()) }
}

// Timeout 注册一次回调。回调已开始时取消不强制中断用户函数。
func (t *TimerService) Timeout(access *kardia.Context, cb func(), delay time.Duration) (func(), error) {
	lifetime := access.Lifetime()
	w := newTimerWait(access.Clock(), delay)
	d, err := access.Effect("ctx.timeout()", func() (kardia.Disposable, error) {
		return func(context.Context) error { w.close(); return nil }, nil
	})
	if err != nil {
		w.close()
		return nil, err
	}
	dispose := disposeFunc(d)
	access.Tasks().Go(func() {
		defer w.close()
		if !w.wait(lifetime) {
			return
		}
		dispose()
		cb()
	})
	return dispose, nil
}

func (t *TimerService) SetTimeout(access *kardia.Context, cb func(), delay time.Duration) (func(), error) {
	return t.Timeout(access, cb, delay)
}

type timeoutAfter struct {
	mu   sync.Mutex
	done chan struct{}
	err  error
	set  bool
}

func (s *timeoutAfter) settle(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set {
		return
	}
	s.set, s.err = true, err
	close(s.done)
}

// TimeoutAfter 可重复等待同一个结果；等待者取消不会取消计时器。
func (t *TimerService) TimeoutAfter(access *kardia.Context, delay time.Duration) (func(context.Context) error, func(), error) {
	lifetime := access.Lifetime()
	w := newTimerWait(access.Clock(), delay)
	s := &timeoutAfter{done: make(chan struct{})}
	d, err := access.Effect("ctx.timeout()", func() (kardia.Disposable, error) {
		return func(context.Context) error { w.close(); s.settle(errDisposed); return nil }, nil
	})
	if err != nil {
		w.close()
		return nil, nil, err
	}
	dispose := disposeFunc(d)
	access.Tasks().Go(func() {
		defer w.close()
		if w.wait(lifetime) {
			s.settle(nil)
		} else {
			s.settle(errDisposed)
		}
		dispose()
	})
	await := func(ctx context.Context) error {
		select {
		case <-s.done:
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return await, dispose, nil
}

// runInterval 只有一个驱动任务。同一定时器的回调始终串行，下一拍在回调前
// 登记，使回调完成的观察者能立即推进假时钟。长回调期间最多缓存一拍。
func runInterval(access *kardia.Context, lifetime context.Context, w *timerWait, delay time.Duration, cb func()) {
	defer w.close()
	for w.wait(lifetime) {
		if !w.arm(access.Clock(), delay) {
			return
		}
		cb()
	}
}

func (t *TimerService) Interval(access *kardia.Context, cb func(), delay time.Duration) (func(), error) {
	lifetime := access.Lifetime()
	w := newTimerWait(access.Clock(), delay)
	d, err := access.Effect("ctx.interval()", func() (kardia.Disposable, error) {
		return func(context.Context) error { w.close(); return nil }, nil
	})
	if err != nil {
		w.close()
		return nil, err
	}
	access.Tasks().Go(func() { runInterval(access, lifetime, w, delay, cb) })
	return disposeFunc(d), nil
}

func (t *TimerService) SetInterval(access *kardia.Context, cb func(), delay time.Duration) (func(), error) {
	return t.Interval(access, cb, delay)
}

type IteratorResult struct {
	Done  bool
	Value any
}
type iterDoneKind int

const (
	iterActive iterDoneKind = iota
	iterReturn
	iterThrow
)

type iterOutcome struct {
	res IteratorResult
	err error
}
type iterWaiter struct{ ch chan iterOutcome }

// IntervalIter 在每拍只完成一个排队读取；Return、Throw 与清理共享唯一终局。
type IntervalIter struct {
	mu      sync.Mutex
	kind    iterDoneKind
	value   any
	err     error
	queue   []*iterWaiter
	changed chan struct{}
	dispose func()
}

func (t *TimerService) IntervalIter(access *kardia.Context, delay time.Duration) (*IntervalIter, error) {
	it := &IntervalIter{changed: make(chan struct{})}
	lifetime := access.Lifetime()
	w := newTimerWait(access.Clock(), delay)
	d, err := access.Effect("ctx.interval()", func() (kardia.Disposable, error) {
		return func(context.Context) error { w.close(); it.finish(iterThrow, nil, errDisposed); return nil }, nil
	})
	if err != nil {
		w.close()
		return nil, err
	}
	it.dispose = disposeFunc(d)
	access.Tasks().Go(func() { runInterval(access, lifetime, w, delay, it.resolveHead) })
	return it, nil
}

func (it *IntervalIter) Next(ctx context.Context) (IteratorResult, error) {
	if err := ctx.Err(); err != nil {
		return IteratorResult{}, err
	}
	it.mu.Lock()
	if it.kind != iterActive {
		res, err := it.resultLocked()
		it.mu.Unlock()
		return res, err
	}
	w := &iterWaiter{ch: make(chan iterOutcome, 1)}
	it.queue = append(it.queue, w)
	it.notifyLocked()
	it.mu.Unlock()
	select {
	case o := <-w.ch:
		return o.res, o.err
	case <-ctx.Done():
		if it.removeWaiter(w) {
			return IteratorResult{}, ctx.Err()
		}
		// 投递先取得所有权时保持已提交的结果，避免取消吞掉一拍。
		o := <-w.ch
		return o.res, o.err
	}
}

func (it *IntervalIter) Return(value any) (IteratorResult, error) {
	it.finish(iterReturn, value, nil)
	it.dispose()
	return IteratorResult{Done: true, Value: value}, nil
}

func (it *IntervalIter) Throw(reason error) (IteratorResult, error) {
	if reason == nil {
		reason = errors.New("迭代器已被显式终止")
	}
	it.finish(iterThrow, nil, reason)
	it.dispose()
	return IteratorResult{Done: true}, nil
}

func (it *IntervalIter) resultLocked() (IteratorResult, error) {
	if it.kind == iterThrow {
		return IteratorResult{}, it.err
	}
	return IteratorResult{Done: true, Value: it.value}, nil
}

func (it *IntervalIter) finish(kind iterDoneKind, value any, err error) {
	it.mu.Lock()
	defer it.mu.Unlock()
	if it.kind != iterActive {
		return
	}
	it.kind, it.value, it.err = kind, value, err
	res, err := it.resultLocked()
	for _, w := range it.queue {
		w.ch <- iterOutcome{res: res, err: err}
	}
	it.queue = nil
	it.notifyLocked()
}

func (it *IntervalIter) resolveHead() {
	it.mu.Lock()
	defer it.mu.Unlock()
	if it.kind != iterActive || len(it.queue) == 0 {
		return
	}
	w := it.queue[0]
	it.queue = it.queue[1:]
	w.ch <- iterOutcome{}
	it.notifyLocked()
}

func (it *IntervalIter) removeWaiter(w *iterWaiter) bool {
	it.mu.Lock()
	defer it.mu.Unlock()
	for i, item := range it.queue {
		if item == w {
			it.queue = append(it.queue[:i], it.queue[i+1:]...)
			it.notifyLocked()
			return true
		}
	}
	return false
}

func (it *IntervalIter) notifyLocked() {
	close(it.changed)
	it.changed = make(chan struct{})
}

// ScheduledFunc 包装 throttle 或 debounce；Dispose 撤销尾随调用。
// 与 Cordis 一致，手动 Dispose 后 throttle 的立即执行分支仍然可用；
// 所属激活周期结束之后任何调用均停止。
type ScheduledFunc struct {
	access   *kardia.Context
	lifetime context.Context
	callback func(...any)
	delay    time.Duration
	throttle bool
	mu       sync.Mutex
	disposed bool
	hasLast  bool
	lastCall time.Time
	cur      *timerWait
	dispose  func()
}

func (f *ScheduledFunc) Call(args ...any) {
	f.mu.Lock()
	if f.lifetime.Err() != nil {
		f.mu.Unlock()
		return
	}
	f.abortLocked()
	now := f.access.Clock().Now()
	if f.throttle && (!f.hasLast || now.Sub(f.lastCall) >= f.delay) {
		f.lastCall, f.hasLast = now, true
		f.mu.Unlock()
		f.callback(args...)
		return
	}
	if f.disposed {
		f.mu.Unlock()
		return
	}
	delay := f.delay
	if f.throttle {
		delay -= now.Sub(f.lastCall)
	}
	w := newTimerWait(f.access.Clock(), delay)
	f.cur = w
	args = append([]any(nil), args...)
	f.mu.Unlock()
	f.access.Tasks().Go(func() {
		defer w.close()
		if !w.wait(f.lifetime) {
			return
		}
		f.mu.Lock()
		if f.cur != w {
			f.mu.Unlock()
			return
		}
		f.cur = nil
		if f.throttle {
			f.lastCall, f.hasLast = f.access.Clock().Now(), true
		}
		f.mu.Unlock()
		f.callback(args...)
	})
}

func (f *ScheduledFunc) Dispose() { f.dispose() }

func (f *ScheduledFunc) cleanup(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disposed = true
	f.abortLocked()
	return nil
}

func (f *ScheduledFunc) abortLocked() {
	if f.cur != nil {
		f.cur.close()
		f.cur = nil
	}
}

func (t *TimerService) Throttle(access *kardia.Context, cb func(...any), delay time.Duration, noTrailing bool) (*ScheduledFunc, error) {
	return t.schedule(access, "ctx.throttle()", cb, delay, true, noTrailing)
}

func (t *TimerService) Debounce(access *kardia.Context, cb func(...any), delay time.Duration) (*ScheduledFunc, error) {
	return t.schedule(access, "ctx.debounce()", cb, delay, false, false)
}

func (t *TimerService) schedule(access *kardia.Context, label string, cb func(...any), delay time.Duration, throttle, noTrailing bool) (*ScheduledFunc, error) {
	f := &ScheduledFunc{access: access, lifetime: access.Lifetime(), callback: cb, delay: delay, throttle: throttle, disposed: noTrailing}
	d, err := access.Effect(label, func() (kardia.Disposable, error) { return f.cleanup, nil })
	if err != nil {
		return nil, err
	}
	f.dispose = disposeFunc(d)
	return f, nil
}

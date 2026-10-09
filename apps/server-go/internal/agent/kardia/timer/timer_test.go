// timer_test.go 对应 apps/cordis/packages/timer/tests/index.spec.ts（18 个
// 用例逐条移植）。
//
// 同步策略（对应 TS 的 vi.advanceTimersByTimeAsync）：TS 的 withContext 把
// 测试体运行在 inject(['timer']) 的独立 fiber 上，fake timers 只经
// advanceTimersByTimeAsync 推进；Go 侧等价改写为「clk.Advance(n) → 等待回调
// 信号 → 断言」。等待不走 ctx.Tasks().Wait：本包的守护 goroutine 在两次推进
// 之间保持挂起（等价常驻 setInterval），等待全部任务完成的 Wait 会保持阻塞；每步推进
// 之间由信号通道（signal/quit/读取结果通道）给出确定性的「回调已执行」事实，
// 与 fiber.Await / Dispose 配合即可覆盖全部断言，不依赖真实时间（watchdog
// 超时只作失败护栏）。
package timer

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/clock"
)

var ctxBg = context.Background()

// watchDog 只作失败护栏，不参与逻辑同步。
const watchDog = 10 * time.Second

// waitCh 阻塞接收并带超时护栏。
func waitCh[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(watchDog):
		t.Fatalf("等待%s超时", what)
		var zero T
		return zero
	}
}

// signal 对应 TS 的 mock.fn()：计数使用原子变量，通道报告回调发生。
type signal struct {
	n   atomic.Int64
	sig chan struct{}
}

func newSignal() *signal { return &signal{sig: make(chan struct{}, 64)} }

func (s *signal) call() {
	s.n.Add(1)
	s.sig <- struct{}{}
}

// invoke 把 call 适配为 throttle/debounce 的 func(args ...any) 形态。
func (s *signal) invoke(args ...any) { s.call() }

func (s *signal) count() int { return int(s.n.Load()) }

func (s *signal) await(t *testing.T, what string) {
	t.Helper()
	waitCh(t, s.sig, what)
}

// awaitCount 通过回调通知收敛，计数使用原子变量支持并发断言。
func (s *signal) awaitCount(t *testing.T, want int, what string) {
	t.Helper()
	deadline := time.NewTimer(watchDog)
	defer deadline.Stop()
	for s.count() < want {
		select {
		case <-s.sig:
		case <-deadline.C:
			t.Fatalf("等待%s超时（计数 %d，期望 %d）", what, s.count(), want)
		}
	}
}

// waitQueueLen 在锁内获取队列与变更通知，避免轮询和丢失唤醒。
func waitQueueLen(t *testing.T, it *IntervalIter, n int) {
	t.Helper()
	deadline := time.NewTimer(watchDog)
	defer deadline.Stop()
	for {
		it.mu.Lock()
		count, changed := len(it.queue), it.changed
		it.mu.Unlock()
		if count >= n {
			return
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatalf("等待迭代器队列长度达到 %d 超时", n)
		}
	}
}

// env 是 withContext 的等价物：Manual 假时钟根 ctx + timer 插件 + 承载测试体
// 的 inject(['timer']) 独立 fiber（e.ctx）。计时器经 e.ctx 登记即挂在该 fiber
// 上，销毁该 fiber（e.inj.Dispose）即 TS 的 ctx.fiber.dispose()。
type env struct {
	root *kardia.Context
	clk  *clock.Manual
	ctx  *kardia.Context
	inj  *kardia.Fiber
	svc  *TimerService
}

func newEnv(t *testing.T) *env {
	t.Helper()
	clk := clock.NewManual(time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC))
	root := kardia.NewContext(kardia.WithClock(clk))
	tf, err := root.Plugin(Plugin, nil)
	if err != nil {
		t.Fatalf("装载 timer 插件失败：%v", err)
	}
	if _, err := tf.Await(ctxBg); err != nil {
		t.Fatalf("等待 timer 插件激活失败：%v", err)
	}
	inj, err := root.Inject([]string{"timer"}, func(*kardia.Context, any) (kardia.Disposable, error) {
		return nil, nil
	})
	if err != nil {
		t.Fatalf("装载测试插件失败：%v", err)
	}
	if _, err := inj.Await(ctxBg); err != nil {
		t.Fatalf("等待测试插件激活失败：%v", err)
	}
	v, err := inj.Ctx().Get("timer")
	if err != nil {
		t.Fatalf("解析 timer 服务失败：%v", err)
	}
	svc, ok := v.(*TimerService)
	if !ok {
		t.Fatalf("timer 服务类型错误：%T", v)
	}
	e := &env{root: root, clk: clk, ctx: inj.Ctx(), inj: inj, svc: svc}
	t.Cleanup(func() { _ = root.Fiber().Dispose(ctxBg) })
	return e
}

// —— ctx.timeout()（timer/tests/index.spec.ts:21-56）——

// 对应 'basic support'（spec:22-30）。本用例走 mixin 解析路径（ctx.Get
// ("timeout")，方案 2.6 的绑定形态），并顺带核验六键的绑定类型。
func TestTimeoutBasicSupport(t *testing.T) {
	e := newEnv(t)
	v, err := e.ctx.Get("timeout")
	if err != nil {
		t.Fatalf("经 mixin 读取 timeout 失败：%v", err)
	}
	fn, ok := v.(func(func(), time.Duration) (func(), error))
	if !ok {
		t.Fatalf("mixin 键 timeout 应绑定回调形态，实际 %T", v)
	}
	for _, key := range []string{"interval", "setTimeout", "setInterval"} {
		other, err := e.ctx.Get(key)
		if err != nil {
			t.Fatalf("经 mixin 读取 %s 失败：%v", key, err)
		}
		if _, ok := other.(func(func(), time.Duration) (func(), error)); !ok {
			t.Fatalf("mixin 键 %s 应绑定回调形态，实际 %T", key, other)
		}
	}
	if other, err := e.ctx.Get("throttle"); err != nil {
		t.Fatalf("经 mixin 读取 throttle 失败：%v", err)
	} else if _, ok := other.(func(func(...any), time.Duration, bool) (*ScheduledFunc, error)); !ok {
		t.Fatalf("mixin 键 throttle 形态不符，实际 %T", other)
	}
	if other, err := e.ctx.Get("debounce"); err != nil {
		t.Fatalf("经 mixin 读取 debounce 失败：%v", err)
	} else if _, ok := other.(func(func(...any), time.Duration) (*ScheduledFunc, error)); !ok {
		t.Fatalf("mixin 键 debounce 形态不符，实际 %T", other)
	}

	cb := newSignal()
	if _, err := fn(cb.call, 1000); err != nil {
		t.Fatal(err)
	}
	if got := cb.count(); got != 0 {
		t.Fatalf("未到期不应执行回调，实际 %d 次", got)
	}
	e.clk.Advance(1000)
	cb.await(t, "timeout 首次到期")
	if got := cb.count(); got != 1 {
		t.Fatalf("到期应恰好执行 1 次，实际 %d 次", got)
	}
	e.clk.Advance(1000)
	if got := cb.count(); got != 1 {
		t.Fatalf("timeout 只执行一次，实际 %d 次", got)
	}
}

// 对应 'dispose'（spec:32-39）。
func TestTimeoutDispose(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	dispose, err := e.svc.Timeout(e.ctx, cb.call, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := cb.count(); got != 0 {
		t.Fatalf("未到期不应执行回调，实际 %d 次", got)
	}
	dispose()
	e.clk.Advance(2000)
	if got := cb.count(); got != 0 {
		t.Fatalf("退订后不应执行回调，实际 %d 次", got)
	}
}

// 对应 'promise'（spec:41-55）：到期 resolve；到期后销毁 fiber 不再产生拒绝。
func TestTimeoutPromise(t *testing.T) {
	e := newEnv(t)
	await, _, err := e.svc.TimeoutAfter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- await(ctxBg) }()
	e.clk.Advance(500)
	select {
	case err := <-done:
		t.Fatalf("未到期不应了结，实际 %v", err)
	default:
	}
	e.clk.Advance(500)
	if err := waitCh(t, done, "timeout 到期"); err != nil {
		t.Fatalf("到期应返回 nil，实际 %v", err)
	}
	if err := e.inj.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 fiber 失败：%v", err)
	}
	e.clk.Advance(2000)
	select {
	case err := <-done:
		t.Fatalf("到期后销毁不应再有了结，实际 %v", err)
	default:
	}
}

// —— ctx.interval()（timer/tests/index.spec.ts:58-247）——

// 对应 'basic support'（spec:59-70）。
func TestIntervalBasicSupport(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	dispose, err := e.svc.Interval(e.ctx, cb.call, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := cb.count(); got != 0 {
		t.Fatalf("未到期不应执行回调，实际 %d 次", got)
	}
	e.clk.Advance(1000)
	cb.await(t, "interval 第一拍")
	if got := cb.count(); got != 1 {
		t.Fatalf("第一拍后应执行 1 次，实际 %d 次", got)
	}
	e.clk.Advance(1000)
	cb.await(t, "interval 第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	dispose()
	e.clk.Advance(2000)
	if got := cb.count(); got != 2 {
		t.Fatalf("退订后不应再触发，实际 %d 次", got)
	}
}

// 对应 'async iterator (manual return)'（spec:72-93）：return 后消费循环
// 正常结束、后续拍不再触发。
func TestIntervalIterManualReturn(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	cb := newSignal()
	quit := make(chan error, 1)
	go func() {
		for {
			res, err := it.Next(ctxBg)
			if err != nil {
				quit <- err
				return
			}
			if res.Done {
				quit <- nil
				return
			}
			cb.call()
		}
	}()
	if got := cb.count(); got != 0 {
		t.Fatalf("未推进不应执行回调，实际 %d 次", got)
	}
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第一拍")
	if got := cb.count(); got != 1 {
		t.Fatalf("第一拍后应执行 1 次，实际 %d 次", got)
	}
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	res, err := it.Return(nil)
	if err != nil {
		t.Fatalf("return 不应报错：%v", err)
	}
	if !res.Done || res.Value != nil {
		t.Fatalf("return 应返回 {Done:true, Value:nil}，实际 %+v", res)
	}
	if err := waitCh(t, quit, "消费循环退出"); err != nil {
		t.Fatalf("return 后消费循环应正常结束，实际 %v", err)
	}
	e.clk.Advance(1000)
	if got := cb.count(); got != 2 {
		t.Fatalf("return 后不应再触发，实际 %d 次", got)
	}
}

// 对应 concurrent reads：真实并发调用 Next，以队列变更通知钉住 FIFO 入队顺序。
func TestIntervalIterConcurrentReads(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	wa := &iterWaiter{ch: make(chan iterOutcome, 1)}
	wb := &iterWaiter{ch: make(chan iterOutcome, 1)}
	go func() { res, err := it.Next(ctxBg); wa.ch <- iterOutcome{res: res, err: err} }()
	waitQueueLen(t, it, 1)
	go func() { res, err := it.Next(ctxBg); wb.ch <- iterOutcome{res: res, err: err} }()
	waitQueueLen(t, it, 2)
	if len(wa.ch)+len(wb.ch) != 0 {
		t.Fatal("推进前任何读取都不应完成")
	}
	e.clk.Advance(1000)
	oa := waitCh(t, wa.ch, "第一个读取")
	if oa.err != nil || oa.res.Done || oa.res.Value != nil {
		t.Fatalf("第一拍应只完成第一个读取 {Done:false, Value:nil}，实际 %+v（错误 %v）", oa.res, oa.err)
	}
	if len(wb.ch) != 0 {
		t.Fatal("第一拍不应完成第二个读取")
	}
	e.clk.Advance(1000)
	ob := waitCh(t, wb.ch, "第二个读取")
	if ob.err != nil || ob.res.Done || ob.res.Value != nil {
		t.Fatalf("第二拍应完成第二个读取 {Done:false, Value:nil}，实际 %+v（错误 %v）", ob.res, ob.err)
	}
}

// 对应 'async iterator (return with concurrent reads)'（spec:117-128）。
func TestIntervalIterReturnWithConcurrentReads(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reads := make([]chan iterOutcome, 3)
	for i := range reads {
		reads[i] = make(chan iterOutcome, 1)
		go func(ch chan iterOutcome) {
			res, err := it.Next(ctxBg)
			ch <- iterOutcome{res: res, err: err}
		}(reads[i])
	}
	res, err := it.Return(42)
	if err != nil {
		t.Fatalf("return 不应报错：%v", err)
	}
	if !res.Done || res.Value != 42 {
		t.Fatalf("return 应返回 {Done:true, Value:42}，实际 %+v", res)
	}
	for i := range reads {
		o := waitCh(t, reads[i], "挂起读取")
		if o.err != nil || !o.res.Done || o.res.Value != 42 {
			t.Fatalf("挂起读取应以 {Done:true, Value:42} 唤醒，实际 %+v（错误 %v）", o.res, o.err)
		}
	}
	res2, err2 := it.Next(ctxBg)
	if err2 != nil || !res2.Done || res2.Value != 42 {
		t.Fatalf("终局后的 next 应立即返回 {Done:true, Value:42}，实际 %+v（错误 %v）", res2, err2)
	}
}

// 对应 'async iterator (throw with concurrent reads)'（spec:130-138）。
func TestIntervalIterThrowWithConcurrentReads(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reason := errors.New("test")
	reads := make([]chan iterOutcome, 3)
	for i := range reads {
		reads[i] = make(chan iterOutcome, 1)
		go func(ch chan iterOutcome) {
			res, err := it.Next(ctxBg)
			ch <- iterOutcome{res: res, err: err}
		}(reads[i])
	}
	res, err := it.Throw(reason)
	if err != nil {
		t.Fatalf("throw 不应报错：%v", err)
	}
	if !res.Done || res.Value != nil {
		t.Fatalf("throw 应返回 {Done:true, Value:nil}，实际 %+v", res)
	}
	for i := range reads {
		o := waitCh(t, reads[i], "挂起读取")
		if !errors.Is(o.err, reason) {
			t.Fatalf("挂起读取应以 reason 拒绝，实际 %+v（错误 %v）", o.res, o.err)
		}
	}
	if _, err := it.Next(ctxBg); !errors.Is(err, reason) {
		t.Fatalf("终局后的 next 应以 reason 拒绝，实际 %v", err)
	}
}

// 对应 'async iterator (manual throw)'（spec:140-161）：TS 的 iterator.throw!()
// 不带参数（reason 为 undefined）；Go 的拒绝通道需要非 nil 错误，用显式 reason
// 承载（行为类不变：挂起的 next 被拒绝、后续拍不再触发）。
func TestIntervalIterManualThrow(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reason := errors.New("test")
	cb := newSignal()
	quit := make(chan error, 1)
	go func() {
		for {
			res, err := it.Next(ctxBg)
			if err != nil {
				quit <- err
				return
			}
			if res.Done {
				quit <- nil
				return
			}
			cb.call()
		}
	}()
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第一拍")
	if got := cb.count(); got != 1 {
		t.Fatalf("第一拍后应执行 1 次，实际 %d 次", got)
	}
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	if _, err := it.Throw(reason); err != nil {
		t.Fatalf("throw 不应报错：%v", err)
	}
	if err := waitCh(t, quit, "消费循环退出"); !errors.Is(err, reason) {
		t.Fatalf("消费循环应以 reason 拒绝结束，实际 %v", err)
	}
	e.clk.Advance(1000)
	if got := cb.count(); got != 2 {
		t.Fatalf("throw 后不应再触发，实际 %d 次", got)
	}
}

// 对应 'async iterator (break return)'（spec:163-185）：循环体第三次 break，
// for-await 语义等价于调用 return() 后正常结束（Go 消费循环显式调用 Return）。
func TestIntervalIterBreakReturn(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	cb := newSignal()
	quit := make(chan error, 1)
	go func() {
		i := 0
		for {
			res, err := it.Next(ctxBg)
			if err != nil {
				quit <- err
				return
			}
			if res.Done {
				quit <- nil
				return
			}
			i++
			if i > 2 {
				if _, err := it.Return(nil); err != nil {
					quit <- err
					return
				}
				quit <- nil
				return
			}
			cb.call()
		}
	}()
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第一拍")
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	if err := waitCh(t, quit, "消费循环退出"); err != nil {
		t.Fatalf("break 后消费循环应正常结束，实际 %v", err)
	}
	if got := cb.count(); got != 2 {
		t.Fatalf("break 后不应再执行，实际 %d 次", got)
	}
}

// 对应 'async iterator (break throw)'（spec:187-209）：循环体第三次抛错，
// for-await 语义等价于调用 return() 后循环以该错误拒绝。
func TestIntervalIterBreakThrow(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reason := errors.New("loop body")
	cb := newSignal()
	quit := make(chan error, 1)
	go func() {
		i := 0
		for {
			res, err := it.Next(ctxBg)
			if err != nil {
				quit <- err
				return
			}
			if res.Done {
				quit <- nil
				return
			}
			i++
			if i > 2 {
				if _, err := it.Return(nil); err != nil {
					quit <- err
					return
				}
				quit <- reason
				return
			}
			cb.call()
		}
	}()
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第一拍")
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	if err := waitCh(t, quit, "消费循环退出"); !errors.Is(err, reason) {
		t.Fatalf("循环应以体内错误拒绝结束，实际 %v", err)
	}
	if got := cb.count(); got != 2 {
		t.Fatalf("抛错后不应再执行，实际 %d 次", got)
	}
}

// 对应 'async iterator (context dispose)'（spec:211-234）：销毁访问点 fiber
// 后，消费循环以「上下文已销毁」拒绝结束，后续拍不再触发。TS 用 yield 把
// 断言挂在清理期执行；Go 侧 Dispose 同步等待清理完成，直接顺序断言即可。
func TestIntervalIterContextDispose(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	cb := newSignal()
	quit := make(chan error, 1)
	go func() {
		for {
			res, err := it.Next(ctxBg)
			if err != nil {
				quit <- err
				return
			}
			if res.Done {
				quit <- nil
				return
			}
			cb.call()
		}
	}()
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第一拍")
	waitQueueLen(t, it, 1)
	e.clk.Advance(1000)
	cb.await(t, "迭代器第二拍")
	if got := cb.count(); got != 2 {
		t.Fatalf("第二拍后应执行 2 次，实际 %d 次", got)
	}
	if err := e.inj.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 fiber 失败：%v", err)
	}
	if err := waitCh(t, quit, "消费循环退出"); !errors.Is(err, errDisposed) {
		t.Fatalf("消费循环应以「上下文已销毁」结束，实际 %v", err)
	}
	e.clk.Advance(1000)
	if got := cb.count(); got != 2 {
		t.Fatalf("销毁后不应再执行，实际 %d 次", got)
	}
}

// 对应 'async iterator (context dispose with concurrent reads)'（spec:
// 236-246）：挂起读取全部以「上下文已销毁」拒绝（文案为中文重写版）。
func TestIntervalIterContextDisposeWithConcurrentReads(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reads := make([]chan iterOutcome, 3)
	for i := range reads {
		reads[i] = make(chan iterOutcome, 1)
		go func(ch chan iterOutcome) {
			res, err := it.Next(ctxBg)
			ch <- iterOutcome{res: res, err: err}
		}(reads[i])
	}
	if err := e.inj.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 fiber 失败：%v", err)
	}
	for i := range reads {
		o := waitCh(t, reads[i], "挂起读取")
		if !errors.Is(o.err, errDisposed) {
			t.Fatalf("挂起读取应以「上下文已销毁」结束，实际 %+v（错误 %v）", o.res, o.err)
		}
	}
}

// —— ctx.throttle()（timer/tests/index.spec.ts:249-290）——

// 对应 'basic support'（spec:250-263）。
func TestThrottleBasicSupport(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	throttled, err := e.svc.Throttle(e.ctx, cb.invoke, 1000, false)
	if err != nil {
		t.Fatal(err)
	}
	throttled.Call()
	if got := cb.count(); got != 1 {
		t.Fatalf("首次调用应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(600)
	throttled.Call()
	if got := cb.count(); got != 1 {
		t.Fatalf("窗口内的第二次调用不应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(600)
	cb.awaitCount(t, 2, "throttle 首次尾随执行")
	if got := cb.count(); got != 2 {
		t.Fatalf("尾随执行后应为 2 次，实际 %d 次", got)
	}
	throttled.Call()
	e.clk.Advance(2000)
	cb.awaitCount(t, 3, "throttle 第二次尾随执行")
	if got := cb.count(); got != 3 {
		t.Fatalf("最终应为 3 次，实际 %d 次", got)
	}
}

// 对应 'trailing mode'（spec:265-277）。
func TestThrottleTrailingMode(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	throttled, err := e.svc.Throttle(e.ctx, cb.invoke, 1000, false)
	if err != nil {
		t.Fatal(err)
	}
	throttled.Call()
	if got := cb.count(); got != 1 {
		t.Fatalf("首次调用应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(500)
	throttled.Call()
	if got := cb.count(); got != 1 {
		t.Fatalf("窗口内的调用不应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(500)
	cb.awaitCount(t, 2, "throttle 尾随执行")
	if got := cb.count(); got != 2 {
		t.Fatalf("尾随执行后应为 2 次，实际 %d 次", got)
	}
	e.clk.Advance(2000)
	if got := cb.count(); got != 2 {
		t.Fatalf("无后续调用不应再执行，实际 %d 次", got)
	}
}

// 对应 'disposed'（spec:279-289）：Dispose 后立即执行分支仍然可用，尾随安排
// 停止。
func TestThrottleDisposed(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	throttled, err := e.svc.Throttle(e.ctx, cb.invoke, 1000, false)
	if err != nil {
		t.Fatal(err)
	}
	throttled.Dispose()
	throttled.Call()
	if got := cb.count(); got != 1 {
		t.Fatalf("Dispose 后的首次调用仍应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(500)
	throttled.Call()
	e.clk.Advance(2000)
	if got := cb.count(); got != 1 {
		t.Fatalf("Dispose 后不应有尾随执行，实际 %d 次", got)
	}
}

// —— ctx.debounce()（timer/tests/index.spec.ts:292-317）——

// 对应 'basic support'（spec:293-306）。
func TestDebounceBasicSupport(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	debounced, err := e.svc.Debounce(e.ctx, cb.invoke, 1000)
	if err != nil {
		t.Fatal(err)
	}
	debounced.Call()
	if got := cb.count(); got != 0 {
		t.Fatalf("debounce 不应立即执行，实际 %d 次", got)
	}
	e.clk.Advance(400)
	debounced.Call()
	if got := cb.count(); got != 0 {
		t.Fatalf("重置后不应执行，实际 %d 次", got)
	}
	e.clk.Advance(400)
	debounced.Call()
	if got := cb.count(); got != 0 {
		t.Fatalf("再次重置后不应执行，实际 %d 次", got)
	}
	e.clk.Advance(1000)
	cb.await(t, "debounce 到期")
	if got := cb.count(); got != 1 {
		t.Fatalf("静默期满应恰好执行 1 次，实际 %d 次", got)
	}
}

// 对应 'disposed'（spec:308-316）。
func TestDebounceDisposed(t *testing.T) {
	e := newEnv(t)
	cb := newSignal()
	debounced, err := e.svc.Debounce(e.ctx, cb.invoke, 1000)
	if err != nil {
		t.Fatal(err)
	}
	debounced.Dispose()
	debounced.Call()
	if got := cb.count(); got != 0 {
		t.Fatalf("Dispose 后不应执行，实际 %d 次", got)
	}
	e.clk.Advance(2000)
	if got := cb.count(); got != 0 {
		t.Fatalf("Dispose 后到期也不应执行，实际 %d 次", got)
	}
}

// 每个已到期计时器都应自行移除 effect，即使到期早于消费者启动。
func TestImmediateTimeoutReleasesEffects(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(ctxBg) })
	svc, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	baseline := len(root.Fiber().GetEffects())
	var count atomic.Int64
	for i := 0; i < 200; i++ {
		if _, err := svc.Timeout(root, func() { count.Add(1) }, 0); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(ctxBg, watchDog)
	defer cancel()
	if err := root.Tasks().Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if got := count.Load(); got != 200 {
		t.Fatalf("零延迟回调计数 %d，期望 200", got)
	}
	if got := len(root.Fiber().GetEffects()); got != baseline {
		t.Fatalf("已到期 effect 泄漏：%d，基线 %d", got, baseline)
	}
}

func TestTimersStopUnderlyingHandles(t *testing.T) {
	e := newEnv(t)
	timeout, err := e.svc.Timeout(e.ctx, func() {}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	interval, err := e.svc.Interval(e.ctx, func() {}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	debounced, err := e.svc.Debounce(e.ctx, func(...any) {}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	debounced.Call()
	if count, _ := e.clk.Pending(); count != 3 {
		t.Fatalf("登记计时器 %d，期望 3", count)
	}
	timeout()
	interval()
	debounced.Dispose()
	if count, _ := e.clk.Pending(); count != 0 {
		t.Fatalf("停止后仍有 %d 个计时器", count)
	}
	if err := e.root.Tasks().Wait(ctxBg); err != nil {
		t.Fatal(err)
	}
}

func TestIntervalCallbacksAreSerial(t *testing.T) {
	e := newEnv(t)
	started := make(chan int, 4)
	release := make(chan struct{})
	var count atomic.Int64
	stop, err := e.svc.Interval(e.ctx, func() {
		n := int(count.Add(1))
		started <- n
		if n == 1 {
			<-release
		}
	}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(1000)
	if got := waitCh(t, started, "第一拍开始"); got != 1 {
		t.Fatal(got)
	}
	e.clk.Advance(1000)
	// 第一拍明确阻塞；第二拍虽已到期，仍不能并发进入回调。
	select {
	case n := <-started:
		close(release)
		t.Fatalf("第一拍未结束就执行了第 %d 拍", n)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if got := waitCh(t, started, "第二拍开始"); got != 2 {
		t.Fatal(got)
	}
	stop()
	if err := e.root.Tasks().Wait(ctxBg); err != nil {
		t.Fatal(err)
	}
}

func TestTimerRegistrationAfterDisposeReturnsError(t *testing.T) {
	e := newEnv(t)
	if err := e.inj.Dispose(ctxBg); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Timeout(e.ctx, func() {}, time.Hour); err == nil {
		t.Fatal("已关闭作用域接受 Timeout")
	}
	if _, err := e.svc.Interval(e.ctx, func() {}, time.Hour); err == nil {
		t.Fatal("已关闭作用域接受 Interval")
	}
	if _, _, err := e.svc.TimeoutAfter(e.ctx, time.Hour); err == nil {
		t.Fatal("已关闭作用域接受 TimeoutAfter")
	}
	if _, err := e.svc.IntervalIter(e.ctx, time.Hour); err == nil {
		t.Fatal("已关闭作用域接受 IntervalIter")
	}
	if _, err := e.svc.Debounce(e.ctx, func(...any) {}, time.Hour); err == nil {
		t.Fatal("已关闭作用域接受 Debounce")
	}
	if count, _ := e.clk.Pending(); count != 0 {
		t.Fatalf("失败的注册泄漏 %d 个计时器", count)
	}
}

func TestRestartCancelsOldTimers(t *testing.T) {
	e := newEnv(t)
	var generation atomic.Int64
	ticks := make(chan int64, 4)
	contexts := make(chan *kardia.Context, 2)
	fiber, err := e.root.Inject([]string{"timer"}, func(ctx *kardia.Context, _ any) (kardia.Disposable, error) {
		gen := generation.Add(1)
		contexts <- ctx
		_, err := e.svc.Interval(ctx, func() { ticks <- gen }, time.Second)
		return nil, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatal(err)
	}
	oldCtx := waitCh(t, contexts, "第一代上下文")
	e.clk.Advance(time.Second)
	if gen := waitCh(t, ticks, "第一代计时器"); gen != 1 {
		t.Fatal(gen)
	}
	if err := fiber.Restart(ctxBg); err != nil {
		t.Fatal(err)
	}
	_ = waitCh(t, contexts, "第二代上下文")
	if oldCtx.Lifetime().Err() == nil {
		t.Fatal("重启后旧代上下文没有取消")
	}
	if count, _ := e.clk.Pending(); count != 1 {
		t.Fatalf("重启后计时器数 %d，期望 1", count)
	}
	e.clk.Advance(time.Second)
	if gen := waitCh(t, ticks, "第二代计时器"); gen != 2 {
		t.Fatalf("旧代计时器仍活动：%d", gen)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatal(err)
	}
	if err := e.root.Tasks().Wait(ctxBg); err != nil {
		t.Fatal(err)
	}
	if count, _ := e.clk.Pending(); count != 0 {
		t.Fatalf("销毁后计时器数 %d", count)
	}
}

func TestIntervalIterCanceledReadDoesNotConsumeTick(t *testing.T) {
	e := newEnv(t)
	it, err := e.svc.IntervalIter(e.ctx, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(ctxBg)
	first := make(chan error, 1)
	go func() { _, err := it.Next(ctx); first <- err }()
	waitQueueLen(t, it, 1)
	cancel()
	if err := waitCh(t, first, "取消读取"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	second := make(chan iterOutcome, 1)
	go func() { res, err := it.Next(ctxBg); second <- iterOutcome{res: res, err: err} }()
	waitQueueLen(t, it, 1)
	e.clk.Advance(time.Second)
	if result := waitCh(t, second, "下一读取"); result.err != nil || result.res.Done {
		t.Fatalf("下一拍丢失：%+v", result)
	}
}

func TestTimeoutAfterConcurrentDisposeSettlesOnce(t *testing.T) {
	for i := 0; i < 50; i++ {
		e := newEnv(t)
		await, stop, err := e.svc.TimeoutAfter(e.ctx, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		stopped := make(chan struct{})
		go func() { stop(); close(stopped) }()
		e.clk.Advance(time.Second)
		first := await(ctxBg)
		<-stopped
		if second := await(ctxBg); !errors.Is(second, first) {
			t.Fatalf("终局变化：%v → %v", first, second)
		}
		if first != nil && !errors.Is(first, errDisposed) {
			t.Fatal(first)
		}
		if err := e.root.Fiber().Dispose(ctxBg); err != nil {
			t.Fatal(err)
		}
		if err := e.root.Tasks().Wait(ctxBg); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNewRollsBackServiceWhenMixinConflicts(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(ctxBg) })
	_, err := root.Accessor("interval", kardia.Accessor{Get: func(*kardia.Context, error) (any, error) { return "保留值", nil }})
	if err != nil {
		t.Fatal(err)
	}
	before := len(root.Fiber().GetEffects())
	if _, err := New(root); err == nil {
		t.Fatal("已有 interval accessor 时应返回冲突")
	}
	if value, err := root.Get("timer"); err != nil || value != nil {
		t.Fatalf("失败后 timer 服务未回滚：%v（%v）", value, err)
	}
	if value, err := root.Get("timeout"); err != nil || value != nil {
		t.Fatalf("失败后已安装 mixin 未回滚：%v（%v）", value, err)
	}
	if value, err := root.Get("interval"); err != nil || value != "保留值" {
		t.Fatalf("原 accessor 被破坏：%v（%v）", value, err)
	}
	if count := len(root.Fiber().GetEffects()); count != before {
		t.Fatalf("失败构造遗留 effect：%d，原有 %d", count, before)
	}
}

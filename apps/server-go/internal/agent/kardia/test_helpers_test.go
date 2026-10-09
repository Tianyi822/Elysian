// 根包测试助手不进入生产依赖图。
package kardia

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia/clock"
)

// TestBaseTime 是 WithTimers 构造 Manual 时钟的基准时刻：断言不依赖真实时钟。
var TestBaseTime = time.Unix(0, 0)

// WithTimers 对应 TS 的 withTimers（core/tests/utils.ts:5-15）：以 Manual
// 假时钟构造根 ctx 后运行 fn。TS 的 `await sleep(n)` / `vi.advanceTimersByTime-
// Async(n)` 统一改写为「clk.Advance(n) → ctx.Tasks().Wait(ctx)（或 Await/
// dispose）→ 断言」（方案 2.0 的测试确定性契约）。
func WithTimers(fn func(ctx *Context, clk *clock.Manual)) func(t *testing.T) {
	return func(t *testing.T) {
		t.Helper()
		clk := clock.NewManual(TestBaseTime)
		ctx := NewContext(WithClock(clk))
		fn(ctx, clk)
	}
}

// Session 对应 TS tests/utils.ts 的 Session：作为事件派发的 thisArg 携带
// 过滤器（实现方案 2.4 的 FilterCarrier）。
type Session struct {
	Flag bool
}

// CordisFilter 对应 TS 的 [Context.filter] 实现（utils.ts:23-30）：
// 目标 ctx 链上有 "filter" 属性（测试以 Extend 的 Props 挂载）时以其裁决，
// 否则放行。
func (s *Session) CordisFilter(target *Context) bool {
	if v, ok := target.Prop("filter"); ok {
		if fn, ok := v.(func(*Session) bool); ok && fn != nil {
			return fn(s)
		}
	}
	return true
}

// Filter 对应 TS tests/utils.ts 的 Filter：经 Extend 挂到 ctx 的 "filter"
// 属性（等价 TS 的 root.extend(new Filter(flag))）。
type Filter struct {
	flag bool
}

// NewFilter 构造过滤器。
func NewFilter(flag bool) *Filter { return &Filter{flag: flag} }

// Meta 返回携带 filter 属性的 ExtendMeta。
func (f *Filter) Meta() ExtendMeta {
	return ExtendMeta{Props: map[any]any{
		"filter": func(s *Session) bool { return s.Flag == f.flag },
	}}
}

// Counter 对应 TS tests/utils.ts 的 Counter（utils.ts:52-68）：TS 的
// [Service.tracker] 影子机制在 Go 侧以显式 access 参数承载——Increase 的
// effect 登记在访问点链的 fiber 上（service.spec 的 traceable effect 用例）。
type Counter struct {
	// Ctx 是构造 ctx。
	Ctx *Context

	value atomic.Int64
}

// NewCounter 构造计数器。
func NewCounter(ctx *Context) *Counter { return &Counter{Ctx: ctx} }

// Value 返回当前值。
func (c *Counter) Value() int { return int(c.value.Load()) }

// Increase 以 access 为 use site 登记自增 effect（对应 TS 的 this.ctx.effect）。
func (c *Counter) Increase(access *Context) {
	access.Effect("counter.increase()", func() (Disposable, error) {
		c.value.Add(1)
		return func(context.Context) error {
			c.value.Add(-1)
			return nil
		}, nil
	})
}

// GetHookSnapshot 对应 TS 的 getHookSnapshot（utils.ts:86-94）：非空事件桶
// 的「事件名→钩子数」快照，供泄漏检查深比较。
func GetHookSnapshot(ctx *Context) map[string]int {
	return ctx.Events().HookSnapshot()
}

// newTestService 只简化成功路径构造；失败立即使测试回调报错。
func newTestService(c *Context, name string, self any, check ServiceCheck) Service {
	s, err := NewService(c, name, self, check)
	if err != nil {
		panic(err)
	}
	return s
}

// advanceRegisteredTimer 等待计时器登记后精确推进，通知与快照同锁获取。
func advanceRegisteredTimer(t *testing.T, clk *clock.Manual, delta time.Duration) {
	t.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		pending, changed := clk.Pending()
		if pending > 0 {
			clk.Advance(delta)
			return
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatal("等待计时器登记超时")
		}
	}
}

func awaitTestSignal[T any](t *testing.T, ch <-chan T, stage string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(10 * time.Second):
		t.Fatalf("等待%s超时", stage)
		var zero T
		return zero
	}
}

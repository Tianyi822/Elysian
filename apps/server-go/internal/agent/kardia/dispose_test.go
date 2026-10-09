package kardia

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia/clock"
)

// 对应 core/tests/dispose.spec.ts（13 个用例）。TS 的同步生成器在 Go 统一为
// EffectIter 的异步拉取（方案 2.2：迭代型统一异步拉取，断言前先等拉取
// goroutine 收敛）；TS 的 async return（async execute）形态无 Go 等价，同样
// 以 EffectIter（sleep 后 yield）承载。aborted 系列按方案 2.2 的「ctx 取消
// 拉取」语义移植：dispose 即取消生成器在其阻塞等待处退出，TS 中「已 dispose
// 的生成器继续跑到下一个 yield」的时机差异列入差异清单。

// disposeRecorder 返回记录序号的清理器与对应构造函数。
func disposeRecorder(seq *[]int, n int) func(context.Context) error {
	return func(context.Context) error {
		*seq = append(*seq, n)
		return nil
	}
}

// noopListener 是空事件监听器。
func noopListener(*EventCtx) (any, error) { return nil, nil }

// TestDisposeByPlugin 对应 'dispose by plugin'：插件 effect 的元树、销毁
// 触发清理器、幂等。
func TestDisposeByPlugin(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	disposeCalls := 0
	fiber, err := root.Plugin(&Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			c.Effect("test", func() (Disposable, error) {
				return func(context.Context) error {
					disposeCalls++
					return nil
				}, nil
			})
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("装载插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待插件失败：%v", err)
	}
	want := []EffectMeta{{Label: "test", Children: []EffectMeta{}}}
	if got := fiber.GetEffects(); !reflect.DeepEqual(got, want) {
		t.Fatalf("effect 元树不符：%v want %v", got, want)
	}
	if disposeCalls != 0 {
		t.Fatalf("销毁前清理器不应执行，实际 %d 次", disposeCalls)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	if disposeCalls != 1 {
		t.Fatalf("清理器应恰好执行 1 次，实际 %d 次", disposeCalls)
	}
	if err := fiber.Dispose(ctxBg); err != nil {
		t.Fatalf("重复 dispose 失败：%v", err)
	}
	if disposeCalls != 1 {
		t.Fatalf("重复 dispose 不应再执行清理器，实际 %d 次", disposeCalls)
	}
}

// TestDisposeManually 对应 'dispose manually'：手动调用清理器（默认 label
// 为 anonymous）、幂等、调用后从元树移除。
func TestDisposeManually(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	disposeCalls := 0
	dispose, err := root.Fiber().Effect("", func() (Disposable, error) {
		return func(context.Context) error {
			disposeCalls++
			return nil
		}, nil
	})
	if err != nil {
		t.Fatalf("登记 effect 失败：%v", err)
	}
	want := []EffectMeta{{Label: "anonymous", Children: []EffectMeta{}}}
	if got := root.Fiber().GetEffects(); !reflect.DeepEqual(got, want) {
		t.Fatalf("effect 元树不符：%v want %v", got, want)
	}
	if disposeCalls != 0 {
		t.Fatalf("调用前清理器不应执行，实际 %d 次", disposeCalls)
	}
	if err := dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	if disposeCalls != 1 {
		t.Fatalf("清理器应恰好执行 1 次，实际 %d 次", disposeCalls)
	}
	if err := dispose(ctxBg); err != nil {
		t.Fatalf("重复 dispose 失败：%v", err)
	}
	if disposeCalls != 1 {
		t.Fatalf("重复 dispose 不应再执行清理器，实际 %d 次", disposeCalls)
	}
	if got := root.Fiber().GetEffects(); len(got) != 0 {
		t.Fatalf("手动 dispose 后元树应为空，实际 %v", got)
	}
}

// TestDisposeYieldDispose 对应 'yield dispose'：嵌套 yield 的元树结构与逆序
// 清理。断言依赖 events 服务的 On 以 `ctx.on("<name>")` 为 effect label
// （events.ts:165 的 label 格式）。
func TestDisposeYieldDispose(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var seq []int
	handle, err := root.Scope().Iter("", func(gctx context.Context, scope *EffectScope) error {
		if err := scope.Defer(disposeRecorder(&seq, 1)); err != nil {
			return err
		}
		scoped, err := scope.Bind(root)
		if err != nil {
			return err
		}
		if _, err := scoped.On(StringEvent("custom-event"), noopListener); err != nil {
			return err
		}
		if err := scope.Defer(disposeRecorder(&seq, 2)); err != nil {
			return err
		}
		_, err = scope.Iter("", func(gctx context.Context, child *EffectScope) error {
			scoped, err := child.Bind(root)
			if err != nil {
				return err
			}
			if _, err := scoped.On(StringEvent("custom-event"), noopListener); err != nil {
				return err
			}
			return child.Defer(disposeRecorder(&seq, 3))
		})
		return err
	})
	if err != nil {
		t.Fatalf("登记迭代型 effect 失败：%v", err)
	}
	// 显式作用域决定归属；等待生产者完成后核验完整元树。
	if err := root.Tasks().Wait(ctxBg); err != nil {
		t.Fatalf("等待生成器收敛失败：%v", err)
	}
	_, _ = root.On(StringEvent("custom-event"), noopListener)
	onMeta := EffectMeta{Label: `ctx.on("custom-event")`, Children: []EffectMeta{}}
	want := []EffectMeta{
		{
			Label: "anonymous",
			Children: []EffectMeta{
				onMeta,
				{Label: "anonymous", Children: []EffectMeta{onMeta}},
			},
		},
		onMeta,
	}
	if got := root.Fiber().GetEffects(); !reflect.DeepEqual(got, want) {
		t.Fatalf("effect 元树不符：%v want %v", got, want)
	}
	if len(seq) != 0 {
		t.Fatalf("清理器不应提前执行：%v", seq)
	}
	if err := handle.Dispose(ctxBg); err != nil {
		t.Fatalf("dispose 失败：%v", err)
	}
	if !reflect.DeepEqual(seq, []int{3, 2, 1}) {
		t.Fatalf("清理顺序应为 [3 2 1]，实际 %v", seq)
	}
	if err := handle.Dispose(ctxBg); err != nil {
		t.Fatalf("重复 dispose 失败：%v", err)
	}
	if !reflect.DeepEqual(seq, []int{3, 2, 1}) {
		t.Fatalf("重复 dispose 不应再执行清理器：%v", seq)
	}
}

// TestDisposeAsyncReturn1 对应 'async return 1'：到期后登记清理器，dispose
// 等任务完成再清理。
func TestDisposeAsyncReturn1(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		progress := make(chan struct{})
		dispose, err := root.Fiber().EffectIter("", func(gctx context.Context, yield func(Disposable) error) error {
			if err := root.Clock().Sleep(gctx, 100*time.Millisecond); err != nil {
				return err
			}
			seq = append(seq, 1)
			if err := yield(func(context.Context) error {
				seq = append(seq, 2)
				return nil
			}); err != nil {
				return err
			}
			close(progress)
			return nil
		})
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		if len(seq) != 0 {
			t.Fatalf("到期前不应有进度：%v", seq)
		}
		advanceRegisteredTimer(t, clk, 100*time.Millisecond)
		awaitTestSignal(t, progress, "生成器登记清理器")
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if !reflect.DeepEqual(seq, []int{1, 2}) {
			t.Fatalf("dispose 后应为 [1 2]，实际 %v", seq)
		}
	})(t)
}

// TestDisposeAsyncReturn2 对应 'async return 2'：任务未完成即 dispose——按
// 方案 2.2 的取消语义，生成器在阻塞等待处退出，不再产生进度（TS 中任务会
// 跑完并随后清理，差异见差异清单）。
func TestDisposeAsyncReturn2(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		dispose, err := root.Fiber().EffectIter("", func(gctx context.Context, yield func(Disposable) error) error {
			if err := root.Clock().Sleep(gctx, 100*time.Millisecond); err != nil {
				return err
			}
			seq = append(seq, 1)
			return yield(func(context.Context) error {
				seq = append(seq, 2)
				return nil
			})
		})
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if len(seq) != 0 {
			t.Fatalf("取消后不应有进度：%v", seq)
		}
		clk.Advance(300 * time.Millisecond)
		if len(seq) != 0 {
			t.Fatalf("取消后的推进不应再产生进度：%v", seq)
		}
	})(t)
}

// TestDisposeAsyncYield1 对应 'async yield 1'：多段 yield 全部完成后逆序清理。
func TestDisposeAsyncYield1(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		progress := make(chan int, 3)
		dispose, err := root.Fiber().EffectIter("", asyncYieldGen(root, &seq, progress))
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		if len(seq) != 0 {
			t.Fatalf("推进前不应有进度：%v", seq)
		}
		for _, want := range []int{1, 3, 5} {
			advanceRegisteredTimer(t, clk, 100*time.Millisecond)
			if got := awaitTestSignal(t, progress, "生成器阶段完成"); got != want {
				t.Fatalf("阶段 %d，期望 %d", got, want)
			}
		}
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if !reflect.DeepEqual(seq, []int{1, 3, 5, 6, 4, 2}) {
			t.Fatalf("dispose 后应为 [1 3 5 6 4 2]，实际 %v", seq)
		}
	})(t)
}

// TestDisposeAsyncYield2Aborted 对应 'async yield 2 (aborted)'：首段等待期间
// dispose——生成器在阻塞等待处退出（TS 为继续跑到首个 yield，差异见差异
// 清单），无清理器执行。
func TestDisposeAsyncYield2Aborted(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		progress := make(chan int, 3)
		dispose, err := root.Fiber().EffectIter("", asyncYieldGen(root, &seq, progress))
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		advanceRegisteredTimer(t, clk, 50*time.Millisecond)
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if len(seq) != 0 {
			t.Fatalf("中止时不应有进度：%v", seq)
		}
		clk.Advance(300 * time.Millisecond)
		if len(seq) != 0 {
			t.Fatalf("中止后的推进不应再产生进度：%v", seq)
		}
	})(t)
}

// TestDisposeAsyncYield3Aborted 对应 'async yield 3 (aborted)'：首段 yield
// 之后 dispose——已登记清理器逆序执行，生成器在第二段等待处退出（TS 为
// 继续跑到第二段 yield，差异见差异清单）。
func TestDisposeAsyncYield3Aborted(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		progress := make(chan int, 3)
		dispose, err := root.Fiber().EffectIter("", asyncYieldGen(root, &seq, progress))
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		advanceRegisteredTimer(t, clk, 100*time.Millisecond)
		if got := awaitTestSignal(t, progress, "生成器首段完成"); got != 1 {
			t.Fatalf("阶段 %d，期望 1", got)
		}
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if !reflect.DeepEqual(seq, []int{1, 2}) {
			t.Fatalf("dispose 后应为 [1 2]，实际 %v", seq)
		}
		clk.Advance(300 * time.Millisecond)
		if !reflect.DeepEqual(seq, []int{1, 2}) {
			t.Fatalf("中止后的推进不应再产生进度：%v", seq)
		}
	})(t)
}

// TestDisposeAsyncYield4AwaitDispose 对应 'async yield 4 (await dispose)'：
// 全部完成后 dispose，逆序清理且幂等。
func TestDisposeAsyncYield4AwaitDispose(t *testing.T) {
	WithTimers(func(root *Context, clk *clock.Manual) {
		ctxBg := context.Background()
		var seq []int
		progress := make(chan int, 3)
		dispose, err := root.Fiber().EffectIter("", asyncYieldGen(root, &seq, progress))
		if err != nil {
			t.Fatalf("登记迭代型 effect 失败：%v", err)
		}
		if len(seq) != 0 {
			t.Fatalf("推进前不应有进度：%v", seq)
		}
		for _, want := range []int{1, 3, 5} {
			advanceRegisteredTimer(t, clk, 100*time.Millisecond)
			if got := awaitTestSignal(t, progress, "生成器阶段完成"); got != want {
				t.Fatalf("阶段 %d，期望 %d", got, want)
			}
		}
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("dispose 失败：%v", err)
		}
		if !reflect.DeepEqual(seq, []int{1, 3, 5, 6, 4, 2}) {
			t.Fatalf("dispose 后应为 [1 3 5 6 4 2]，实际 %v", seq)
		}
		if err := dispose(ctxBg); err != nil {
			t.Fatalf("重复 dispose 失败：%v", err)
		}
		if !reflect.DeepEqual(seq, []int{1, 3, 5, 6, 4, 2}) {
			t.Fatalf("重复 dispose 不应再执行清理器：%v", seq)
		}
	})(t)
}

// asyncYieldGen 构造 'async yield' 系列的三段生成器：每段 sleep(100)、
// 记录奇数、yield 偶数清理器。
func asyncYieldGen(root *Context, seq *[]int, progress chan<- int) EffectGen {
	return func(gctx context.Context, yield func(Disposable) error) error {
		for _, n := range []int{1, 3, 5} {
			if err := root.Clock().Sleep(gctx, 100*time.Millisecond); err != nil {
				return err
			}
			*seq = append(*seq, n)
			if err := yield(disposeRecorder(seq, n+1)); err != nil {
				return err
			}
			progress <- n
		}
		return nil
	}
}

// TestDisposeReturnWithError 对应 'return with error'：execute 失败时错误
// 即刻返回（TS 的同步 throw 通道）。
func TestDisposeReturnWithError(t *testing.T) {
	root := NewContext()
	var seq []int
	_, err := root.Fiber().Effect("", func() (Disposable, error) {
		return nil, errors.New("test")
	})
	if err == nil || err.Error() != "test" {
		t.Fatalf("effect 应返回错误 test，实际 %v", err)
	}
	if len(seq) != 0 {
		t.Fatalf("清理器不应执行：%v", seq)
	}
}

// TestDisposeYieldWithError 对应 'yield with error'：生成器在 yield 后失败，
// 已登记清理器被清理（TS 的同步生成器在 Go 统一为异步拉取，错误经清理器
// 返回值暴露）。
func TestDisposeYieldWithError(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var seq []int
	dispose, err := root.Fiber().EffectIter("", func(gctx context.Context, yield func(Disposable) error) error {
		if err := yield(disposeRecorder(&seq, 1)); err != nil {
			return err
		}
		return errors.New("test")
	})
	if err != nil {
		t.Fatalf("登记迭代型 effect 失败：%v", err)
	}
	if err := root.Tasks().Wait(ctxBg); err != nil {
		t.Fatalf("等待生成器收敛失败：%v", err)
	}
	if !reflect.DeepEqual(seq, []int{1}) {
		t.Fatalf("失败路径应清理已登记项，实际 %v", seq)
	}
	if err := dispose(ctxBg); err == nil {
		t.Fatal("清理器应把生成器错误返回（对应 TS 的 await dispose rejects）")
	}
	if !reflect.DeepEqual(seq, []int{1}) {
		t.Fatalf("重复清理不应执行：%v", seq)
	}
}

// TestDisposeAsyncReturnWithError 对应 'async return with error'：任务在
// 登记清理器前失败，无清理器执行，错误经清理器返回。
func TestDisposeAsyncReturnWithError(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var seq []int
	dispose, err := root.Fiber().EffectIter("", func(gctx context.Context, yield func(Disposable) error) error {
		return errors.New("test")
	})
	if err != nil {
		t.Fatalf("登记迭代型 effect 失败：%v", err)
	}
	if err := root.Tasks().Wait(ctxBg); err != nil {
		t.Fatalf("等待生成器收敛失败：%v", err)
	}
	if len(seq) != 0 {
		t.Fatalf("清理器不应执行：%v", seq)
	}
	if err := dispose(ctxBg); err == nil || err.Error() != "test" {
		t.Fatalf("清理器应返回任务错误 test，实际 %v", err)
	}
}

// TestDisposeAsyncYieldWithError 对应 'async yield with error'：异步生成器
// yield 后失败，已登记清理器被清理且错误可观察。
func TestDisposeAsyncYieldWithError(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	var seq []int
	dispose, err := root.Fiber().EffectIter("", func(gctx context.Context, yield func(Disposable) error) error {
		if err := yield(disposeRecorder(&seq, 1)); err != nil {
			return err
		}
		return errors.New("test")
	})
	if err != nil {
		t.Fatalf("登记迭代型 effect 失败：%v", err)
	}
	if err := root.Tasks().Wait(ctxBg); err != nil {
		t.Fatalf("等待生成器收敛失败：%v", err)
	}
	if !reflect.DeepEqual(seq, []int{1}) {
		t.Fatalf("失败路径应清理已登记项，实际 %v", seq)
	}
	err = dispose(ctxBg)
	if err == nil {
		t.Fatal("清理器应返回生成器错误（对应 TS 的 await dispose rejects）")
	}
	if err.Error() != "test" {
		t.Fatalf("错误文案应为 test，实际 %v", err)
	}
}

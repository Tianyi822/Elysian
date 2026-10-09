package kardia

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// 对应 core/tests/events.spec.ts（15 个用例）。TS 的 mock.fn 以计数闭包
// 承载；TS 的 async 监听器（await 后失败）以 channel 编排承载（确定性，
// 不依赖真实时间）；'after awaiting' 的二次 next 在 Go 同步等价为「next
// 成功返回后紧接着的再次调用」。

// eventsTestEvent 是通用测试事件名（tests/utils.ts 的 event）。
var eventsTestEvent = StringEvent("custom-event")

// TestEventsSymbolNamesAcrossModes 对应 'supports symbol event names across
// dispatch modes'：同一符号事件名在 emit/bail/serial/parallel 四种模式下
// 依次派发，参数序列保序；退订后不再触发。
func TestEventsSymbolNamesAcrossModes(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	event := SymbolEvent(NewSymbol("event"))
	var values []int
	dispose, _ := root.On(event, func(ev *EventCtx) (any, error) {
		values = append(values, ev.Args[0].(int))
		return ev.Args[0], nil
	})

	if err := root.Emit(event, 1); err != nil {
		t.Fatalf("emit 失败：%v", err)
	}
	if result, err := root.Bail(event, 2); err != nil || result != 2 {
		t.Fatalf("bail 应返回 2，实际 (%v, %v)", result, err)
	}
	if result, err := root.Serial(ctxBg, event, 3); err != nil || result != 3 {
		t.Fatalf("serial 应返回 3，实际 (%v, %v)", result, err)
	}
	if err := root.Parallel(ctxBg, event, 4); err != nil {
		t.Fatalf("parallel 失败：%v", err)
	}
	if !reflect.DeepEqual(values, []int{1, 2, 3, 4}) {
		t.Fatalf("监听器参数序列应为 [1 2 3 4]，实际 %v", values)
	}

	dispose()
	if err := root.Emit(event, 5); err != nil {
		t.Fatalf("退订后 emit 不应报错：%v", err)
	}
	if len(values) != 4 {
		t.Fatalf("退订后监听器不应再触发，实际 %d 次", len(values))
	}
}

// TestEventsSymbolNamesWithOnce 对应 'supports symbol event names with
// ctx.once()'：符号事件名的一次性监听器恰好触发一次。
func TestEventsSymbolNamesWithOnce(t *testing.T) {
	root := NewContext()
	event := SymbolEvent(NewSymbol("once"))
	calls := 0
	root.Once(event, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})

	_ = root.Emit(event)
	_ = root.Emit(event)
	if calls != 1 {
		t.Fatalf("once 监听器应恰好触发 1 次，实际 %d 次", calls)
	}
}

// TestEventsPrototypePropertyNames 对应 'treats prototype property names as
// ordinary events'：原型名是普通事件名，派发未注册名不异常，退订后桶回收。
func TestEventsPrototypePropertyNames(t *testing.T) {
	root := NewContext()

	// 派发未注册的事件名不得异常（TS：不得触达 Object.prototype）
	if err := root.Emit(StringEvent("toString")); err != nil {
		t.Fatalf("派发未注册名不应报错：%v", err)
	}

	for _, name := range []string{"__proto__", "toString", "constructor"} {
		calls := 0
		event := StringEvent(name)
		dispose, _ := root.On(event, func(*EventCtx) (any, error) {
			calls++
			return nil, nil
		})

		if err := root.Emit(event); err != nil {
			t.Fatalf("%s：emit 失败：%v", name, err)
		}
		if calls != 1 {
			t.Fatalf("%s：监听器应触发 1 次，实际 %d 次", name, calls)
		}
		dispose()
		if err := root.Emit(event); err != nil {
			t.Fatalf("%s：退订后 emit 失败：%v", name, err)
		}
		if calls != 1 {
			t.Fatalf("%s：退订后监听器不应再触发", name)
		}
		if _, ok := root.Events().HookSnapshot()[name]; ok {
			t.Fatalf("%s：退订后事件桶应被回收", name)
		}
	}
}

// TestEventsBucketRecycled 对应 'removes empty event buckets after
// disposal'：同桶两次登记，第一次退订桶保留，第二次退订桶删除。
func TestEventsBucketRecycled(t *testing.T) {
	root := NewContext()
	event := SymbolEvent(NewSymbol("temporary"))
	first, _ := root.On(event, noopListener)
	second, _ := root.On(event, noopListener)

	first()
	if got := root.Events().HookSnapshot()[event.String()]; got != 1 {
		t.Fatalf("第一次退订后桶内应剩 1 个钩子，实际 %d", got)
	}
	second()
	if _, ok := root.Events().HookSnapshot()[event.String()]; ok {
		t.Fatalf("第二次退订后事件桶应被删除")
	}
}

// TestEventsOn 对应 'ctx.on()'：注册、重复触发、退订后不再触发。
func TestEventsOn(t *testing.T) {
	root := NewContext()
	calls := 0
	dispose, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})
	if err := root.Emit(eventsTestEvent); err != nil {
		t.Fatalf("emit 失败：%v", err)
	}
	if calls != 1 {
		t.Fatalf("首次触发后应调用 1 次，实际 %d 次", calls)
	}
	_ = root.Emit(eventsTestEvent)
	if calls != 2 {
		t.Fatalf("第二次触发后应调用 2 次，实际 %d 次", calls)
	}
	dispose()
	_ = root.Emit(eventsTestEvent)
	if calls != 2 {
		t.Fatalf("退订后不应再触发，实际 %d 次", calls)
	}
}

// TestEventsOnce 对应 'ctx.once()'：一次性监听器触发后退订，显式退订幂等。
func TestEventsOnce(t *testing.T) {
	root := NewContext()
	calls := 0
	dispose, _ := root.Once(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})
	_ = root.Emit(eventsTestEvent)
	if calls != 1 {
		t.Fatalf("首次触发后应调用 1 次，实际 %d 次", calls)
	}
	_ = root.Emit(eventsTestEvent)
	if calls != 1 {
		t.Fatalf("一次性监听器不应重复触发，实际 %d 次", calls)
	}
	dispose()
	_ = root.Emit(eventsTestEvent)
	if calls != 1 {
		t.Fatalf("显式退订后不应触发，实际 %d 次", calls)
	}
}

// TestEventsParallel 对应 'ctx.parallel()'：过滤器语义 + 单个失败监听器
// 不得短路其它（失败聚合为 *AggregateError，成员按集合比较）。
func TestEventsParallel(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	if err := root.Parallel(ctxBg, eventsTestEvent); err != nil {
		t.Fatalf("无监听器的 parallel 不应报错：%v", err)
	}

	calls := 0
	filtered := root.Extend(NewFilter(true).Meta())
	filtered.On(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})

	_ = root.Parallel(ctxBg, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("无 thisArg 的 parallel 应触发监听器 1 次，实际 %d 次", calls)
	}
	_ = root.ParallelTo(ctxBg, &Session{Flag: false}, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("被过滤的 parallel 不应触发监听器，实际 %d 次", calls)
	}
	_ = root.ParallelTo(ctxBg, &Session{Flag: true}, eventsTestEvent)
	if calls != 2 {
		t.Fatalf("通过过滤的 parallel 应再次触发，实际 %d 次", calls)
	}

	// 一个失败的监听器不得短路其它（events.spec.ts:116-131）
	throwMode := false
	syncRan := make(chan struct{})
	release := make(chan struct{})
	var (
		settled bool
		slock   sync.Mutex
	)
	asyncErr := errors.New("async")
	syncErr := errors.New("test")
	disposeSync, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		if !throwMode {
			return nil, nil
		}
		select {
		case syncRan <- struct{}{}:
		default:
		}
		return nil, syncErr
	})
	disposeAsync, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		<-release // 等价 TS 的 await new Promise(resolve => setTimeout(resolve, 0))
		slock.Lock()
		settled = true
		slock.Unlock()
		return nil, asyncErr
	})
	throwMode = true

	result := make(chan error, 1)
	go func() { result <- root.Parallel(ctxBg, eventsTestEvent) }()

	<-syncRan // 同步监听器已失败
	close(release)
	err := <-result

	agg, ok := err.(*AggregateError)
	if !ok {
		t.Fatalf("parallel 失败应聚合为 *AggregateError，实际 %T：%v", err, err)
	}
	msgs := make([]string, 0, len(agg.Errors))
	for _, item := range agg.Errors {
		msgs = append(msgs, item.Error())
	}
	if len(msgs) != 2 || !((msgs[0] == "test" && msgs[1] == "async") || (msgs[0] == "async" && msgs[1] == "test")) {
		t.Fatalf("聚合错误应同时含 test 与 async，实际 %v", msgs)
	}
	slock.Lock()
	done := settled
	slock.Unlock()
	if !done {
		t.Fatalf("失败监听器不应短路其它监听器的完成")
	}
	disposeSync()
	disposeAsync()
}

// TestEventsEmit 对应 'ctx.emit()'：过滤器语义 + 监听器错误即刻穿透。
func TestEventsEmit(t *testing.T) {
	root := NewContext()
	if err := root.Emit(eventsTestEvent); err != nil {
		t.Fatalf("无监听器的 emit 不应报错：%v", err)
	}

	calls := 0
	filtered := root.Extend(NewFilter(true).Meta())
	filtered.On(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})

	_ = root.Emit(eventsTestEvent)
	if calls != 1 {
		t.Fatalf("无 thisArg 的 emit 应触发监听器 1 次，实际 %d 次", calls)
	}
	_ = root.EmitTo(&Session{Flag: false}, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("被过滤的 emit 不应触发监听器，实际 %d 次", calls)
	}
	_ = root.EmitTo(&Session{Flag: true}, eventsTestEvent)
	if calls != 2 {
		t.Fatalf("通过过滤的 emit 应再次触发，实际 %d 次", calls)
	}

	throwMode := true
	dispose, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		if throwMode {
			return nil, errors.New("test")
		}
		return nil, nil
	})
	if err := root.Emit(eventsTestEvent); err == nil || err.Error() != "test" {
		t.Fatalf("监听器错误应即刻穿透，实际 %v", err)
	}
	dispose()
}

// TestEventsSerial 对应 'ctx.serial()'：过滤器语义 + 监听器错误即刻中止。
func TestEventsSerial(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	if _, err := root.Serial(ctxBg, eventsTestEvent); err != nil {
		t.Fatalf("无监听器的 serial 不应报错：%v", err)
	}

	calls := 0
	filtered := root.Extend(NewFilter(true).Meta())
	filtered.On(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})

	_, _ = root.Serial(ctxBg, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("无 thisArg 的 serial 应触发监听器 1 次，实际 %d 次", calls)
	}
	_, _ = root.SerialTo(ctxBg, &Session{Flag: false}, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("被过滤的 serial 不应触发监听器，实际 %d 次", calls)
	}
	_, _ = root.SerialTo(ctxBg, &Session{Flag: true}, eventsTestEvent)
	if calls != 2 {
		t.Fatalf("通过过滤的 serial 应再次触发，实际 %d 次", calls)
	}

	dispose, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		return nil, errors.New("串行监听器失败")
	})
	if _, err := root.Serial(ctxBg, eventsTestEvent); err == nil || !strings.Contains(err.Error(), "串行监听器失败") {
		t.Fatalf("监听器错误应即刻中止串行派发，实际 %v", err)
	}
	dispose()
}

// TestEventsBail 对应 'ctx.bail()'：过滤器语义 + 监听器错误即刻穿透。
func TestEventsBail(t *testing.T) {
	root := NewContext()
	if _, err := root.Bail(eventsTestEvent); err != nil {
		t.Fatalf("无监听器的 bail 不应报错：%v", err)
	}

	calls := 0
	filtered := root.Extend(NewFilter(true).Meta())
	filtered.On(eventsTestEvent, func(*EventCtx) (any, error) {
		calls++
		return nil, nil
	})

	_, _ = root.Bail(eventsTestEvent)
	if calls != 1 {
		t.Fatalf("无 thisArg 的 bail 应触发监听器 1 次，实际 %d 次", calls)
	}
	_, _ = root.BailTo(&Session{Flag: false}, eventsTestEvent)
	if calls != 1 {
		t.Fatalf("被过滤的 bail 不应触发监听器，实际 %d 次", calls)
	}
	_, _ = root.BailTo(&Session{Flag: true}, eventsTestEvent)
	if calls != 2 {
		t.Fatalf("通过过滤的 bail 应再次触发，实际 %d 次", calls)
	}

	dispose, _ := root.On(eventsTestEvent, func(*EventCtx) (any, error) {
		return nil, errors.New("拦截监听器失败")
	})
	if _, err := root.Bail(eventsTestEvent); err == nil || !strings.Contains(err.Error(), "拦截监听器失败") {
		t.Fatalf("监听器错误应即刻穿透 bail，实际 %v", err)
	}
	dispose()
}

// TestEventsWaterfall 对应 'ctx.waterfall()'：next 链逐层穿透；监听器不调
// next 且正常返回即否决（后续监听器不再调用）。
func TestEventsWaterfall(t *testing.T) {
	root := NewContext()
	wf := StringEvent("test/waterfall")
	terminal := func(ev *EventCtx) (any, error) { return 2, nil }
	var cb1, cb2, cb3, cb4 int
	root.On(wf, func(ev *EventCtx) (any, error) {
		cb1++
		value := ev.Args[0].(int)
		result, err := ev.Next()
		if err != nil {
			return nil, err
		}
		return value + result.(int), nil
	})
	root.On(wf, func(ev *EventCtx) (any, error) {
		cb2++
		value := ev.Args[0].(int)
		result, err := ev.Next()
		if err != nil {
			return nil, err
		}
		return value + result.(int), nil
	})

	if result, err := root.Waterfall(wf, terminal, 1); err != nil || result != 4 {
		t.Fatalf("两层穿透后瀑布结果应为 4，实际 (%v, %v)", result, err)
	}
	if cb1 != 1 || cb2 != 1 {
		t.Fatalf("两个监听器应各调用 1 次，实际 %d/%d", cb1, cb2)
	}

	root.On(wf, func(ev *EventCtx) (any, error) {
		cb3++
		return ev.Args[0].(int), nil // 否决：不调用 next
	})
	root.On(wf, func(ev *EventCtx) (any, error) {
		cb4++
		value := ev.Args[0].(int)
		result, err := ev.Next()
		if err != nil {
			return nil, err
		}
		return value + result.(int), nil
	})
	if result, err := root.Waterfall(wf, terminal, 1); err != nil || result != 3 {
		t.Fatalf("否决后瀑布结果应为 3，实际 (%v, %v)", result, err)
	}
	if cb1 != 2 || cb2 != 2 || cb3 != 1 || cb4 != 0 {
		t.Fatalf("否决后调用计数应为 2/2/1/0，实际 %d/%d/%d/%d", cb1, cb2, cb3, cb4)
	}
}

// TestEventsWaterfallRejectsDuplicateNext 对应 'ctx.waterfall() rejects
// duplicate next()'：同一帧二次 next 返回错误，瀑布以错误收场，terminal
// 恰好执行一次。
func TestEventsWaterfallRejectsDuplicateNext(t *testing.T) {
	root := NewContext()
	wf := StringEvent("test/waterfall")
	terminalCalls := 0
	callbackCalls := 0
	root.On(wf, func(ev *EventCtx) (any, error) {
		callbackCalls++
		if _, err := ev.Next(); err != nil {
			return nil, err
		}
		return ev.Next()
	})

	_, err := root.Waterfall(wf, func(ev *EventCtx) (any, error) {
		terminalCalls++
		return 2, nil
	}, 1)
	if err == nil || !strings.Contains(err.Error(), "next() 已被调用") {
		t.Fatalf("二次 next 应返回错误，实际 %v", err)
	}
	if callbackCalls != 1 {
		t.Fatalf("监听器应调用 1 次，实际 %d 次", callbackCalls)
	}
	if terminalCalls != 1 {
		t.Fatalf("terminal 应执行 1 次，实际 %d 次", terminalCalls)
	}
}

// TestEventsWaterfallRejectsOuterFrameContinuation 对应 'ctx.waterfall()
// rejects continuations from outer frames'：terminal 内调用外层帧的 next
// 被拒绝，调用顺序 first → second → terminal。
func TestEventsWaterfallRejectsOuterFrameContinuation(t *testing.T) {
	root := NewContext()
	wf := StringEvent("test/waterfall")
	var calls []string
	var outerNext func() (any, error)
	root.On(wf, func(ev *EventCtx) (any, error) {
		outerNext = ev.Next
		calls = append(calls, "first")
		return outerNext()
	})
	root.On(wf, func(ev *EventCtx) (any, error) {
		calls = append(calls, "second")
		return ev.Next()
	})

	_, err := root.Waterfall(wf, func(ev *EventCtx) (any, error) {
		calls = append(calls, "terminal")
		return outerNext()
	}, 1)
	if err == nil || !strings.Contains(err.Error(), "next() 已被调用") {
		t.Fatalf("外层帧延续应返回错误，实际 %v", err)
	}
	if !reflect.DeepEqual(calls, []string{"first", "second", "terminal"}) {
		t.Fatalf("调用顺序应为 first/second/terminal，实际 %v", calls)
	}
}

// TestEventsWaterfallDuplicateNextAfterAwait 对应 'ctx.waterfall() rejects
// duplicate next() after awaiting'：TS 的 async 监听器在 await next() 之后
// 再次调用 next 被拒；Go 同步等价为「next 成功返回后的再次调用」。
func TestEventsWaterfallDuplicateNextAfterAwait(t *testing.T) {
	root := NewContext()
	awf := StringEvent("test/async-waterfall")
	terminalCalls := 0
	root.On(awf, func(ev *EventCtx) (any, error) {
		result, err := ev.Next() // 等价 await next()
		if err != nil {
			return nil, err
		}
		if _, err := ev.Next(); err == nil {
			t.Errorf("await 后的二次 next 应返回错误")
		}
		return ev.Args[0].(int) + result.(int), nil
	})

	if result, err := root.Waterfall(awf, func(ev *EventCtx) (any, error) {
		terminalCalls++
		return 2, nil
	}, 1); err != nil || result != 3 {
		t.Fatalf("瀑布结果应为 3，实际 (%v, %v)", result, err)
	}
	if terminalCalls != 1 {
		t.Fatalf("terminal 应执行 1 次，实际 %d 次", terminalCalls)
	}
}

// TestEventsWaterfallNestedAsyncCalls 对应 'ctx.waterfall() supports nested
// async calls'：监听器内嵌套发起同事件瀑布（TS 的 await root.waterfall），
// 各层独立计数。
func TestEventsWaterfallNestedAsyncCalls(t *testing.T) {
	root := NewContext()
	awf := StringEvent("test/async-waterfall")
	callbackCalls := 0
	terminalCalls := 0
	root.On(awf, func(ev *EventCtx) (any, error) {
		callbackCalls++
		result, err := ev.Next()
		if err != nil {
			return nil, err
		}
		value := ev.Args[0].(int)
		if value == 1 {
			nested, err := root.Waterfall(awf, func(ev *EventCtx) (any, error) {
				terminalCalls++
				return 2, nil
			}, 2)
			if err != nil {
				return nil, err
			}
			return result.(int) + nested.(int), nil
		}
		return result, nil
	})

	result, err := root.Waterfall(awf, func(ev *EventCtx) (any, error) {
		terminalCalls++
		return 2, nil
	}, 1)
	if err != nil || result != 4 {
		t.Fatalf("嵌套瀑布结果应为 4，实际 (%v, %v)", result, err)
	}
	if callbackCalls != 2 {
		t.Fatalf("监听器应共调用 2 次，实际 %d 次", callbackCalls)
	}
	if terminalCalls != 2 {
		t.Fatalf("terminal 应共执行 2 次，实际 %d 次", terminalCalls)
	}
}

package clock

import (
	"context"
	"testing"
	"time"
)

func TestRealClock(t *testing.T) {
	clk := Real{}
	base := clk.Now()
	if clk.Now().Before(base) {
		t.Fatalf("Now 不应回退：%v < %v", clk.Now(), base)
	}
	if err := clk.Sleep(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("Sleep 应正常返回，得到错误：%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := clk.Sleep(ctx, time.Hour); err == nil {
		t.Fatal("已取消的 ctx 上 Sleep 应返回错误")
	}
}

func TestTaskGroupWait(t *testing.T) {
	g := &TaskGroup{}
	done := make(chan struct{})
	g.Go(func() { <-done })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := g.Wait(ctx); err == nil {
		t.Fatal("存在未完成任务时 Wait 应阻塞到 ctx 取消并返回错误")
	}
	close(done)
	if err := g.Wait(context.Background()); err != nil {
		t.Fatalf("任务结束后 Wait 应返回 nil：%v", err)
	}
}

func TestTaskGroupWaitContextCancel(t *testing.T) {
	g := &TaskGroup{}
	release := make(chan struct{})
	g.Go(func() { <-release })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := g.Wait(ctx); err == nil {
		t.Fatal("ctx 取消时 Wait 应返回错误")
	}
	close(release)
}

func TestTaskGroupRecoversPanic(t *testing.T) {
	g := &TaskGroup{}
	g.Go(func() { panic("boom") })
	// 任务 panic 必须 recover；未设处理器时由 Wait 返回错误而不是崩溃。
	err := g.Wait(context.Background())
	if err == nil {
		t.Fatal("未设处理器的任务 panic 应由 Wait 返回错误")
	}
	if want := "任务发生 panic: boom"; err.Error() != want {
		t.Fatalf("panic 错误文案不符：got %q want %q", err.Error(), want)
	}

	// 设处理器后 panic 转交处理器，Wait 返回 nil。
	seen := make(chan any, 1)
	g2 := &TaskGroup{}
	g2.SetPanicHandler(func(v any) { seen <- v })
	g2.Go(func() { panic("again") })
	if err := g2.Wait(context.Background()); err != nil {
		t.Fatalf("设处理器后 Wait 应返回 nil：%v", err)
	}
	if v := <-seen; v != "again" {
		t.Fatalf("处理器应收到 panic 值：%v", v)
	}
}

// 已有任务在完成前登记的子任务必须被同一次 Wait 覆盖。
func TestTaskGroupWaitIncludesChildren(t *testing.T) {
	g := &TaskGroup{}
	parent := make(chan struct{})
	child := make(chan struct{})
	registered := make(chan struct{})
	g.Go(func() {
		<-parent
		g.Go(func() { <-child })
		close(registered)
	})
	waited := make(chan error, 1)
	go func() { waited <- g.Wait(context.Background()) }()
	close(parent)
	<-registered
	select {
	case err := <-waited:
		t.Fatalf("子任务未完成，Wait 却返回：%v", err)
	default:
	}
	close(child)
	if err := <-waited; err != nil {
		t.Fatal(err)
	}
}

func TestTaskGroupConcurrentWaitAndCancel(t *testing.T) {
	g := &TaskGroup{}
	release := make(chan struct{})
	g.Go(func() { <-release })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 1000; i++ {
		if err := g.Wait(ctx); err != context.Canceled {
			t.Fatalf("已取消等待：%v", err)
		}
	}
	waited := make(chan error, 8)
	for i := 0; i < cap(waited); i++ {
		go func() { waited <- g.Wait(context.Background()) }()
	}
	close(release)
	for i := 0; i < cap(waited); i++ {
		if err := <-waited; err != nil {
			t.Fatal(err)
		}
	}
}

func TestTaskGroupPanicDoesNotShortCircuitWait(t *testing.T) {
	g := &TaskGroup{}
	release := make(chan struct{})
	g.Go(func() { <-release })
	g.Go(func() { panic("失败") })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.Wait(ctx); err != context.Canceled {
		t.Fatalf("有任务未结束应取消等待，实际 %v", err)
	}
	close(release)
	if err := g.Wait(context.Background()); err == nil {
		t.Fatal("全部任务结束后应返回 panic")
	}
	if err := g.Wait(context.Background()); err == nil {
		t.Fatal("重复等待应观察同一失败")
	}
}

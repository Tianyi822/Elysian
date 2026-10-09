// Package clock 提供可注入时钟与登记框架 goroutine 的任务组。
// Manual 只推进时间；任务完成、计时器回调及事件处理仍通过各自通道同步。
package clock

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Timer 是一次等待的句柄。Stop 撤销未到期计时器，不关闭 Chan。
type Timer interface {
	Chan() <-chan time.Time
	Stop() bool
}

// Clock 是框架内的统一时钟抽象。实现必须可并发安全使用。
type Clock interface {
	Now() time.Time
	NewTimer(d time.Duration) Timer
	After(d time.Duration) <-chan time.Time
	Sleep(ctx context.Context, d time.Duration) error
}

// Real 使用运行时真实时钟。
type Real struct{}

type realTimer struct{ timer *time.Timer }

func (t realTimer) Chan() <-chan time.Time { return t.timer.C }
func (t realTimer) Stop() bool             { return t.timer.Stop() }

var _ Clock = Real{}

func (Real) Now() time.Time                           { return time.Now() }
func (Real) NewTimer(d time.Duration) Timer           { return realTimer{time.NewTimer(d)} }
func (r Real) After(d time.Duration) <-chan time.Time { return r.NewTimer(d).Chan() }

// Sleep 可取消，退出时释放尚未到期的计时器。
func (r Real) Sleep(ctx context.Context, d time.Duration) error {
	return sleep(ctx, r, d)
}

func sleep(ctx context.Context, clk Clock, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	timer := clk.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.Chan():
		return nil
	}
}

// TaskGroup 登记框架任务。零值可用；Wait 等待任务全部完成，包含任务执行期间
// 登记的子任务。常驻计时器也是任务，调用 Wait 前应先停止对应作用域。
// 并发 Go 与 Wait 以内部锁线性化：Wait 观察到零任务之后登记的任务属于下一轮。
type TaskGroup struct {
	mu      sync.Mutex
	pending int
	changed chan struct{}
	handler func(v any)
	panics  []error
}

func (g *TaskGroup) SetPanicHandler(fn func(v any)) {
	g.mu.Lock()
	g.handler = fn
	g.mu.Unlock()
}

// Go 登记后启动任务。任务及 panic 处理器抛出的 panic 均不会逃出任务边界。
func (g *TaskGroup) Go(fn func()) {
	g.mu.Lock()
	g.pending++
	if g.changed == nil {
		g.changed = make(chan struct{})
	}
	handler := g.handler
	g.mu.Unlock()
	go func() {
		defer func() {
			g.mu.Lock()
			g.pending--
			close(g.changed)
			g.changed = make(chan struct{})
			g.mu.Unlock()
		}()
		defer func() {
			if v := recover(); v != nil {
				g.handlePanic(handler, v)
			}
		}()
		fn()
	}()
}

func (g *TaskGroup) handlePanic(handler func(any), value any) {
	if handler == nil {
		g.recordPanic(value)
		return
	}
	defer func() {
		if v := recover(); v != nil {
			g.recordPanic(fmt.Errorf("panic 处理器失败：%v；原始 panic：%v", v, value))
		}
	}()
	handler(value)
}

func (g *TaskGroup) recordPanic(value any) {
	g.mu.Lock()
	g.panics = append(g.panics, fmt.Errorf("任务发生 panic: %v", value))
	g.mu.Unlock()
}

// Wait 等待所有任务完成，取消只结束本次等待，不产生辅助 goroutine。
// 未交给处理器的 panic 作为聚合错误返回；并发和重复等待观察同一错误历史。
func (g *TaskGroup) Wait(ctx context.Context) error {
	for {
		g.mu.Lock()
		if g.pending == 0 {
			err := errors.Join(g.panics...)
			g.mu.Unlock()
			return err
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

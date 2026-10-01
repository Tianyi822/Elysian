package docker

import (
	"context"
	"net/url"
	"sync"

	"elysian/server/internal/seam"
)

// 测试替身：可编程的 Engine 传输器（对应 TS createRecordingTransport）与手动时钟。

// engineCall 一次被录制的 Engine 调用。
type engineCall struct {
	Method string
	Path   string
	Query  url.Values
	Body   string
}

// engineScript 按方法+路径应答（返回状态码与 JSON 正文；ok=false 表示未录制）。
type engineScript func(call engineCall) (status int, body string, ok bool)

// fakeEngine seam.DockerTransport 的测试替身。
type fakeEngine struct {
	mu        sync.Mutex
	calls     []engineCall
	script    engineScript
	streamFn  func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error)
	streamErr error
}

func newFakeEngine(script engineScript) *fakeEngine {
	return &fakeEngine{script: script}
}

// Requests 返回已录制的调用快照。
func (f *fakeEngine) Requests() []engineCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]engineCall(nil), f.calls...)
}

// Request 按脚本应答。
func (f *fakeEngine) Request(_ context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	call := engineCall{Method: req.Method, Path: req.Path, Query: req.Query, Body: string(req.Body)}
	f.mu.Lock()
	f.calls = append(f.calls, call)
	script := f.script
	f.mu.Unlock()
	status, body, ok := script(call)
	if !ok {
		return seam.EngineResponse{}, &unscriptedError{call: call}
	}
	return seam.EngineResponse{Status: status, Body: []byte(body)}, nil
}

// Stream 默认阻塞到 ctx 取消；可注入 streamFn 定制（events 流测试用）。
func (f *fakeEngine) Stream(ctx context.Context, req seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	call := engineCall{Method: req.Method, Path: req.Path, Query: req.Query, Body: string(req.Body)}
	f.mu.Lock()
	f.calls = append(f.calls, call)
	streamFn := f.streamFn
	script := f.script
	f.mu.Unlock()
	if streamFn != nil {
		return streamFn(ctx, call, onChunk)
	}
	// 缺省：脚本有应答则立即返回（拉取类测试）；未录制则阻塞到取消（events 长流）。
	status, body, ok := script(call)
	if ok {
		return seam.EngineResponse{Status: status, Body: []byte(body)}, nil
	}
	<-ctx.Done()
	return seam.EngineResponse{}, ctx.Err()
}

type unscriptedError struct{ call engineCall }

func (e *unscriptedError) Error() string {
	return "未录制的请求：" + e.call.Method + " " + e.call.Path
}

// requestPathWithQuery 还原完整路径（带查询串）便于断言。
func requestPathWithQuery(call engineCall) string {
	if len(call.Query) == 0 {
		return call.Path
	}
	return call.Path + "?" + call.Query.Encode()
}

// manualClock 手动时钟：schedule 注册的事件按虚拟时间推进触发。
type manualClock struct {
	mu     sync.Mutex
	nowMs  int64
	timers []*manualTimer
}

type manualTimer struct {
	atMs     int64
	fn       func()
	canceled bool
}

func newManualClock() *manualClock { return &manualClock{} }

// Now 返回虚拟当前时间。
func (c *manualClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nowMs
}

// Schedule 注册延时事件。
func (c *manualClock) Schedule(fn func(), ms int64) func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &manualTimer{atMs: c.nowMs + ms, fn: fn}
	c.timers = append(c.timers, timer)
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		timer.canceled = true
	}
}

// Advance 推进虚拟时间并按序触发到期事件。
func (c *manualClock) Advance(ms int64) {
	for {
		c.mu.Lock()
		var next *manualTimer
		for _, timer := range c.timers {
			if timer.canceled || timer.atMs > c.nowMs+ms {
				continue
			}
			if next == nil || timer.atMs < next.atMs {
				next = timer
			}
		}
		if next == nil {
			c.nowMs += ms
			// 清理已取消定时器，防长期累积。
			kept := c.timers[:0]
			for _, timer := range c.timers {
				if !timer.canceled {
					kept = append(kept, timer)
				}
			}
			c.timers = kept
			c.mu.Unlock()
			return
		}
		fireAt := next.atMs
		next.canceled = true
		c.nowMs = fireAt
		c.mu.Unlock()
		next.fn()
	}
}

// captureSubscriber 订阅回调记录器。
type captureSubscriber struct {
	mu     sync.Mutex
	events []string // "event:<name>:<id>" 或 "status:<live|connecting>"
	frames []hubFrame
}

func (c *captureSubscriber) onEvent(event, id, data string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "event:"+event+":"+id)
	c.frames = append(c.frames, hubFrame{event: event, id: id, data: data})
}

func (c *captureSubscriber) onStatus(status string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "status:"+status)
}

func (c *captureSubscriber) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.events...)
}

func (c *captureSubscriber) frameCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.frames)
}

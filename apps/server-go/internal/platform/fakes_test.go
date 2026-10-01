package platform

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/seam"
)

// 测试假件：fake 注入锁行为与文案（对齐 TS vitest 假件先例），不起真实引擎、不碰
// 宿主已有 socket；真实拨号路径由 realDialTransport 走不存在的路径/普通文件模拟。

// fakeTransport 记录请求形状的引擎传输器假件。
type fakeTransport struct {
	mu        sync.Mutex
	requests  []seam.EngineRequest
	streams   []seam.EngineRequest
	requestFn func(req seam.EngineRequest) (seam.EngineResponse, error)
	streamFn  func(req seam.EngineRequest) (seam.EngineResponse, error)
}

func (t *fakeTransport) Request(_ context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	t.mu.Lock()
	t.requests = append(t.requests, req)
	t.mu.Unlock()
	if t.requestFn != nil {
		return t.requestFn(req)
	}
	return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{}`)}, nil
}

func (t *fakeTransport) Stream(_ context.Context, req seam.EngineRequest, _ func([]byte)) (seam.EngineResponse, error) {
	t.mu.Lock()
	t.streams = append(t.streams, req)
	t.mu.Unlock()
	if t.streamFn != nil {
		return t.streamFn(req)
	}
	return seam.EngineResponse{Status: http.StatusOK, Body: nil}, nil
}

func (t *fakeTransport) requestCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.requests)
}

func (t *fakeTransport) hasDeleteCall() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, req := range t.requests {
		if req.Method == http.MethodDelete {
			return true
		}
	}
	return false
}

// fakeTransportFactory 恒回同一假件的工厂。
type fakeTransportFactory struct{ transport seam.DockerTransport }

func (f fakeTransportFactory) New(string) seam.DockerTransport { return f.transport }

// fakeCaddyAdmin 记录调用次数的通道假件；configErr 非空时按它失败。
type fakeCaddyAdmin struct {
	mu        sync.Mutex
	calls     int
	configErr *seam.CaddyChannelError
}

func (c *fakeCaddyAdmin) CurrentConfig(context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	c.mu.Lock()
	c.calls++
	err := c.configErr
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return json.RawMessage(`{}`), nil
}

func (c *fakeCaddyAdmin) Load(context.Context, []byte) *seam.CaddyChannelError { return nil }

func (c *fakeCaddyAdmin) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// fakeCaddyFactory 恒回同一假通道的工厂。
type fakeCaddyFactory struct{ admin seam.CaddyAdmin }

func (f fakeCaddyFactory) New(string) seam.CaddyAdmin { return f.admin }

// fakeHostRunner 记录脚本的宿主执行器假件；runFn 缺省回已完成。
type fakeHostRunner struct {
	mu      sync.Mutex
	scripts []string
	runFn   func(script string, timeout time.Duration) (hostCommandResult, error)
}

func (h *fakeHostRunner) run(script string, timeout time.Duration) (hostCommandResult, error) {
	h.mu.Lock()
	h.scripts = append(h.scripts, script)
	h.mu.Unlock()
	if h.runFn != nil {
		return h.runFn(script, timeout)
	}
	return hostCommandResult{Code: 0, Output: "ELYSIAN_DONE\n"}, nil
}

func (h *fakeHostRunner) scriptCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.scripts)
}

// fakeProber 计数的探测假件。
type fakeProber struct {
	mu     sync.Mutex
	calls  int
	report dependencyProbeReport
}

func (p *fakeProber) Probe() dependencyProbeReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	return p.report
}

func (p *fakeProber) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

// fakeSetup 记录调用的安装编排假件。
type fakeSetup struct {
	mu    sync.Mutex
	calls []string
	runFn func(target, step string) setupResult
}

func (s *fakeSetup) Run(target, step string) setupResult {
	s.mu.Lock()
	s.calls = append(s.calls, target+":"+step)
	s.mu.Unlock()
	if s.runFn != nil {
		return s.runFn(target, step)
	}
	return setupResult{OK: true, Message: "已完成"}
}

func (s *fakeSetup) callSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

// fakeClock 可拨动的时钟（限流窗口确定性测试）。
type fakeClock struct {
	mu      sync.Mutex
	current time.Time
}

func newFakeClock(start time.Time) *fakeClock { return &fakeClock{current: start} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.current = c.current.Add(d)
}

// errnoError 带 errno 的错误（模拟真实拨号错误链，errors.As 可解出 syscall.Errno）。
type errnoError struct {
	errno syscall.Errno
	msg   string
}

func (e *errnoError) Error() string { return e.msg }
func (e *errnoError) Unwrap() error { return e.errno }

// realDialTransport 测试专用的真实 unix 拨号传输器（等价 docker 域传输层的手写版，
// 不 import 其它域）。请求路径按 seam 约定原样使用。拨号前先 stat：路径不存在报
// ENOENT、存在但非 socket 报 ENOTSOCK——复刻 TS 版「env 覆盖即模拟」依赖的运行时
// 行为（macOS 内核对普通文件 connect 返回 ENOTSOCK；Linux 内核返回 ECONNREFUSED，
// stat-first 让模拟在两个平台一致落进盘点记载的 errno 桶）。
type realDialTransport struct{ socketPath string }

// dialErrno 拨号前的模拟判定。
func (t realDialTransport) dialErrno() error {
	info, err := os.Stat(t.socketPath)
	if err != nil {
		var pathErr *os.PathError
		if errors.As(err, &pathErr) {
			return pathErr
		}
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return &os.PathError{Op: "dial", Path: t.socketPath, Err: syscall.ENOTSOCK}
	}
	return nil
}

func (t realDialTransport) Request(ctx context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	if err := t.dialErrno(); err != nil {
		return seam.EngineResponse{}, err
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", t.socketPath)
		},
	}}
	httpReq, err := http.NewRequestWithContext(rctx, req.Method, "http://localhost"+req.Path, nil)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	defer resp.Body.Close()
	max := req.MaxBytes
	if max <= 0 {
		max = 4 * 1024 * 1024
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max))
	if err != nil {
		return seam.EngineResponse{}, err
	}
	return seam.EngineResponse{Status: resp.StatusCode, Body: data}, nil
}

func (t realDialTransport) Stream(ctx context.Context, req seam.EngineRequest, _ func([]byte)) (seam.EngineResponse, error) {
	return t.Request(ctx, req)
}

// newTestDialProber 用真实拨号传输器构造探针。
func newTestDialProber(dockerSocket string) prober {
	return prober{
		createTransport: func(socketPath string) seam.DockerTransport {
			return realDialTransport{socketPath: socketPath}
		},
		createCaddy:  func(string) seam.CaddyAdmin { return &fakeCaddyAdmin{} },
		dockerSocket: dockerSocket,
	}
}

// doRequest 向路由器发一次请求并回记录器；headers 的 "Host" 特殊处理为 req.Host
// （Go 的 Host 不走 Header 表，与 TS 读 host 头等价）。
func doRequest(t *testing.T, router chi.Router, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for key, value := range headers {
		if key == "Host" {
			req.Host = value
			continue
		}
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// assertJSONEqual 断言响应体逐字节一致。
func assertJSONEqual(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	if got := rec.Body.String(); got != want {
		t.Fatalf("响应体不符：\n got %s\nwant %s", got, want)
	}
}

// base64Encode 测试用的标准 base64 编码。
func base64Encode(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

// assertStatus 断言状态码。
func assertStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("状态码不符：got %d want %d（body %q）", rec.Code, want, rec.Body.String())
	}
}

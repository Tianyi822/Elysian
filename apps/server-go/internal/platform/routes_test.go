package platform

import (
	"net/http"
	"testing"
	"time"
)

// 平台内存路由对等测试（platformMemoryRoutes.test.ts）：
// 注入读数 → 200 MB 换算；非 GET（含 HEAD）405「只允许 GET」。

func TestMemoryRouteGet(t *testing.T) {
	router := NewRouter(Deps{
		readUsage: func() memoryUsage {
			return memoryUsage{RSS: 80 * 1024 * 1024, HeapUsed: 40 * 1024 * 1024, HeapTotal: 50 * 1024 * 1024}
		},
	})
	rec := doRequest(t, router, http.MethodGet, "/memory", nil)
	assertStatus(t, rec, http.StatusOK)
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type 不符：%q", ct)
	}
	assertJSONEqual(t, rec, `{"rssMb":80,"heapUsedMb":40,"heapTotalMb":50}`)
}

func TestMemoryRouteRejectsNonGet(t *testing.T) {
	router := NewRouter(Deps{readUsage: func() memoryUsage { return memoryUsage{1, 1, 1} }})
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut, http.MethodDelete} {
		rec := doRequest(t, router, method, "/memory", nil)
		assertStatus(t, rec, http.StatusMethodNotAllowed)
		assertJSONEqual(t, rec, `{"error":"只允许 GET"}`)
	}
}

// 依赖检测路由对等测试（platformDependencies.test.ts 路由段）：GET 200 no-store、
// 每请求现场探测一次；非 GET 405 不触发探测；固定窗口限流 429 + retry-after ≥1 +
// 窗口滚动恢复；405 不占限额。

func okReport() dependencyProbeReport {
	return dependencyProbeReport{
		Docker: dependencyProbe{State: probeStateOK},
		Caddy:  dependencyProbe{State: probeStateOK},
	}
}

func TestDependenciesRouteGet(t *testing.T) {
	proberSrv := &fakeProber{report: okReport()}
	router := NewRouter(Deps{prober: proberSrv})
	rec := doRequest(t, router, http.MethodGet, "/dependencies", nil)
	assertStatus(t, rec, http.StatusOK)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control 不符：%q", cc)
	}
	assertJSONEqual(t, rec, `{"docker":{"state":"ok","detail":null},"caddy":{"state":"ok","detail":null}}`)
	doRequest(t, router, http.MethodGet, "/dependencies", nil)
	if got := proberSrv.callCount(); got != 2 {
		t.Fatalf("探测应每请求现场调用一次：got %d want 2", got)
	}
}

func TestDependenciesRouteRejectsNonGet(t *testing.T) {
	proberSrv := &fakeProber{report: okReport()}
	router := NewRouter(Deps{prober: proberSrv})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := doRequest(t, router, method, "/dependencies", nil)
		assertStatus(t, rec, http.StatusMethodNotAllowed)
		assertJSONEqual(t, rec, `{"error":"只允许 GET"}`)
	}
	if got := proberSrv.callCount(); got != 0 {
		t.Fatalf("405 不应触发探测：got %d", got)
	}
}

func TestDependenciesRouteRateLimit(t *testing.T) {
	proberSrv := &fakeProber{report: okReport()}
	clock := newFakeClock(time.Unix(1_700_000_000, 0))
	router := NewRouter(Deps{prober: proberSrv, Now: clock.Now, probeLimit: 2, rateWindow: 60 * time.Millisecond})
	for i := 0; i < 2; i++ {
		assertStatus(t, doRequest(t, router, http.MethodGet, "/dependencies", nil), http.StatusOK)
	}
	limited := doRequest(t, router, http.MethodGet, "/dependencies", nil)
	assertStatus(t, limited, http.StatusTooManyRequests)
	assertJSONEqual(t, limited, `{"error":"依赖检测请求过于频繁，请稍后再试"}`)
	if retryAfter := limited.Header().Get("Retry-After"); retryAfter == "" || retryAfter == "0" {
		t.Fatalf("Retry-After 应 ≥ 1：got %q", retryAfter)
	}
	if got := proberSrv.callCount(); got != 2 {
		t.Fatalf("超限请求不应触发探测：got %d want 2", got)
	}
	clock.Advance(70 * time.Millisecond)
	assertStatus(t, doRequest(t, router, http.MethodGet, "/dependencies", nil), http.StatusOK)
	if got := proberSrv.callCount(); got != 3 {
		t.Fatalf("窗口滚动后应恢复：got %d want 3", got)
	}
}

func TestDependenciesRoute405DoesNotConsumeLimit(t *testing.T) {
	proberSrv := &fakeProber{report: okReport()}
	router := NewRouter(Deps{prober: proberSrv, probeLimit: 1})
	for i := 0; i < 5; i++ {
		rec := doRequest(t, router, http.MethodPost, "/dependencies", nil)
		assertStatus(t, rec, http.StatusMethodNotAllowed)
	}
	assertStatus(t, doRequest(t, router, http.MethodGet, "/dependencies", nil), http.StatusOK)
	if got := proberSrv.callCount(); got != 1 {
		t.Fatalf("405 不占限额：got %d want 1", got)
	}
}

func TestDependenciesRouteRetryAfterValue(t *testing.T) {
	proberSrv := &fakeProber{report: okReport()}
	clock := newFakeClock(time.Unix(1_700_000_000, 0))
	router := NewRouter(Deps{prober: proberSrv, Now: clock.Now, probeLimit: 1, rateWindow: 30 * time.Second})
	assertStatus(t, doRequest(t, router, http.MethodGet, "/dependencies", nil), http.StatusOK)
	clock.Advance(10 * time.Second)
	limited := doRequest(t, router, http.MethodGet, "/dependencies", nil)
	assertStatus(t, limited, http.StatusTooManyRequests)
	// 剩余 20s → ceil(20) = 20（逐字对齐 max(1, ceil((start+window-now)/1000))）。
	if got := limited.Header().Get("Retry-After"); got != "20" {
		t.Fatalf("Retry-After 应为 20：got %q", got)
	}
}

// 安装步骤路由对等测试（dependencySetup.test.ts 路由段）：同源 POST 返回结果；跨源/
// 缺 Origin 403 不执行；非法步骤 400；失败 422；探测路径不受影响。

const (
	testHost   = "127.0.0.1:48101"
	testOrigin = "http://127.0.0.1:48101"
)

func TestSetupRouteSameOriginSuccess(t *testing.T) {
	setupSrv := &fakeSetup{}
	router := NewRouter(Deps{setup: setupSrv})
	rec := doRequest(t, router, http.MethodPost, "/dependencies/setup/caddy/install", map[string]string{
		"Host":   testHost,
		"Origin": testOrigin,
	})
	assertStatus(t, rec, http.StatusOK)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control 不符：%q", cc)
	}
	assertJSONEqual(t, rec, `{"ok":true,"message":"已完成"}`)
	if calls := setupSrv.callSnapshot(); len(calls) != 1 || calls[0] != "caddy:install" {
		t.Fatalf("调用不符：%v", calls)
	}
}

func TestSetupRouteCrossOriginDenied(t *testing.T) {
	setupSrv := &fakeSetup{}
	router := NewRouter(Deps{setup: setupSrv})
	rec := doRequest(t, router, http.MethodPost, "/dependencies/setup/caddy/configure", map[string]string{
		"Host":   testHost,
		"Origin": "http://evil.example",
	})
	assertStatus(t, rec, http.StatusForbidden)
	assertJSONEqual(t, rec, `{"error":"请求来源不允许"}`)

	missing := doRequest(t, router, http.MethodPost, "/dependencies/setup/docker/install", map[string]string{
		"Host": testHost,
	})
	assertStatus(t, missing, http.StatusForbidden)
	assertJSONEqual(t, missing, `{"error":"请求来源不允许"}`)

	if calls := setupSrv.callSnapshot(); len(calls) != 0 {
		t.Fatalf("跨源请求不应执行安装：%v", calls)
	}
}

func TestSetupRouteInvalidStep(t *testing.T) {
	setupSrv := &fakeSetup{}
	router := NewRouter(Deps{setup: setupSrv})
	rec := doRequest(t, router, http.MethodPost, "/dependencies/setup/docker/configure", map[string]string{
		"Host":   testHost,
		"Origin": testOrigin,
	})
	assertStatus(t, rec, http.StatusBadRequest)
	assertJSONEqual(t, rec, `{"error":"安装步骤无效"}`)
	if calls := setupSrv.callSnapshot(); len(calls) != 0 {
		t.Fatalf("非法步骤不应执行安装：%v", calls)
	}
}

func TestSetupRouteFailure422(t *testing.T) {
	setupSrv := &fakeSetup{runFn: func(_, step string) setupResult {
		if step == "enable" {
			return setupResult{OK: false, Message: "这一步没有完成"}
		}
		return setupResult{OK: true, Message: "已完成"}
	}}
	router := NewRouter(Deps{setup: setupSrv})
	rec := doRequest(t, router, http.MethodPost, "/dependencies/setup/caddy/enable", map[string]string{
		"Host":   testHost,
		"Origin": testOrigin,
	})
	assertStatus(t, rec, http.StatusUnprocessableEntity)
	assertJSONEqual(t, rec, `{"error":"这一步没有完成"}`)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("422 也应带 no-store：%q", cc)
	}
}

func TestSetupRouteWrongMethodFallsTo404(t *testing.T) {
	router := NewRouter(Deps{})
	// Hono 无自动 405：setup 路径的 GET/PUT 落缺省 404（纯文本）。
	rec := doRequest(t, router, http.MethodGet, "/dependencies/setup/docker/install", nil)
	assertStatus(t, rec, http.StatusNotFound)
	rec = doRequest(t, router, http.MethodPut, "/dependencies/setup/caddy/enable", nil)
	assertStatus(t, rec, http.StatusNotFound)
}

func TestUnknownPathFallsTo404(t *testing.T) {
	router := NewRouter(Deps{})
	rec := doRequest(t, router, http.MethodGet, "/nothing-here", nil)
	assertStatus(t, rec, http.StatusNotFound)
	if ct := rec.Header().Get("Content-Type"); ct == "application/json; charset=utf-8" {
		t.Fatalf("未匹配路径应落纯文本 404（对齐 Hono 缺省 404），got %q", ct)
	}
	if rec.Body.String() != "404 Not Found\n" {
		t.Fatalf("404 正文不符：%q", rec.Body.String())
	}
}

// 响应体与统一错误形状约定（guard.ts sendJson/sendError 等价物的接线锚点）。
func TestErrorBodyShape(t *testing.T) {
	router := NewRouter(Deps{})
	rec := doRequest(t, router, http.MethodPost, "/memory", nil)
	assertJSONEqual(t, rec, `{"error":"只允许 GET"}`)
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type 不符：%q", ct)
	}
}

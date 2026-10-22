package platform

import (
	"net/http"
	"testing"
	"time"
)

// 平台内存路由对等测试（platformMemoryRoutes.test.ts）：
// 注入读数 → 200 MiB 换算与来源；非 GET（含 HEAD）405「只允许 GET」。

func TestMemoryRouteGet(t *testing.T) {
	router := NewRouter(Deps{
		readUsage: testMemoryUsage,
	})
	rec := doRequest(t, router, http.MethodGet, "/memory", nil)
	assertStatus(t, rec, http.StatusOK)
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type 不符：%q", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("内存采样不能被缓存")
	}
	assertJSONEqual(t, rec, `{"rssMb":80,"rssSource":"smaps-rollup","systemTotalMb":1024,"sampledAt":"2026-10-02T06:00:00Z","heapUsedMb":40,"heapTotalMb":50,"heapUnusedMb":1,"heapRetainedMb":3,"heapReleasedMb":6,"runtimeOtherMb":5,"heapLiveMb":35,"gcCount":8}`)
}

func TestMemoryRouteRejectsNonGet(t *testing.T) {
	router := NewRouter(Deps{readUsage: testMemoryUsage})
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut, http.MethodDelete} {
		rec := doRequest(t, router, method, "/memory", nil)
		assertStatus(t, rec, http.StatusMethodNotAllowed)
		assertJSONEqual(t, rec, `{"error":"只允许 GET"}`)
	}
}

func TestMemoryRouteUnavailableRSS(t *testing.T) {
	router := NewRouter(Deps{readUsage: func() memoryUsage {
		usage := testMemoryUsage()
		usage.RSS, usage.RSSSource = nil, "unavailable"
		return usage
	}})
	rec := doRequest(t, router, http.MethodGet, "/memory", nil)
	assertStatus(t, rec, http.StatusOK)
	assertJSONEqual(t, rec, `{"rssMb":null,"rssSource":"unavailable","systemTotalMb":1024,"sampledAt":"2026-10-02T06:00:00Z","heapUsedMb":40,"heapTotalMb":50,"heapUnusedMb":1,"heapRetainedMb":3,"heapReleasedMb":6,"runtimeOtherMb":5,"heapLiveMb":35,"gcCount":8}`)
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

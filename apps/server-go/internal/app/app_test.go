// Package app 的装配测试：钉住骨架阶段的经手次序与 health 契约。
package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"elysian/server/internal/config"
	"elysian/server/internal/middleware"
)

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	h, err := New(&config.Config{ListenHost: "127.0.0.1"})
	if err != nil {
		t.Fatalf("New 返回错误：%v", err)
	}
	return h
}

func TestHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("状态码 = %d，期望 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q，期望 application/json; charset=utf-8", got)
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Errorf("响应体 = %q，期望 {\"ok\":true}", rec.Body.String())
	}
}

func TestRequestIDOutermost(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Header().Get(middleware.RequestIDHeader) == "" {
		t.Error("最外层应写入 X-Request-Id 响应头")
	}
}

func TestStripTailSlashBeforeRouting(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health/", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("带尾斜杠的 health 应剥斜杠后命中：状态码 = %d，期望 200", rec.Code)
	}
}

func TestGlobalAPINotFoundPlainText(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("状态码 = %d，期望 404", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Errorf("全局 /api 404 应为纯文本，Content-Type = %q", got)
	}
}

func TestSPAPlaceholder(t *testing.T) {
	// 占位 dist 只有 .gitkeep、没有 index.html：非 /api 路径如实 404（纯文本），
	// 待发布构建拷入真实 dist 后回落 index.html。
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/dashboard", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("状态码 = %d，期望 404", rec.Code)
	}
}

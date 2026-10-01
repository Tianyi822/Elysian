package logs

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// newLogsApp 与装配同构的父应用：StripTailSlash + 挂载日志片（尾部斜杠语义由全局
// 中间件承担，对齐 Hono strict:false）。
func newLogsApp(svc seam.Logs) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(shared.LogsMount, NewRouter(Deps{Service: svc}))
	return parent
}

// newTestRouterService 真实服务 + 内存 store + 固定时钟。
func newTestRouterService() (*Service, *fakeStore) {
	store := newFakeStore()
	store.storageFixture = LogStorageStats{TotalBytes: 3072, RuntimeBytes: 2048, OperationBytes: 1024, RuntimeRowCount: 1, OperationRowCount: 0, RowCount: 1}
	store.storageFixture.OldestAt = nil
	svc := NewService(store, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), nil)
	return svc, store
}

// doRequest 执行请求并回响应。
func doRequest(t *testing.T, app http.Handler, method, target, body, contentType, origin string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Host = "localhost:5173"
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

// jsonBodyOf 解析 JSON 响应体。
func jsonBodyOf(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("响应不是 JSON 对象：%v（%s）", err, rec.Body.String())
	}
	return parsed
}

// errorOf 取 {"error": "..."}。
func errorOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	body := jsonBodyOf(t, rec)
	msg, _ := body["error"].(string)
	return msg
}

// 清空路由由可清空类别推导：恰好两条 POST；越界类别落 404（logsRoutes.test.ts ①⑨）。
func TestRouterClearRoutesDerivedFromClearableCategories(t *testing.T) {
	svc, _ := newTestRouterService()
	app := newLogsApp(svc)

	for _, category := range logClearableCategories {
		rec := doRequest(t, app, http.MethodPost, shared.LogsMount+"/"+category+"/clear", "{}", "application/json", "http://localhost:5173")
		if rec.Code != http.StatusOK {
			t.Errorf("POST /%s/clear = %d（%s）", category, rec.Code, rec.Body.String())
		}
	}
	rec := doRequest(t, app, http.MethodPost, shared.LogsMount+"/database/clear", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusNotFound {
		t.Errorf("越界类别应 404：%d", rec.Code)
	}
	if msg := errorOf(t, rec); msg != "未知日志端点：POST /database/clear" {
		t.Errorf("404 文案不符：%q", msg)
	}
}

// 三读端点透传报告形状 + cache-control: no-store（logsRoutes.test.ts ③）。
func TestRouterReadEndpointsReportShape(t *testing.T) {
	svc, _ := newTestRouterService()
	svc.Log("info", "server.lifecycle", "面板启动")
	app := newLogsApp(svc)

	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime", "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /runtime = %d：%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("cache-control = %q, want no-store", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q", got)
	}
	body := jsonBodyOf(t, rec)
	for _, key := range []string{"entries", "total", "truncated", "skippedLines", "skippedFiles", "storage"} {
		if _, ok := body[key]; !ok {
			t.Errorf("runtime 报告缺键 %q：%v", key, body)
		}
	}
	storage := body["storage"].(map[string]any)
	for _, key := range []string{"totalBytes", "runtimeBytes", "operationBytes", "runtimeRowCount", "operationRowCount", "rowCount", "oldestAt", "lastSweepAt", "trimmedBySize", "droppedRecords", "failedWrites"} {
		if _, ok := storage[key]; !ok {
			t.Errorf("storage 缺键 %q", key)
		}
	}

	// 键序与 TS 声明序一致（JSON 文本前缀逐字比对）。
	if !strings.HasPrefix(rec.Body.String(), `{"entries":[{"id":"1","at":"2026-09-23T00:00:02.000Z","level":"info","source":"server.lifecycle","message":"面板启动"}`) {
		t.Errorf("runtime 报告键序/内容不符：%s", rec.Body.String())
	}

	// 登录报告无 storage 键。
	svc.RecordLogin(LoginRecord{IP: "127.0.0.1", UserAgent: "UA", Status: "success"})
	rec = doRequest(t, app, http.MethodGet, shared.LogsMount+"/login", "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /login = %d", rec.Code)
	}
	loginBody := jsonBodyOf(t, rec)
	if _, has := loginBody["storage"]; has {
		t.Errorf("登录报告不应有 storage 键")
	}
	if !strings.Contains(rec.Body.String(), `"time":"2026-09-23T00:00:02.000Z"`) {
		t.Errorf("登录条目应有 time 字段：%s", rec.Body.String())
	}

	// 尾部斜杠经全局剥斜杠中间件命中（Hono strict:false 语义）。
	rec = doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime/", "", "", "")
	if rec.Code != http.StatusOK {
		t.Errorf("GET /runtime/ 应命中：%d", rec.Code)
	}
}

// GET /operation 把解析后筛选传给 service（logsRoutes.test.ts ②）。
func TestRouterOperationFiltersParsed(t *testing.T) {
	svc, store := newTestRouterService()
	app := newLogsApp(svc)
	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/operation?q=error&limit=5&category=containers&result=failure", "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /operation = %d：%s", rec.Code, rec.Body.String())
	}
	got := store.lastOperationQuery
	if got == nil || got.Q != "error" || got.Limit != 5 || got.Category != "containers" || got.Result != "failure" {
		t.Errorf("筛选未传到 service：%+v", got)
	}
}

// 查询参数 400 文案经路由原样回显。
func TestRouterQueryInvalid400(t *testing.T) {
	svc, _ := newTestRouterService()
	app := newLogsApp(svc)
	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime?limit=0", "", "", "")
	if rec.Code != http.StatusBadRequest || errorOf(t, rec) != "limit 无效：应为 1 到 1000 的整数" {
		t.Errorf("limit 400 不符：%d %q", rec.Code, errorOf(t, rec))
	}
	rec = doRequest(t, app, http.MethodGet, shared.LogsMount+"/operation?category=nope", "", "", "")
	if rec.Code != http.StatusBadRequest || errorOf(t, rec) != "操作日志分类无效：nope" {
		t.Errorf("category 400 不符：%d %q", rec.Code, errorOf(t, rec))
	}
	rec = doRequest(t, app, http.MethodGet, shared.LogsMount+"/login?status=maybe", "", "", "")
	if rec.Code != http.StatusBadRequest || errorOf(t, rec) != "登录状态无效：maybe" {
		t.Errorf("status 400 不符：%d %q", rec.Code, errorOf(t, rec))
	}
}

// 跨源 GET 照常 200；清空空对象体 200 回 cleared（logsRoutes.test.ts ④⑤）。
func TestRouterSameOriginBehavior(t *testing.T) {
	svc, store := newTestRouterService()
	app := newLogsApp(svc)

	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime", "", "", "http://evil.example")
	if rec.Code != http.StatusOK {
		t.Errorf("跨源 GET 应照常 200：%d", rec.Code)
	}

	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusOK {
		t.Fatalf("空对象体清空应 200：%d（%s）", rec.Code, rec.Body.String())
	}
	body := jsonBodyOf(t, rec)
	cleared, ok := body["cleared"].(map[string]any)
	if !ok {
		t.Fatalf("响应应含 cleared：%v", body)
	}
	for _, key := range []string{"category", "rowCount", "totalBytes", "oldestAt", "clearedAt"} {
		if _, has := cleared[key]; !has {
			t.Errorf("cleared 缺键 %q", key)
		}
	}
	if cleared["category"] != "runtime" {
		t.Errorf("category 应为 runtime：%v", cleared["category"])
	}
	if len(store.clearCalls) != 1 || store.clearCalls[0] != categoryRuntime {
		t.Errorf("clear 未下传：%v", store.clearCalls)
	}
}

// 跨源清空 403 在读体之前（无 content-type 也先 403）、cleared 为空（⑥）。
func TestRouterCrossOriginClearRejectedBeforeBody(t *testing.T) {
	svc, store := newTestRouterService()
	app := newLogsApp(svc)
	rec := doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "not-json", "", "http://evil.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源清空应 403：%d", rec.Code)
	}
	if msg := errorOf(t, rec); msg != "请求来源不允许" {
		t.Errorf("403 文案不符：%q", msg)
	}
	if len(store.clearCalls) != 0 {
		t.Errorf("cleared 应为空：%v", store.clearCalls)
	}
}

// 读体守卫 415/413/400（logsRoutes.test.ts ⑦）。
func TestRouterBodyGuards(t *testing.T) {
	svc, _ := newTestRouterService()
	app := newLogsApp(svc)
	sameOrigin := "http://localhost:5173"

	rec := doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "{}", "text/plain", sameOrigin)
	if rec.Code != http.StatusUnsupportedMediaType || errorOf(t, rec) != "Content-Type 必须为 application/json" {
		t.Errorf("415 不符：%d %q", rec.Code, errorOf(t, rec))
	}

	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/operation/clear", "{oops", "application/json", sameOrigin)
	if rec.Code != http.StatusBadRequest || errorOf(t, rec) != "请求体不是有效 JSON" {
		t.Errorf("坏 JSON 400 不符：%d %q", rec.Code, errorOf(t, rec))
	}

	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "   ", "application/json", sameOrigin)
	if rec.Code != http.StatusBadRequest || errorOf(t, rec) != "请求体不能为空" {
		t.Errorf("空体 400 不符：%d %q", rec.Code, errorOf(t, rec))
	}

	big := `{"pad":"` + strings.Repeat("x", 64*1024) + `"}`
	req := httptest.NewRequest(http.MethodPost, shared.LogsMount+"/runtime/clear", bytes.NewReader([]byte(big)))
	req.Host = "localhost:5173"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", sameOrigin)
	req.Header.Set("Content-Length", "999999") // 申报超限先拒
	rw := httptest.NewRecorder()
	app.ServeHTTP(rw, req)
	if rw.Code != http.StatusRequestEntityTooLarge || errorOf(t, rw) != "请求体过大" {
		t.Errorf("申报 413 不符：%d %q", rw.Code, errorOf(t, rw))
	}

	// 实读累计超限（申报正常）。
	honest := `{"pad":"` + strings.Repeat("x", 65*1024) + `"}`
	req = httptest.NewRequest(http.MethodPost, shared.LogsMount+"/runtime/clear", bytes.NewReader([]byte(honest)))
	req.Host = "localhost:5173"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", sameOrigin)
	req.ContentLength = int64(len(honest))
	rw = httptest.NewRecorder()
	app.ServeHTTP(rw, req)
	if rw.Code != http.StatusRequestEntityTooLarge || errorOf(t, rw) != "请求体过大" {
		t.Errorf("实读 413 不符：%d %q", rw.Code, errorOf(t, rw))
	}
}

// 404 文案剥前缀、空归一 /；未知写路径先 403 后 404（logsRoutes.test.ts ⑧⑩）。
func TestRouterFallback404(t *testing.T) {
	svc, _ := newTestRouterService()
	app := newLogsApp(svc)

	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/nowhere", "", "", "")
	if rec.Code != http.StatusNotFound || errorOf(t, rec) != "未知日志端点：GET /nowhere" {
		t.Errorf("404 文案不符：%d %q", rec.Code, errorOf(t, rec))
	}

	// 方法不符（已知路径、错误方法）同样落 404 JSON（Hono app.all 语义）。
	rec = doRequest(t, app, http.MethodPut, shared.LogsMount+"/runtime", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusNotFound || errorOf(t, rec) != "未知日志端点：PUT /runtime" {
		t.Errorf("方法不符 404 文案不符：%d %q", rec.Code, errorOf(t, rec))
	}

	// 挂载根：空相对路径归一 /。
	rec = doRequest(t, app, http.MethodPost, shared.LogsMount, "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusNotFound || errorOf(t, rec) != "未知日志端点：POST /" {
		t.Errorf("挂载根 404 文案不符：%d %q", rec.Code, errorOf(t, rec))
	}

	// 跨源未知写路径：先 403。
	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/nowhere", "{}", "application/json", "http://evil.example")
	if rec.Code != http.StatusForbidden {
		t.Errorf("跨源未知写路径应先 403：%d", rec.Code)
	}
	// 同源未知写路径：404。
	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/nowhere", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusNotFound || errorOf(t, rec) != "未知日志端点：POST /nowhere" {
		t.Errorf("同源未知写路径应 404：%d %q", rec.Code, errorOf(t, rec))
	}
}

// 本片没有容器边界：读端点不会 503（logsRoutes.test.ts ⑪）。
func TestRouterNever503(t *testing.T) {
	svc, _ := newTestRouterService()
	app := newLogsApp(svc)
	for _, path := range []string{"/runtime", "/operation", "/login"} {
		rec := doRequest(t, app, http.MethodGet, shared.LogsMount+path, "", "", "")
		if rec.Code == http.StatusServiceUnavailable {
			t.Errorf("读端点不应 503：%s", path)
		}
	}
}

// 库不可用：读端点 500「日志数据库不可用」，清空同样 500（unavailable store 接线）。
func TestRouterUnavailableStore500(t *testing.T) {
	svc := NewService(newUnavailableLogStore(), fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), nil)
	app := newLogsApp(svc)
	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime", "", "", "")
	if rec.Code != http.StatusInternalServerError || errorOf(t, rec) != unavailableMessage {
		t.Errorf("不可用 store 读端点应 500：%d %q", rec.Code, errorOf(t, rec))
	}
	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusInternalServerError || errorOf(t, rec) != unavailableMessage {
		t.Errorf("不可用 store 清空应 500：%d %q", rec.Code, errorOf(t, rec))
	}
}

// minimalLogs 只实现 seam.Logs 最小形状（非 OpenService 产物）。
type minimalLogs struct{}

func (minimalLogs) Runtime(level, source, message string)    {}
func (minimalLogs) RecordOperation(rec seam.OperationRecord) {}

// Deps.Service 只实现 seam.Logs 最小形状时端点统一 500「日志数据库不可用」。
func TestRouterDegradesOnNonFullService(t *testing.T) {
	app := newLogsApp(minimalLogs{})
	rec := doRequest(t, app, http.MethodGet, shared.LogsMount+"/runtime", "", "", "")
	if rec.Code != http.StatusInternalServerError || errorOf(t, rec) != unavailableMessage {
		t.Errorf("非完整服务应 500 不可用：%d %q", rec.Code, errorOf(t, rec))
	}
	rec = doRequest(t, app, http.MethodPost, shared.LogsMount+"/runtime/clear", "{}", "application/json", "http://localhost:5173")
	if rec.Code != http.StatusInternalServerError || errorOf(t, rec) != unavailableMessage {
		t.Errorf("非完整服务清空应 500 不可用：%d %q", rec.Code, errorOf(t, rec))
	}
}

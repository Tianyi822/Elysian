// Package app 的装配测试：对齐 TS app.test.ts 的组装冒烟锚点（挂载形态、容器边界
// 文案、日志片无关容器边界），外加装配层特有的接线锚点——审计先于鉴权（401 也落
// failure）、整片 503 不记操作日志、登录-会话-登出最小链路。全部经 newAssembly 以
// 假件注入，不碰真实 ~/.Elysian。
package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/logs"
	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
)

// fakeCredentialsStore 测试凭据：恒无凭据（dev 账号路径不依赖凭据文件）。
type fakeCredentialsStore struct{}

func (fakeCredentialsStore) Current() (*auth.PanelCredentials, error) { return nil, nil }
func (fakeCredentialsStore) Write(string) (*auth.PanelCredentials, error) {
	return nil, nil
}

// fakeLogsService 假日志服务：记录调用、返回固定形状，不碰文件系统。
type fakeLogsService struct {
	mu         sync.Mutex
	operations []seam.OperationRecord
	runtimes   [][3]string // level, source, message
	logins     []logs.LoginRecord
}

func (f *fakeLogsService) Runtime(level, source, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runtimes = append(f.runtimes, [3]string{level, source, message})
}

func (f *fakeLogsService) RecordOperation(rec seam.OperationRecord) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.operations = append(f.operations, rec)
}

// RecordLogin 实现 logs.LoginRecorder（审计中间件类型断言取得）。
func (f *fakeLogsService) RecordLogin(input logs.LoginRecord) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins = append(f.logins, input)
}

func (f *fakeLogsService) snapshot() (ops []seam.OperationRecord, logins []logs.LoginRecord) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]seam.OperationRecord(nil), f.operations...),
		append([]logs.LoginRecord(nil), f.logins...)
}

// newAssemblyHandler 组装测试入口：Enabled 与假件由用例给全，恒 LocalDemo 模式
// （容器门禁域整片 503、docker 不探测 socket）。
func newAssemblyHandler(t *testing.T, appLogs seam.Logs, authDeps auth.Deps) http.Handler {
	t.Helper()
	if authDeps.Sessions == nil {
		authDeps.Sessions = auth.NewMemorySessionStore(nil)
	}
	if authDeps.Credentials == nil {
		authDeps.Credentials = fakeCredentialsStore{}
	}
	handler, err := newAssembly(&config.Config{ListenHost: "127.0.0.1"}, appLogs, authDeps)
	if err != nil {
		t.Fatalf("newAssembly 返回错误：%v", err)
	}
	return handler
}

// newTestHandler 无鉴权演示语义（Enabled=false）的组装：与 TS createApp({auth:{enabled:false}}) 同形。
func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	return newAssemblyHandler(t, &fakeLogsService{}, auth.Deps{Enabled: false})
}

// sameOriginRequest 构造同源写请求（Host 与 Origin 一致且命中允许主机名表）。
func sameOriginRequest(method, target string, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Host = "127.0.0.1:48101"
	r.Header.Set("Origin", "http://127.0.0.1:48101")
	r.Header.Set("Content-Type", "application/json")
	return r
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

func Test平台内存挂载与形状(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platform/memory", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", rec.Code)
	}
	var body map[string]float64
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应体不是 JSON 数字对象：%v（%s）", err, rec.Body.String())
	}
	if len(body) != 3 {
		t.Fatalf("键集 = %v，期望恰好 rssMb/heapUsedMb/heapTotalMb 三键", body)
	}
	for _, key := range []string{"rssMb", "heapUsedMb", "heapTotalMb"} {
		value, ok := body[key]
		if !ok || value < 0 {
			t.Fatalf("键 %s 缺失或非有限非负：%v", key, value)
		}
	}
}

func Test容器门禁域非容器环境整片503文案(t *testing.T) {
	handler := newTestHandler(t)
	// path 与期望文案对（TS app.test.ts 同表）；未知路径与带尾斜杠形同样整片 503。
	expects := [][2]string{
		{"/api/security/ssh/overview", "真实 SSH 管理仅在 Docker 容器内可用"},
		{"/api/security/users", "真实用户管理仅在 Docker 容器内可用"},
		{"/api/security/users/", "真实用户管理仅在 Docker 容器内可用"},
		{"/api/security/users/nowhere", "真实用户管理仅在 Docker 容器内可用"},
		{"/api/security/firewall", "真实防火墙仅在 Docker 容器内可用"},
		{"/api/security/firewall/toggles", "真实防火墙仅在 Docker 容器内可用"},
		{"/api/security/firewall/nowhere", "真实防火墙仅在 Docker 容器内可用"},
		{"/api/docker/containers", "真实容器管理仅在 Docker 容器内可用"},
		{"/api/files/entries?path=%2Fvar%2Flog", "真实文件管理仅在 Docker 容器内可用"},
		{"/api/files/search?keyword=log", "真实文件管理仅在 Docker 容器内可用"},
		{"/api/files/nowhere", "真实文件管理仅在 Docker 容器内可用"},
		{"/api/terminals/status", "真实终端仅在 Docker 容器内可用"},
		{"/api/terminals/ws", "真实终端仅在 Docker 容器内可用"},
		{"/api/terminals/nowhere", "真实终端仅在 Docker 容器内可用"},
		{"/api/databases", "真实数据库仅在 Docker 环境可用"},
		{"/api/websites", "真实网站管理仅在 Docker 环境可用"},
	}
	for _, item := range expects {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, item[0], nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("GET %s 状态码 = %d，期望 503", item[0], rec.Code)
			continue
		}
		if rec.Body.String() != `{"error":"`+item[1]+`"}` {
			t.Errorf("GET %s 响应体 = %q，期望 %q", item[0], rec.Body.String(), `{"error":"`+item[1]+`"}`)
		}
	}
}

func Test日志片无关容器边界读端点与404文案(t *testing.T) {
	// 日志片与容器边界无关：真实打开（临时目录，不碰 ~/.Elysian），读端点照常 200。
	svc := logs.OpenService(filepath.Join(t.TempDir(), "logs.sqlite"), nil)
	handler := newAssemblyHandler(t, svc, auth.Deps{Enabled: false})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/logs/runtime", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/logs/runtime 状态码 = %d，期望 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q，期望 no-store", got)
	}
	var runtimeBody struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &runtimeBody); err != nil {
		t.Fatalf("运行日志响应不是 JSON：%v", err)
	}
	if len(runtimeBody.Entries) != 0 {
		t.Fatalf("空库 entries 应为空：%v", runtimeBody.Entries)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/logs/nowhere", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/logs/nowhere 状态码 = %d，期望 404", rec.Code)
	}
	if rec.Body.String() != `{"error":"未知日志端点：GET /nowhere"}` {
		t.Errorf("响应体 = %q", rec.Body.String())
	}
}

func Test审计先于鉴权401写请求落failure操作日志(t *testing.T) {
	fake := &fakeLogsService{}
	handler := newAssemblyHandler(t, fake, auth.Deps{Enabled: true})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sameOriginRequest(http.MethodPost, "/api/docker/containers", `{"image":"nginx"}`))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401（鉴权先于片内可用性）", rec.Code)
	}
	if rec.Body.String() != `{"error":"未登录或会话已过期"}` {
		t.Fatalf("响应体 = %q", rec.Body.String())
	}
	ops, logins := fake.snapshot()
	if len(ops) != 1 {
		t.Fatalf("操作日志应恰一条（审计先于鉴权、无双重记账）：%+v", ops)
	}
	op := ops[0]
	if op.Category != "containers" || op.Result != "failure" || op.Method != http.MethodPost ||
		op.Path != "/api/docker/containers" || op.HTTPStatus == nil || *op.HTTPStatus != 401 {
		t.Fatalf("操作日志字段：%+v", op)
	}
	if len(logins) != 0 {
		t.Fatalf("非登录端点不应落登录日志：%+v", logins)
	}
}

func Test整片503不记操作日志(t *testing.T) {
	fake := &fakeLogsService{}
	handler := newAssemblyHandler(t, fake, auth.Deps{Enabled: false})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sameOriginRequest(http.MethodPost, "/api/files/copy", `{"from":"/a","to":"/b"}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d，期望 503", rec.Code)
	}
	ops, _ := fake.snapshot()
	if len(ops) != 0 {
		t.Fatalf("整片 503（服务未发生）不应记操作日志：%+v", ops)
	}
}

func Test登录会话登出最小链路(t *testing.T) {
	fake := &fakeLogsService{}
	handler := newAssemblyHandler(t, fake, auth.Deps{Enabled: true, DevAccount: true})

	// 登录失败：错误文案逐字 + failure 操作日志与登录日志各一条。
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sameOriginRequest(http.MethodPost, "/api/auth/login",
		`{"username":"dev","password":"wrong-password"}`))
	if rec.Code != http.StatusUnauthorized || rec.Body.String() != `{"error":"用户名或密码错误"}` {
		t.Fatalf("登录失败响应 = %d %s", rec.Code, rec.Body.String())
	}
	ops, logins := fake.snapshot()
	if len(ops) != 1 || ops[0].Category != "auth" || ops[0].Action != "登录面板" || ops[0].Result != "failure" {
		t.Fatalf("失败登录操作日志：%+v", ops)
	}
	if len(logins) != 1 || logins[0].Status != "failure" {
		t.Fatalf("失败登录登录日志：%+v", logins)
	}

	// 登录成功：Set-Cookie 逐字前缀 + 会话可探测。
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, sameOriginRequest(http.MethodPost, "/api/auth/login",
		`{"username":"dev","password":"dev-elysian"}`))
	if rec.Code != http.StatusOK || rec.Body.String() != `{"ok":true}` {
		t.Fatalf("登录成功响应 = %d %s", rec.Code, rec.Body.String())
	}
	cookie := rec.Header().Get("Set-Cookie")
	if !strings.HasPrefix(cookie, "elysian_session=") || !strings.Contains(cookie, "Path=/; HttpOnly; SameSite=Lax; Max-Age=604800") {
		t.Fatalf("Set-Cookie = %q", cookie)
	}
	sessionID := strings.TrimSuffix(strings.TrimPrefix(cookie, "elysian_session="), "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800")
	if len(sessionID) != 43 {
		t.Fatalf("会话 id 长度 = %d，期望 43（%q）", len(sessionID), sessionID)
	}

	// 会话探测：authenticated:true 且带 devAccount 标记。
	rec = httptest.NewRecorder()
	sessionReq := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	sessionReq.Header.Set("Cookie", "elysian_session="+sessionID)
	handler.ServeHTTP(rec, sessionReq)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"authenticated":true,"devAccount":true}` {
		t.Fatalf("会话探测 = %d %s", rec.Code, rec.Body.String())
	}

	// 会话有效时可达容器片：LocalDemo 整片 503 文案（鉴权已过、路由已命中挂载）。
	rec = httptest.NewRecorder()
	dockerReq := httptest.NewRequest(http.MethodGet, "/api/docker/containers", nil)
	dockerReq.Header.Set("Cookie", "elysian_session="+sessionID)
	handler.ServeHTTP(rec, dockerReq)
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"真实容器管理仅在 Docker 容器内可用"}` {
		t.Fatalf("带会话访问容器片 = %d %s", rec.Code, rec.Body.String())
	}

	// 登出：幂等清 Cookie；会话即刻失效（下次探测未登录）。
	rec = httptest.NewRecorder()
	logoutReq := sameOriginRequest(http.MethodPost, "/api/auth/logout", "")
	logoutReq.Header.Set("Cookie", "elysian_session="+sessionID)
	handler.ServeHTTP(rec, logoutReq)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"ok":true}` {
		t.Fatalf("登出响应 = %d %s", rec.Code, rec.Body.String())
	}
	if cookie := rec.Header().Get("Set-Cookie"); !strings.HasPrefix(cookie, "elysian_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0") {
		t.Fatalf("登出 Set-Cookie = %q", cookie)
	}
	rec = httptest.NewRecorder()
	sessionReq = httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	sessionReq.Header.Set("Cookie", "elysian_session="+sessionID)
	handler.ServeHTTP(rec, sessionReq)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"authenticated":false,"devAccount":true}` {
		t.Fatalf("登出后会话探测 = %d %s", rec.Code, rec.Body.String())
	}
	// 成功登录的登录日志（failure 一条 + success 一条）。
	_, logins = fake.snapshot()
	if len(logins) != 2 || logins[1].Status != "success" {
		t.Fatalf("登录日志序列：%+v", logins)
	}
}

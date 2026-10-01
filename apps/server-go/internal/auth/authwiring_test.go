package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// 鉴权接线端到端测试（authWiring.test.ts 的 RequireSession 可移植子集）：在 auth 包内
// 自建 mini 装配（复刻 app 装配的经手次序 RequestID → StripTailSlash → RequireSession →
// 各片挂载，不 import internal/app——域包禁止反向依赖装配层），锚定 RequireSession 在
// 完整链路里的行为——无 Cookie 的各挂载点（读、写、SSE、WS 升级路径）一律 401 且不进
// 路由 handler；四条豁免路径放行（含尾斜杠双形与无会话登出的幂等）；CLI/面板改密后
// 旧会话下一次请求即 401（epoch 失效端到端）。
//
// 审计与登录日志（authWiring 的 logs 锚点）由 logs 域审计中间件承担、终端 closer 登记
// 由 terminals 域承担：两条都在集成阶段做端到端回归，本文件不覆盖（见交付 gaps）。

// buildWiringApp 复刻装配次序的 mini app：health →（审计位置留给集成）→ RequireSession
// → auth 片 + 各挂载点占位（读 200 / 容器边界 503 / SSE / WS 升级）→ /api 兜底 404。
func buildWiringApp(deps Deps) http.Handler {
	root := chi.NewRouter()
	root.Use(middleware.RequestID)
	root.Use(middleware.StripTailSlash)
	root.Use(RequireSession(deps))

	root.Get(shared.HealthPath, func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	root.Mount(shared.AuthMount, NewRouter(deps))
	// 各片挂载点占位：RequireSession 放行后才会到达。
	root.Get("/api/logs/runtime", func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]any{"entries": []any{}})
	})
	root.Get("/api/security/firewall", func(w http.ResponseWriter, r *http.Request) {
		shared.SendError(w, http.StatusServiceUnavailable, "真实防火墙仅在 Docker 容器内可用")
	})
	root.Get("/api/platform/memory", func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	root.Get("/api/docker/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})
	root.Get("/api/terminals/ws", func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]bool{"upgraded": true})
	})
	root.Get("/api/docker/containers/{id}/terminal", func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]bool{"upgraded": true})
	})
	root.Get("/api/databases/{id}/terminal", func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]bool{"upgraded": true})
	})
	root.HandleFunc("/api/*", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "404 Not Found", http.StatusNotFound)
	})
	return root
}

type wiringClient struct {
	handler http.Handler
}

func (c wiringClient) do(method, path, cookie, origin string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost:5173"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	c.handler.ServeHTTP(recorder, req)
	return recorder
}

func (c wiringClient) get(path, cookie string) *httptest.ResponseRecorder {
	return c.do(http.MethodGet, path, cookie, "", "")
}

func (c wiringClient) post(path, cookie string) *httptest.ResponseRecorder {
	return c.do(http.MethodPost, path, cookie, testOrigin, "")
}

func (c wiringClient) postJSON(path string, body, cookie string) *httptest.ResponseRecorder {
	return c.do(http.MethodPost, path, cookie, testOrigin, body)
}

func newWiringFixture(t *testing.T, mutate func(deps *Deps)) (wiringClient, CredentialsStore) {
	t.Helper()
	hasher := newRecordingHasher()
	credentials := NewMemoryCredentialsStore(&PanelCredentials{
		Username:          "admin",
		PasswordHash:      mustHash(t, "e2e-password"),
		PasswordChangedAt: testEpoch,
	})
	deps := Deps{
		Enabled:       true,
		Credentials:   credentials,
		Sessions:      NewMemorySessionStore(nil),
		Hasher:        hasher,
		ReturnOrigins: NewMemoryReturnOriginRegistry(nil),
	}
	if mutate != nil {
		mutate(&deps)
	}
	return wiringClient{handler: buildWiringApp(deps)}, credentials
}

func TestRequireSessionBlocksAllMounts(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	for _, path := range []string{
		"/api/security/firewall",     // 容器边界片：非容器 503——鉴权在前应 401
		"/api/logs/runtime",          // 日志读（无容器边界的片）
		"/api/platform/memory",       // 现状无守卫的读端点
		"/api/platform/dependencies", // 现状无守卫的读端点
		"/api/nothing-here",          // 未匹配路径也先挡在鉴权
	} {
		recorder := client.get(path, "")
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s 状态码 = %d，期望 401", path, recorder.Code)
			continue
		}
		if body := recorder.Body.String(); !strings.Contains(body, `"error":"未登录或会话已过期"`) {
			t.Errorf("%s 响应体 = %s", path, body)
		}
	}
}

func TestRequireSessionBlocksSSEAndWSBeforeUpgrade(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	sse := client.get("/api/docker/events", "")
	if sse.Code != http.StatusUnauthorized {
		t.Errorf("SSE 状态码 = %d，期望 401（开流之前短路）", sse.Code)
	}
	for _, wsPath := range []string{
		"/api/terminals/ws",
		"/api/docker/containers/a1b2c3d4e5f6/terminal",
		"/api/databases/db-1/terminal",
	} {
		recorder := client.get(wsPath, "")
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s 状态码 = %d，期望 401（升级之前短路）", wsPath, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), `"error":"未登录或会话已过期"`) {
			t.Errorf("%s 响应体 = %s", wsPath, recorder.Body.String())
		}
	}
}

func TestRequireSessionExemptPaths(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	if recorder := client.get("/api/health", ""); recorder.Code != http.StatusOK {
		t.Errorf("health 状态码 = %d", recorder.Code)
	}
	if recorder := client.get("/api/health/", ""); recorder.Code != http.StatusOK {
		t.Errorf("health 尾斜杠双形状态码 = %d", recorder.Code)
	}
	session := client.get("/api/auth/session", "")
	if session.Code != http.StatusOK || !strings.Contains(session.Body.String(), `"authenticated":false`) {
		t.Errorf("session 探测 = %d %s", session.Code, session.Body.String())
	}
	// 尾斜杠双形：都命中登录路由，豁免判定剥尾斜杠后放行。
	for _, path := range []string{"/api/auth/login", "/api/auth/login/"} {
		recorder := client.postJSON(path, `{"username":"admin","password":"e2e-password"}`, "")
		if recorder.Code != http.StatusOK {
			t.Errorf("%s 状态码 = %d，期望 200", path, recorder.Code)
			continue
		}
		if !strings.HasPrefix(recorder.Header().Get("Set-Cookie"), "elysian_session=") {
			t.Errorf("%s 应下发会话 Cookie", path)
		}
	}
	logout := client.post("/api/auth/logout", "")
	if logout.Code != http.StatusOK || !strings.Contains(logout.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Errorf("无会话 logout 幂等 200：得 %d", logout.Code)
	}
}

func TestRequireSessionPassesWithCookie(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	if login.Code != http.StatusOK {
		t.Fatalf("登录失败：%d", login.Code)
	}
	cookie := cookiePair(login.Header().Get("Set-Cookie"))

	logs := client.get("/api/logs/runtime", cookie)
	if logs.Code != http.StatusOK {
		t.Errorf("日志片状态码 = %d，期望 200", logs.Code)
	}
	firewall := client.get("/api/security/firewall", cookie)
	if firewall.Code != http.StatusServiceUnavailable {
		t.Errorf("容器边界片状态码 = %d，期望 503（均非 401）", firewall.Code)
	}
}

func TestRequireSessionEpochRotationCLI(t *testing.T) {
	client, credentials := newWiringFixture(t, nil)
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookie := cookiePair(login.Header().Get("Set-Cookie"))
	if status := client.get("/api/logs/runtime", cookie).Code; status != http.StatusOK {
		t.Fatalf("改密前状态码 = %d，期望 200", status)
	}
	// CLI 改密等价于换哈希 + 新 passwordChangedAt（内存 store 直写）。
	if _, err := credentials.Write(mustHash(t, "rotated-password")); err != nil {
		t.Fatalf("改密失败：%v", err)
	}
	if status := client.get("/api/logs/runtime", cookie).Code; status != http.StatusUnauthorized {
		t.Errorf("改密后旧会话下一次请求即 401，得 %d", status)
	}
}

func TestRequireSessionSettingsEndpointsNotExempt(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	list := client.get("/api/auth/sessions", "")
	if list.Code != http.StatusUnauthorized || !strings.Contains(list.Body.String(), `"error":"未登录或会话已过期"`) {
		t.Errorf("GET /sessions = %d %s", list.Code, list.Body.String())
	}
	change := client.postJSON("/api/auth/password", `{"currentPassword":"a","newPassword":"b","confirmNewPassword":"c"}`, "")
	if change.Code != http.StatusUnauthorized {
		t.Errorf("POST /password = %d，期望 401", change.Code)
	}
	others := client.post("/api/auth/sessions/logout-others", "")
	if others.Code != http.StatusUnauthorized {
		t.Errorf("POST /sessions/logout-others = %d，期望 401", others.Code)
	}
}

func TestRequireSessionSettingsReachableWithSession(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookie := cookiePair(login.Header().Get("Set-Cookie"))
	recorder := client.get("/api/auth/sessions", cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"current":true`) {
		t.Errorf("回当前会话一行（current:true）：%s", recorder.Body.String())
	}
}

func TestPasswordChangeEndpointInvalidatesOldSessions(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookie := cookiePair(login.Header().Get("Set-Cookie"))

	change := client.postJSON("/api/auth/password",
		`{"currentPassword":"e2e-password","newPassword":"rotated-password","confirmNewPassword":"rotated-password"}`, cookie)
	if change.Code != http.StatusOK {
		t.Fatalf("改密失败：%d（%s）", change.Code, change.Body.String())
	}
	if !strings.Contains(change.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Error("改密成功清 Cookie")
	}
	// 旧 Cookie 下一次请求即 401（epoch 不匹配被 validate 删除）。
	if status := client.get("/api/logs/runtime", cookie).Code; status != http.StatusUnauthorized {
		t.Errorf("旧会话下一次请求 = %d，期望 401", status)
	}
	// 新密码可登录、旧密码 401。
	relogin := client.postJSON("/api/auth/login", `{"username":"admin","password":"rotated-password"}`, "")
	if relogin.Code != http.StatusOK {
		t.Errorf("新密码再登录 = %d", relogin.Code)
	} else if status := client.get("/api/logs/runtime", cookiePair(relogin.Header().Get("Set-Cookie"))).Code; status != http.StatusOK {
		t.Errorf("新会话读日志 = %d，期望 200", status)
	}
	oldPassword := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	if oldPassword.Code != http.StatusUnauthorized {
		t.Errorf("旧密码登录 = %d，期望 401", oldPassword.Code)
	}
}

func TestLogoutOthersKeepsCurrentSession(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	first := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	second := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookieA := cookiePair(first.Header().Get("Set-Cookie"))
	cookieB := cookiePair(second.Header().Get("Set-Cookie"))

	recorder := client.post("/api/auth/sessions/logout-others", cookieA)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if !strings.Contains(client.get("/api/auth/session", cookieA).Body.String(), `"authenticated":true`) {
		t.Error("当前会话不受影响")
	}
	if status := client.get("/api/logs/runtime", cookieB).Code; status != http.StatusUnauthorized {
		t.Errorf("另一会话下一次请求 = %d，期望 401", status)
	}
}

func TestRequireSessionDisabledPassesAll(t *testing.T) {
	client, _ := newWiringFixture(t, func(deps *Deps) { deps.Enabled = false })
	if status := client.get("/api/logs/runtime", "").Code; status != http.StatusOK {
		t.Errorf("无 Cookie 读日志 = %d，期望 200（回到无鉴权演示语义）", status)
	}
	session := client.get("/api/auth/session", "")
	if !strings.Contains(session.Body.String(), `"authenticated":true`) {
		t.Errorf("session 探测 = %s", session.Body.String())
	}
	login := client.postJSON("/api/auth/login", `{"username":"x","password":"y"}`, "")
	if login.Code != http.StatusOK || login.Header().Get("Set-Cookie") != "" {
		t.Errorf("演示登录恒成功不下发 Cookie：得 %d", login.Code)
	}
}

func TestWiringReturnToEndToEnd(t *testing.T) {
	client, _ := newWiringFixture(t, func(deps *Deps) {
		deps.ReturnOrigins = NewMemoryReturnOriginRegistry([]string{returnTool})
	})
	hit := client.get("/api/auth/session?returnTo="+encodeURIComponent(returnTool+"/projects/42"), "")
	if !strings.Contains(hit.Body.String(), `"returnTo":"http://127.0.0.1:5173/projects/42"`) {
		t.Errorf("名单内可回跳并保留 path：%s", hit.Body.String())
	}
	for _, raw := range []string{"http://127.0.0.1:6000/x", "http://evil.example/x"} {
		miss := client.get("/api/auth/session?returnTo="+encodeURIComponent(raw), "")
		if !strings.Contains(miss.Body.String(), `"returnTo":null`) {
			t.Errorf("%s 应回 null：%s", raw, miss.Body.String())
		}
	}
}

// 工具后端形状：不带 Origin 头、只带会话 Cookie 的 GET /api/auth/session 回 true。
func TestWiringSessionWithoutOriginHeader(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookie := cookiePair(login.Header().Get("Set-Cookie"))
	loggedIn := client.get("/api/auth/session", cookie)
	if !strings.Contains(loggedIn.Body.String(), `"authenticated":true`) {
		t.Errorf("已登录探测 = %s", loggedIn.Body.String())
	}
	anonymous := client.get("/api/auth/session", "")
	if !strings.Contains(anonymous.Body.String(), `"authenticated":false`) {
		t.Errorf("匿名探测 = %s", anonymous.Body.String())
	}
}

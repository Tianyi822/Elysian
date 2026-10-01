package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 操作审计采集的覆盖与防绕过测试（operationAudit.test.ts 的对等用例）：用真实守卫链
 * 的迷你子片挂到与 app.ts 同构的父应用上，采集中间件按装配次序注册在最前。
 * 迷你子片复刻各域守卫链（同源 403 → 读体 415/413/400 → 端点 → 404），
 * 钉住「客户端不能绕开采集、也不能让客户端可控的字段变成审计事实」。
 */

const testHost = "localhost:5173"
const sameOrigin = "http://" + testHost

// miniEndpointMode 迷你子片的模式。
type miniEndpointMode int

const (
	miniNormal      miniEndpointMode = iota // 正常可用
	miniUnavailable                         // 整片 503（前置短路，路由不可达）
	miniEndpoint503                         // 具体端点自身回 503（数据库式）
	miniPanic                               // 父层中间件 panic
)

// newMiniRouter 迷你子片：复刻真实域的守卫链与 404 兜底。
func newMiniRouter(mode miniEndpointMode) chi.Router {
	r := chi.NewRouter()
	if mode == miniUnavailable {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				shared.SendError(w, http.StatusServiceUnavailable, "真实管理仅在 Docker 容器内可用")
			})
		})
	}
	r.Use(middleware.SameOriginGuard())
	fallback := func(w http.ResponseWriter, req *http.Request) {
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知端点：%s %s", req.Method, req.URL.Path))
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)

	respond := func(status int) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			if mode == miniEndpoint503 {
				shared.SendError(w, http.StatusServiceUnavailable, "容器数据库服务不可用")
				return
			}
			shared.SendJSON(w, status, map[string]any{"ok": true})
		}
	}
	bodyOf := func(w http.ResponseWriter, req *http.Request) map[string]any {
		if mode == miniEndpoint503 {
			shared.SendError(w, http.StatusServiceUnavailable, "容器数据库服务不可用")
			return nil
		}
		parsed, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return nil
		}
		if m, ok := parsed.(map[string]any); ok {
			return m
		}
		return map[string]any{}
	}

	r.Get("/overview", respond(http.StatusOK))
	r.Put("/service-enabled", func(w http.ResponseWriter, req *http.Request) {
		body := bodyOf(w, req)
		if body == nil {
			return
		}
		if _, ok := body["enabled"].(bool); !ok {
			shared.SendError(w, http.StatusBadRequest, "开关值无效")
			return
		}
		shared.SendJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	r.Put("/port", func(w http.ResponseWriter, req *http.Request) {
		body := bodyOf(w, req)
		if body == nil {
			return
		}
		if !isJSONNumberOrString(body["port"]) {
			shared.SendError(w, http.StatusBadRequest, "端口无效")
			return
		}
		shared.SendJSON(w, http.StatusOK, map[string]any{"ok": true, "port": body["port"]})
	})
	r.Put("/auth-methods", respond(http.StatusOK))
	r.Put("/root-login-policy", respond(http.StatusOK))
	r.Post("/root-password", respond(http.StatusOK))
	r.Post("/root-key", respond(http.StatusOK))
	r.Post("/keys", respond(http.StatusOK))
	r.Delete("/keys/{id}", respond(http.StatusOK))
	return r
}

// newUsersMiniRouter 系统账号迷你子片。
func newUsersMiniRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.SameOriginGuard())
	fallback := func(w http.ResponseWriter, req *http.Request) {
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知端点：%s %s", req.Method, req.URL.Path))
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)
	ok := func(w http.ResponseWriter, req *http.Request) {
		if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
	r.Post("/", ok)
	r.Put("/{id}", ok)
	r.Delete("/{id}", ok)
	r.Post("/sync", ok)
	return r
}

// newDockerMiniRouter 容器迷你子片。
func newDockerMiniRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.SameOriginGuard())
	fallback := func(w http.ResponseWriter, req *http.Request) {
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知端点：%s %s", req.Method, req.URL.Path))
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)
	r.Post("/containers", func(w http.ResponseWriter, req *http.Request) {
		if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusCreated, map[string]any{"ok": true})
	})
	r.Delete("/images/{id}", func(w http.ResponseWriter, req *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	return r
}

// newAuthMiniRouter 登录鉴权迷你子片（login 401/200 双形）。
func newAuthMiniRouter(loginStatus int) chi.Router {
	r := chi.NewRouter()
	r.Post("/login", func(w http.ResponseWriter, req *http.Request) {
		if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, loginStatus, map[string]any{"ok": loginStatus < 400})
	})
	r.Post("/logout", func(w http.ResponseWriter, req *http.Request) {
		shared.SendJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	return r
}

// newLogsMiniRouter 日志迷你子片（清空端点）。
func newLogsMiniRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.SameOriginGuard())
	r.Post("/runtime/clear", func(w http.ResponseWriter, req *http.Request) {
		if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, map[string]any{"cleared": map[string]any{}})
	})
	return r
}

// auditApp 与 app.ts 同构的父应用：剥尾斜杠 → 采集 → （可选 401 短路/panic 中间件）→ 各片。
func auditApp(svc seam.Logs, mode miniEndpointMode) http.Handler {
	return auditAppWithGate(svc, mode, nil)
}

// auditAppWithGate 可注入「鉴权短路」中间件（401 在路由之前）。
func auditAppWithGate(svc seam.Logs, mode miniEndpointMode, gate func(http.Handler) http.Handler) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Use(OperationAuditMiddleware(svc))
	if gate != nil {
		parent.Use(gate)
	}
	if mode == miniPanic {
		parent.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if strings.HasPrefix(req.URL.Path, "/api/security/ssh") {
					panic(fmt.Errorf("父层中间件炸了"))
				}
				next.ServeHTTP(w, req)
			})
		})
	}
	parent.Mount("/api/security/ssh", newMiniRouter(mode))
	parent.Mount("/api/security/users", newUsersMiniRouter())
	parent.Mount("/api/docker", newDockerMiniRouter())
	parent.Mount("/api/auth", newAuthMiniRouter(http.StatusUnauthorized))
	parent.Mount("/api/logs", newLogsMiniRouter())
	return middleware.EndpointErrorHandler(parent)
}

// auditJSON 带体 JSON 请求（同源）。
func auditJSON(t *testing.T, app http.Handler, method, target string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	payload := "{}"
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("编码请求体失败：%v", err)
		}
		payload = string(encoded)
	}
	req := httptest.NewRequest(method, target, bytes.NewReader([]byte(payload)))
	req.Host = testHost
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", sameOrigin)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

// auditRaw 原始体请求（可控 content-type/origin）。
func auditRaw(t *testing.T, app http.Handler, method, target, body, contentType, origin string, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader([]byte(body)))
	req.Host = testHost
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

// firstOp 首条操作记录。
func firstOp(t *testing.T, sink *sinkService) seam.OperationRecord {
	t.Helper()
	ops := sink.operationsOf()
	if len(ops) == 0 {
		t.Fatalf("应有操作记录")
	}
	return ops[0]
}

// strPtr 值取文本（nil → "<null>"）。
func strPtr(p *string) string {
	if p == nil {
		return "<null>"
	}
	return *p
}

// ① 命中描述符的写请求记一条操作日志 + 一条运行日志镜像，字段全部来自服务端。
func TestAuditDescriptorHit(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	rec := auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{"port": 2222}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT port = %d（%s）", rec.Code, rec.Body.String())
	}
	op := firstOp(t, sink)
	if op.Category != "security" || op.Action != "修改 SSH 监听端口" ||
		op.Target == nil || *op.Target != "sshd" || op.Result != "success" ||
		strPtr(op.Summary) != "端口 2222" || op.Method != "PUT" ||
		op.Path != "/api/security/ssh/port" || op.HTTPStatus == nil || *op.HTTPStatus != 200 {
		t.Errorf("操作记录字段不符：%+v", op)
	}
	runtimes := sink.runtimesOf()
	if len(runtimes) != 1 || runtimes[0].level != "info" || runtimes[0].source != "logs.operation" ||
		runtimes[0].message != "操作：修改 SSH 监听端口（成功）" {
		t.Errorf("运行镜像不符：%+v", runtimes)
	}
}

// ② GET/HEAD 只读不谈：不记录、也不写运行日志镜像。
func TestAuditSkipsGetHead(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req := httptest.NewRequest(method, "/api/security/ssh/overview", nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Fatalf("%s 异常：%d", method, rec.Code)
		}
	}
	if len(sink.operationsOf()) != 0 || len(sink.runtimesOf()) != 0 {
		t.Errorf("GET/HEAD 不应记录：%v %v", sink.operationsOf(), sink.runtimesOf())
	}
}

// ③ 业务 4xx 记 failure。
func TestAuditBusiness4xxRecordsFailure(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	rec := auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT port 空体应 400：%d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 400 {
		t.Errorf("4xx 应记 failure 带码：%+v", op)
	}
}

// ④ 读体守卫 415/413 也记 failure，httpStatus 带上码。
func TestAuditGuardErrorsRecorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)

	noType := auditRaw(t, app, http.MethodPut, "/api/security/ssh/port", "{}", "", sameOrigin, "")
	if noType.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("415 = %d", noType.Code)
	}
	// 申报超限：直接设 req.ContentLength（httptest 不按 Content-Length 头回填该字段）。
	req := httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", bytes.NewReader([]byte(`{"port":2222}`)))
	req.Host = testHost
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", sameOrigin)
	req.ContentLength = 64*1024 + 1
	tooLarge := httptest.NewRecorder()
	app.ServeHTTP(tooLarge, req)
	if tooLarge.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("413 = %d", tooLarge.Code)
	}
	ops := sink.operationsOf()
	statuses := []int{}
	for _, op := range ops {
		statuses = append(statuses, *op.HTTPStatus)
		if op.Result != "failure" {
			t.Errorf("守卫错误应记 failure：%+v", op)
		}
	}
	if len(statuses) != 2 || statuses[0] != 415 || statuses[1] != 413 {
		t.Errorf("httpStatus 序列不符：%v", statuses)
	}
}

// ⑤ 跨源 403 且命中具体路由时记录；⑥ 跨源 403 无具体路由不记录。
func TestAuditCrossOrigin403(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)

	rec := auditRaw(t, app, http.MethodPut, "/api/security/ssh/port", `{"port":2222}`, "application/json", "http://evil.example", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源应 403：%d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 403 || strPtr(op.Summary) != "端口 2222" {
		t.Errorf("跨源 403 应记 failure：%+v", op)
	}

	unknown := auditRaw(t, app, http.MethodPost, "/api/security/ssh/nope", "{}", "application/json", "http://evil.example", "")
	if unknown.Code != http.StatusForbidden {
		t.Fatalf("跨源未知写路径应 403：%d", unknown.Code)
	}
	if len(sink.operationsOf()) != 1 {
		t.Errorf("无具体路由的跨源不得追加记录：%d", len(sink.operationsOf()))
	}
}

// ⑦ 404（未知路径）不记录。
func TestAudit404NotRecorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	rec := auditJSON(t, app, http.MethodPost, "/api/security/ssh/nope", map[string]any{}, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知路径应 404：%d", rec.Code)
	}
	if len(sink.operationsOf()) != 0 || len(sink.runtimesOf()) != 0 {
		t.Errorf("404 不应记录")
	}
}

// ⑦b 整片 503 不记录（服务不可用、动作没发生）。
func TestAuditWholeDomain503NotRecorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniUnavailable)
	rec := auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{"port": 2222}, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("整片应 503：%d", rec.Code)
	}
	if len(sink.operationsOf()) != 0 || len(sink.runtimesOf()) != 0 {
		t.Errorf("整片 503 不应记录（本地开发下会刷屏）：%v %v", sink.operationsOf(), sink.runtimesOf())
	}
}

// ⑦c 具体端点自身的 503（数据库式逐路 503）照记 failure。
func TestAuditConcreteEndpoint503Recorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniEndpoint503)
	rec := auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{"port": 2222}, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("端点应 503：%d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 503 {
		t.Errorf("具体端点 503 应记 failure：%+v", op)
	}
	// 5xx 运行日志对 503 不写。
	for _, line := range sink.runtimesOf() {
		if line.source == httpLogSource {
			t.Errorf("503 不应写 5xx 运行日志：%+v", line)
		}
	}
}

// ⑧⑨ 子片/父层中间件的 5xx：记 failure，并补一条 error 运行日志（em dash 逐字）；
// 父层 panic 按 500 记录后原样上抛，由 EndpointErrorHandler 映射回响应。
func TestAudit5xxAndPanicRepanic(t *testing.T) {
	panicSink := &sinkService{}
	panicApp := auditApp(panicSink, miniPanic)
	rec := auditJSON(t, panicApp, http.MethodPut, "/api/security/ssh/port", map[string]any{"port": 2222}, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic 应映射 500：%d", rec.Code)
	}
	op := firstOp(t, panicSink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 500 || strPtr(op.Summary) != "端口 2222" {
		t.Errorf("panic 应按 500 记 failure：%+v", op)
	}
	runtimes := panicSink.runtimesOf()
	found := false
	for _, line := range runtimes {
		if line.level == "error" && line.source == "server.http" &&
			line.message == "请求处理失败：PUT /api/security/ssh/port — HTTP 500" {
			found = true
		}
	}
	if !found {
		t.Errorf("应补 error 运行日志（注意 em dash 两侧空格）：%+v", runtimes)
	}
}

// ⑩ 摘要只取白名单字段：体里的额外字段不进摘要。
func TestAuditSummaryWhitelist(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	auditJSON(t, app, http.MethodPut, "/api/security/ssh/port",
		map[string]any{"port": 2222, "evil": "注入内容", "摘要": "伪造摘要"}, nil)
	op := firstOp(t, sink)
	if strPtr(op.Summary) != "端口 2222" {
		t.Errorf("摘要不符：%+v", op.Summary)
	}
	serialized, _ := json.Marshal(sink.operationsOf())
	for _, forbidden := range []string{"evil", "注入内容", "伪造摘要"} {
		if strings.Contains(string(serialized), forbidden) {
			t.Errorf("白名单外字段泄漏进记录：%s", forbidden)
		}
	}
}

// ⑪ 体里伪造审计字段（category/action/result/at）不改变落盘记录。
func TestAuditForgedFieldsIgnored(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{
		"port": 2222, "category": "database", "action": "已批准的删除", "result": "success", "at": "2000-01-01T00:00:00.000Z",
	}, nil)
	op := firstOp(t, sink)
	if op.Category != "security" || op.Action != "修改 SSH 监听端口" || op.Result != "success" {
		t.Errorf("伪造字段改变了记录：%+v", op)
	}
}

// ⑫ 凭据端点：请求体里的密码不出现在任何记录；summary 恒 null；字段集合恰为八键。
func TestAuditCredentialIsolation(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)

	rec := auditJSON(t, app, http.MethodPost, "/api/security/ssh/root-password", map[string]any{"password": "Zh9aiphoo1aiya"}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("root-password = %d", rec.Code)
	}
	rec = auditJSON(t, app, http.MethodPost, "/api/security/users", map[string]any{
		"name": "wangwu", "password": "Eiph7eivai0ahth", "loginMethod": "password", "status": "active", "isAdmin": false, "note": nil,
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("users POST = %d", rec.Code)
	}
	rec = auditJSON(t, app, http.MethodPut, "/api/security/users/wangwu", map[string]any{
		"password": "Aiquu8uuc2eiv4o", "loginMethod": "password", "status": "active", "isAdmin": false, "note": nil,
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("users PUT = %d", rec.Code)
	}

	ops := sink.operationsOf()
	if len(ops) != 3 {
		t.Fatalf("三个端点各一条：%d", len(ops))
	}
	serialized, _ := json.Marshal(ops)
	for _, secret := range []string{"Zh9aiphoo1aiya", "Eiph7eivai0ahth", "Aiquu8uuc2eiv4o"} {
		if strings.Contains(string(serialized), secret) {
			t.Errorf("密码泄漏进记录：%s", secret)
		}
	}
	for _, op := range ops {
		if op.Summary != nil {
			t.Errorf("未声明 summarize 的端点摘要恒 null：%+v", op)
		}
	}
	// 字段集合恰为八键（序列化键数）。
	var probe map[string]any
	firstSerialized, _ := json.Marshal(ops[0])
	if err := json.Unmarshal(firstSerialized, &probe); err != nil {
		t.Fatalf("解析首条记录失败：%v", err)
	}
	if len(probe) != 8 {
		t.Errorf("字段集合应为八键：%v", probe)
	}
	// 动作照常留痕。
	actions := []string{ops[0].Action, ops[1].Action, ops[2].Action}
	want := []string{"重置 Root 密码", "创建系统账号", "修改系统账号"}
	for i := range want {
		if actions[i] != want[i] {
			t.Errorf("动作 %d = %q, want %q", i, actions[i], want[i])
		}
	}
	if ops[2].Target == nil || *ops[2].Target != "账号 wangwu" {
		t.Errorf("users PUT 对象应取路径参数：%+v", ops[2].Target)
	}
}

// ⑬ 路径参数进 target；体里的对象名取白名单字段。
func TestAuditPathParamsAndBodyTarget(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	auditJSON(t, app, http.MethodDelete, "/api/security/ssh/keys/k-9", nil, nil)
	auditJSON(t, app, http.MethodPost, "/api/security/ssh/keys", map[string]any{"name": "笔记本", "userId": "wangwu"}, nil)

	ops := sink.operationsOf()
	if len(ops) != 2 {
		t.Fatalf("两条记录：%d", len(ops))
	}
	if ops[0].Action != "删除登录密钥" || strPtr(ops[0].Target) != "k-9" || ops[0].Summary != nil {
		t.Errorf("路径参数 target 不符：%+v", ops[0])
	}
	if ops[1].Action != "创建登录密钥" || strPtr(ops[1].Target) != "账号 wangwu" || strPtr(ops[1].Summary) != "名称 笔记本" {
		t.Errorf("体白名单对象/摘要不符：%+v", ops[1])
	}
}

// ⑭ 体超 8 KiB 摘要退化 null。
func TestAuditSummaryBodyLimit(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	padding := strings.Repeat("x", operationSummaryBodyMaxBytes+1)
	rec := auditJSON(t, app, http.MethodPost, "/api/security/ssh/keys", map[string]any{"name": padding, "userId": "wangwu"}, nil)
	if rec.Code != http.StatusOK && rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("POST keys = %d", rec.Code)
	}
	// 体超 64 KiB 时读体守卫 413（摘要同样 null）；两种形都断言摘要退化。
	ops := sink.operationsOf()
	if len(ops) != 1 {
		t.Fatalf("一条记录：%d", len(ops))
	}
	if ops[0].Summary != nil {
		t.Errorf("超限体摘要应 null：%+v", ops[0].Summary)
	}
}

// ⑮ 坏 JSON 体：摘要为空、结果按最终状态码判定。
func TestAuditBadJSONBody(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	rec := auditRaw(t, app, http.MethodPut, "/api/security/ssh/port", "{", "application/json", sameOrigin, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("坏 JSON 应 400：%d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 400 || op.Summary != nil {
		t.Errorf("坏 JSON 记录不符：%+v", op)
	}
}

// ⑯ 采集写盘失败不影响业务响应。
func TestAuditWriteFailureDoesNotAffectResponse(t *testing.T) {
	sink := &sinkService{panicWrites: true}
	app := auditApp(sink, miniNormal)
	rec := auditJSON(t, app, http.MethodPut, "/api/security/ssh/port", map[string]any{"port": 2222}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("采集失败不应影响业务响应：%d", rec.Code)
	}
}

// ⑰ 创建容器摘要不含环境变量值。
func TestAuditContainerSummaryExcludesEnv(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	imageHex := "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
	rec := auditJSON(t, app, http.MethodPost, "/api/docker/containers", map[string]any{
		"imageId": imageHex, "name": "redis-echo", "ports": []any{},
		"env":     []any{map[string]any{"key": "DB_PASSWORD", "value": "super-secret"}},
		"volumes": []any{}, "restartPolicy": "no",
	}, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("创建容器 = %d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Action != "创建容器" || strPtr(op.Target) != "redis-echo" ||
		strPtr(op.Summary) != "镜像 "+imageHex || op.Result != "success" {
		t.Errorf("容器摘要不符：%+v", op)
	}
	serialized, _ := json.Marshal(op)
	if strings.Contains(string(serialized), "super-secret") || strings.Contains(string(serialized), "DB_PASSWORD") {
		t.Errorf("环境变量值泄漏进记录")
	}
}

// ⑱ 清空日志这条写请求本身也留痕。
func TestAuditClearLogsRecorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	rec := auditJSON(t, app, http.MethodPost, "/api/logs/runtime/clear", map[string]any{}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("清空 = %d（%s）", rec.Code, rec.Body.String())
	}
	op := firstOp(t, sink)
	if op.Category != "logs" || op.Action != "清空运行日志" || op.Result != "success" ||
		op.Method != "POST" || op.Path != "/api/logs/runtime/clear" || op.HTTPStatus == nil || *op.HTTPStatus != 200 {
		t.Errorf("清空留痕不符：%+v", op)
	}
	if len(sink.loginsOf()) != 0 {
		t.Errorf("清空不应写登录日志")
	}
}

// ⑲ 登录端点额外记登录日志：状态取最终响应、地址来自 TCP 对端（RemoteAddr 剥端口）、
// 密码不进记录。
func TestAuditLoginAttemptRecorded(t *testing.T) {
	sink := &sinkService{}
	app := auditApp(sink, miniNormal)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		bytes.NewReader([]byte(`{"username":"admin","password":"secret-value"}`)))
	req.Host = testHost
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", sameOrigin)
	req.Header.Set("User-Agent", "TestBrowser/1")
	req.RemoteAddr = "10.0.0.8:51736"
	rw := httptest.NewRecorder()
	app.ServeHTTP(rw, req)
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("登录应 401：%d", rw.Code)
	}
	op := firstOp(t, sink)
	if op.Category != "auth" || op.Action != "登录面板" || op.Result != "failure" ||
		op.HTTPStatus == nil || *op.HTTPStatus != 401 {
		t.Errorf("登录操作记录不符：%+v", op)
	}
	logins := sink.loginsOf()
	if len(logins) != 1 || logins[0].IP != "10.0.0.8" || logins[0].UserAgent != "TestBrowser/1" || logins[0].Status != "failure" {
		t.Errorf("登录日志不符：%+v", logins)
	}
	serialized, _ := json.Marshal(logins)
	serializedOps, _ := json.Marshal(sink.operationsOf())
	if strings.Contains(string(serialized), "secret-value") || strings.Contains(string(serializedOps), "secret-value") {
		t.Errorf("密码泄漏进记录")
	}
}

// ⑳ 鉴权短路（401 在路由之前）仍记 failure 操作日志——审计先于鉴权。
func TestAuditPreRouting401Recorded(t *testing.T) {
	sink := &sinkService{}
	gate := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			shared.SendError(w, http.StatusUnauthorized, "未登录或会话已过期")
		})
	}
	app := auditAppWithGate(sink, miniNormal, gate)
	rec := auditJSON(t, app, http.MethodPost, "/api/logs/runtime/clear", map[string]any{}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无会话应 401：%d", rec.Code)
	}
	op := firstOp(t, sink)
	if op.Result != "failure" || op.HTTPStatus == nil || *op.HTTPStatus != 401 || op.Action != "清空运行日志" {
		t.Errorf("401 也应落 failure 操作日志：%+v", op)
	}
}

// extractPathParams 的段对齐语义（operationDescriptors.test.ts）。
func TestExtractPathParams(t *testing.T) {
	cases := []struct {
		template string
		concrete string
		want     map[string]string
	}{
		{"/a/:id", "/a/k-2", map[string]string{"id": "k-2"}},
		{"/a/:a/b/:c", "/a/1/b/2", map[string]string{"a": "1", "c": "2"}},
		{"/a/:mid/z", "/a/x/z", map[string]string{"mid": "x"}},
		{"/a/:id/", "/a/k-2", map[string]string{"id": "k-2"}},
		{"/a/b", "/a/b", map[string]string{}},
		{"/a/:id", "/a", map[string]string{}},
		{"/a/:id", "/a/b/c", map[string]string{"id": "b"}},
		{"/a/*/z", "/a/x/z", map[string]string{}},
	}
	for _, tc := range cases {
		got := extractPathParams(tc.template, tc.concrete)
		if len(got) != len(tc.want) {
			t.Errorf("extractPathParams(%q, %q) = %v, want %v", tc.template, tc.concrete, got, tc.want)
			continue
		}
		for key, value := range tc.want {
			if got[key] != value {
				t.Errorf("extractPathParams(%q, %q)[%q] = %q, want %q", tc.template, tc.concrete, key, got[key], value)
			}
		}
	}
}

// 影子匹配的 chi 行为假设：参数路由命中给模板与参数、方法不符不命中、通配不在表内。
func TestShadowMatch(t *testing.T) {
	key, desc, params, ok := shadowMatch("PUT", "/api/security/ssh/port")
	if !ok || key != "PUT /api/security/ssh/port" || desc == nil || desc.action != "修改 SSH 监听端口" {
		t.Fatalf("静态路由影子匹配不符：%q %+v", key, desc)
	}
	key, _, params, ok = shadowMatch("DELETE", "/api/security/ssh/keys/k-9")
	if !ok || key != "DELETE /api/security/ssh/keys/:id" || params["id"] != "k-9" {
		t.Fatalf("参数路由影子匹配不符：%q %v", key, params)
	}
	if _, _, _, ok = shadowMatch("GET", "/api/security/ssh/port"); ok {
		t.Errorf("方法不符不应命中")
	}
	if _, _, _, ok = shadowMatch("PUT", "/api/security/ssh/nope"); ok {
		t.Errorf("未知路径不应命中")
	}
	if _, _, _, ok = shadowMatch("POST", "/api/security/ssh/port"); ok {
		t.Errorf("方法不匹配的静态路由不应命中")
	}
	// 描述符表完整性：每键可拆 METHOD 与路径、category 合法、action 非空、无通配。
	for key, desc := range operationDescriptors {
		method, path, okSplit := splitDescriptorKey(key)
		if !okSplit || method == "" || path == "" || !strings.HasPrefix(path, "/") {
			t.Errorf("键形不合法：%q", key)
		}
		if strings.Contains(path, "*") {
			t.Errorf("键不得含通配：%q", key)
		}
		if !containsString(operationLogCategories, desc.category) || desc.action == "" {
			t.Errorf("描述符字段不合法：%q %+v", key, desc)
		}
		if method != "POST" && method != "PUT" && method != "DELETE" && method != "PATCH" {
			t.Errorf("键方法不合法：%q", key)
		}
	}
	// 凭据端点不声明 summarize（结构性不读体）。
	for _, key := range []string{
		"POST /api/security/ssh/root-password",
		"POST /api/security/users",
		"PUT /api/security/users/:id",
		"POST /api/websites",
		"PUT /api/websites/:id/access",
		"POST /api/auth/login",
		"POST /api/auth/password",
	} {
		if desc := operationDescriptors[key]; desc == nil || desc.summarize != nil {
			t.Errorf("凭据端点不得声明 summarize：%q", key)
		}
	}
	// 日志清空两条在表。
	for _, key := range []string{"POST /api/logs/runtime/clear", "POST /api/logs/operation/clear"} {
		if operationDescriptors[key] == nil {
			t.Errorf("清空键缺失：%q", key)
		}
	}
}

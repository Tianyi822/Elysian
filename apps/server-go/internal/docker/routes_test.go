package docker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// routes 对等测试（dockerRoutes.test.ts 锚点：两段 503、透传、同源、404 剥前缀、
// NDJSON 三帧、终端升级守卫链、SSE 次序）。

func readyRouter() (chiRouter, *fakeEngine) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == "GET" && call.Path == "/containers/json":
			return 200, listOf(summaryOf(strings.Repeat("c", 64))), true
		case call.Method == "GET" && call.Path == "/containers/create":
			return 201, `{"Id":"` + strings.Repeat("e", 64) + `"}`, true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/containers/"):
			return 200, containerInspectForStatus("running"), true
		case call.Method == "GET" && call.Path == "/images/json":
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		case call.Method == "GET" && call.Path == "/images/search":
			return 200, `[{"name":"nginx"},{"name":"redis"}]`, true
		case call.Method == "GET" && call.Path == "/images/tags":
			return 200, `{"tags":["latest"]}`, true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/images/"):
			return 200, imageInspectJSON(imageIDConst), true
		case call.Method == "POST" && (strings.HasSuffix(call.Path, "/stop") || strings.HasSuffix(call.Path, "/start") || strings.HasSuffix(call.Path, "/restart")):
			return 204, "", true
		case call.Method == "POST" && call.Path == "/containers/create":
			return 201, `{"Id":"` + strings.Repeat("e", 64) + `"}`, true
		case call.Method == "DELETE" && strings.HasPrefix(call.Path, "/containers/"):
			return 204, "", true
		case call.Method == "DELETE" && strings.HasPrefix(call.Path, "/images/"):
			return 200, "", true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	hub := newEventsHub(eventsHubConfig{transport: engine, bootID: "boot-r"})
	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		eventsHub:    hub,
		transport:    engine,
		execSessions: newExecSessionsWithFakeKit(engine),
	})
	return router, engine
}

// chiRouter 只是 *chi.Mux 的测试别名，避免直接 import chi 到测试断言里。
type chiRouter = http.Handler

func doGet(router http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	for key, value := range headers {
		if key == "Host" {
			request.Host = value
			continue
		}
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func doWrite(router http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	for key, value := range headers {
		if key == "Host" {
			request.Host = value
			continue
		}
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func sameOriginHeaders() map[string]string {
	return map[string]string{
		"Origin": "http://127.0.0.1:48101",
		"Host":   "127.0.0.1:48101",
	}
}

func TestRoutesBoth503Gates(t *testing.T) {
	unavailable := newRouter(routerDeps{available: false})
	recorder := doGet(unavailable, "/status", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"真实容器管理仅在 Docker 容器内可用"}` {
		t.Fatalf("第一段 503：%d %s", recorder.Code, recorder.Body.String())
	}
	// 未知路径与方法同样第一段 503。
	recorder = doWrite(unavailable, http.MethodPost, "/nope", "", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"真实容器管理仅在 Docker 容器内可用"}` {
		t.Fatalf("未知路径 503：%d %s", recorder.Code, recorder.Body.String())
	}

	notReady := newRouter(routerDeps{available: true, socketReady: false})
	recorder = doGet(notReady, "/status", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"Docker 服务未就绪：无法连接 Docker socket"}` {
		t.Fatalf("第二段 503 缺省原因：%d %s", recorder.Code, recorder.Body.String())
	}
	notReady = newRouter(routerDeps{available: true, socketReady: false, socketUnavailableReason: "Docker Engine API 版本过低，需要 1.41 及以上"})
	recorder = doGet(notReady, "/status", nil)
	if recorder.Body.String() != `{"error":"Docker 服务未就绪：Docker Engine API 版本过低，需要 1.41 及以上"}` {
		t.Fatalf("第二段 503 注入原因：%s", recorder.Body.String())
	}
}

func TestRoutesBasicPassthrough(t *testing.T) {
	router, _ := readyRouter()
	recorder := doGet(router, "/status", nil)
	if recorder.Code != 200 || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("status：%d %s", recorder.Code, recorder.Body.String())
	}

	recorder = doGet(router, "/containers", nil)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"containers":[{`) {
		t.Fatalf("containers：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doGet(router, "/images", nil)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"images":[{`) {
		t.Fatalf("images：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doGet(router, "/policy", nil)
	if recorder.Body.String() != `{"mountRoot":"/srv","reservedPorts":[22,48100,48101]}` {
		t.Fatalf("policy：%s", recorder.Body.String())
	}
	recorder = doGet(router, "/images/search?term=nginx", nil)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"searchable":true`) {
		t.Fatalf("search：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doGet(router, "/images/tags?name=nginx", nil)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"tags":[`) {
		t.Fatalf("tags：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesCrossOriginWrite403(t *testing.T) {
	router, _ := readyRouter()
	recorder := doWrite(router, http.MethodPost, "/containers", `{}`, nil)
	if recorder.Code != 403 || recorder.Body.String() != `{"error":"请求来源不允许"}` {
		t.Fatalf("跨源写 403：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodPost, "/containers", `{}`, map[string]string{
		"Origin": "http://evil.example", "Host": "127.0.0.1:48101",
	})
	if recorder.Code != 403 {
		t.Fatalf("Origin 与 Host 不一致 403：%d", recorder.Code)
	}
}

func TestRoutesPostCreate201(t *testing.T) {
	router, _ := readyRouter()
	body := `{"imageId":"` + imageIDConst + `","name":"web-9"}`
	recorder := doWrite(router, http.MethodPost, "/containers", body, sameOriginCTHeaders())
	if recorder.Code != 201 {
		t.Fatalf("201：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesInvalidIDAnd404(t *testing.T) {
	router, _ := readyRouter()
	recorder := doWrite(router, http.MethodPost, "/containers/%24bad/start", "", sameOriginHeaders())
	if recorder.Code != 400 || recorder.Body.String() != `{"error":"容器 ID 格式无效"}` {
		t.Fatalf("非法 id 400：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodDelete, "/images/%24bad", "", sameOriginHeaders())
	if recorder.Body.String() != `{"error":"镜像 ID 格式无效"}` {
		t.Fatalf("镜像 id：%s", recorder.Body.String())
	}
	recorder = doGet(router, "/unknown", nil)
	if recorder.Code != 404 || recorder.Body.String() != `{"error":"未知容器管理端点：GET /unknown"}` {
		t.Fatalf("404 剥前缀：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodPut, "/containers", "", sameOriginHeaders())
	if recorder.Code != 404 || !strings.Contains(recorder.Body.String(), "未知容器管理端点：PUT /containers") {
		t.Fatalf("405 归 404 文案：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesAction200AndDelete204(t *testing.T) {
	router, _ := readyRouter()
	recorder := doWrite(router, http.MethodPost, "/containers/"+strings.Repeat("c", 64)+"/stop", "", sameOriginHeaders())
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"status":"running"`) {
		t.Fatalf("动作 200：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodDelete, "/containers/"+strings.Repeat("c", 64), "", sameOriginHeaders())
	if recorder.Code != 204 || recorder.Body.String() != "" {
		t.Fatalf("DELETE 204 无体：%d %q", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodDelete, "/images/"+strings.Repeat("f", 64), "", sameOriginHeaders())
	if recorder.Code != 204 {
		t.Fatalf("删镜像 204：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesPullAndStream(t *testing.T) {
	listCalls := 0
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == "GET" && call.Path == "/images/json":
			listCalls++
			if listCalls == 1 {
				return 200, "[]", true
			}
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/images/"):
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
	engine.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if call.Path == "/images/create" {
			body := []byte("{\"status\":\"Download complete\"}\n")
			if onChunk != nil {
				onChunk(body)
			}
			return seam.EngineResponse{Status: 200, Body: body}, nil
		}
		return engine.Request(ctx, seam.EngineRequest{Method: call.Method, Path: call.Path, Query: call.Query})
	}
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		eventsHub:    newEventsHub(eventsHubConfig{transport: engine, bootID: "boot-p"}),
		transport:    engine,
		execSessions: newExecSessionsWithFakeKit(engine),
	})
	recorder := doWrite(router, http.MethodPost, "/images/pull", `{"name":"nginx","tag":"1.27"}`, sameOriginCTHeaders())
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"name":"nginx"`) {
		t.Fatalf("pull 200：%d %s", recorder.Code, recorder.Body.String())
	}

	// pull/stream 用全新 engine（拉取单飞与已存在判定按镜像名，重用会撞 400）。
	listCalls2 := 0
	engine2 := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == "GET" && call.Path == "/images/json":
			listCalls2++
			if listCalls2 == 1 {
				return 200, "[]", true
			}
			return 200, listOf(`{"Id":"sha256:` + imageIDConst + `"}`), true
		case call.Method == "GET" && strings.HasPrefix(call.Path, "/images/"):
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
	engine2.streamFn = func(ctx context.Context, call engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if call.Path == "/images/create" {
			body := []byte("{\"status\":\"Download complete\"}\n")
			if onChunk != nil {
				onChunk(body)
			}
			return seam.EngineResponse{Status: 200, Body: body}, nil
		}
		return engine2.Request(ctx, seam.EngineRequest{Method: call.Method, Path: call.Path, Query: call.Query})
	}
	service2 := newService(engine2, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	router = newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service2,
		eventsHub:    newEventsHub(eventsHubConfig{transport: engine2, bootID: "boot-q"}),
		transport:    engine2,
		execSessions: newExecSessionsWithFakeKit(engine2),
	})
	recorder = doWrite(router, http.MethodPost, "/images/pull/stream", `{"name":"nginx","tag":"1.27"}`, sameOriginCTHeaders())
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	if recorder.Code != 200 || len(lines) != 2 {
		t.Fatalf("ndjson 两帧：%d %d %s", recorder.Code, len(lines), recorder.Body.String())
	}
	if !strings.HasPrefix(lines[0], `{"type":"progress","progress":{`) {
		t.Fatalf("progress 先于 result：%s", lines[0])
	}
	if !strings.Contains(lines[1], `{"type":"result","image":{`) {
		t.Fatalf("result 帧：%s", lines[1])
	}
	if recorder.Header().Get("Content-Type") != "application/x-ndjson; charset=utf-8" {
		t.Fatalf("Content-Type：%q", recorder.Header().Get("Content-Type"))
	}

	recorder = doWrite(router, http.MethodPost, "/images/pull/stream", `{"name":"nginx","tag":"1","auth":{}}`, sameOriginCTHeaders())
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `{"type":"error","error":"不支持私有仓库认证"}`) {
		t.Fatalf("error 帧：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesTerminalGuardChain(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			if strings.Contains(call.Path, strings.Repeat("e", 64)) {
				return 404, `{"message":"No such container"}`, true
			}
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		transport:    engine,
		execSessions: newExecSessionsWithFakeKit(engine),
	})
	// 无 Origin 403。
	recorder := doGet(router, "/containers/"+strings.Repeat("c", 64)+"/terminal", nil)
	if recorder.Code != 403 || recorder.Body.String() != `{"error":"请求来源不允许"}` {
		t.Fatalf("无 Origin 403：%d %s", recorder.Code, recorder.Body.String())
	}
	// 非法 id 400（带同源头）。
	recorder = doGet(router, "/containers/%24bad/terminal", sameOriginHeaders())
	if recorder.Code != 400 || recorder.Body.String() != `{"error":"容器 ID 格式无效"}` {
		t.Fatalf("非法 id 400：%d %s", recorder.Code, recorder.Body.String())
	}
	// 不存在 404。
	recorder = doGet(router, "/containers/"+strings.Repeat("e", 64)+"/terminal", sameOriginHeaders())
	if recorder.Code != 404 || recorder.Body.String() != `{"error":"容器不存在"}` {
		t.Fatalf("404：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesTerminalPaused409AndAudit(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			return 200, containerInspectForStatus("paused"), true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	logs := &captureLogs{}
	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		transport:    engine,
		execSessions: newExecSessionsWithFakeKit(engine),
		logs:         logs,
	})
	recorder := doGet(router, "/containers/"+strings.Repeat("c", 64)+"/terminal", sameOriginHeaders())
	if recorder.Code != 409 || recorder.Body.String() != `{"error":"只有运行中的容器可以打开终端"}` {
		t.Fatalf("paused 409：%d %s", recorder.Code, recorder.Body.String())
	}
	if len(logs.operations) != 0 {
		t.Fatalf("升级前拒绝不记审计：%+v", logs.operations)
	}
}

func TestRoutesSSEFirstSubscribeSequenceAndLimit(t *testing.T) {
	router, _ := readyRouter()
	// 首订阅：pending 队列保证 connecting → resync → live 先于 retry 之后冲出；
	// 100ms 后取消请求上下文以收流。
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	router.ServeHTTP(recorder, request)
	body := recorder.Body.String()
	retryEnd := strings.Index(body, "retry: 3000\n\n")
	if retryEnd != 0 {
		t.Fatalf("首帧 retry：%q", body[:min(40, len(body))])
	}
	rest := body[retryEnd+len("retry: 3000\n\n"):]
	if !strings.HasPrefix(rest, sseStatusConn) {
		t.Fatalf("connecting 状态注释帧：%q", rest[:min(40, len(rest))])
	}
	after := rest[len(sseStatusConn):]
	if !strings.HasPrefix(after, "event: container/resync\n") {
		t.Fatalf("resync 帧：%q", after[:min(60, len(after))])
	}
	if !strings.Contains(after[1:], sseStatusLive) {
		t.Fatalf("live 状态注释帧：%q", after)
	}
	if !strings.Contains(body, "event: container/resync\nid: boot-r.1\ndata: ") {
		t.Fatalf("帧格式 event/id/data：%q", body)
	}
}

func TestRoutesSSENinthConnection503(t *testing.T) {
	// hub 满 8 订阅时第 9 条 503。
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	hub := newEventsHub(eventsHubConfig{transport: engine, bootID: "boot-s"})
	for i := 0; i < 8; i++ {
		if _, err := hub.Subscribe(hubHandlers{onEvent: func(string, string, string) {}, onStatus: func(string) {}}); err != nil {
			t.Fatal(err)
		}
	}
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	router := newRouter(routerDeps{available: true, socketReady: true, service: service, eventsHub: hub})
	recorder := doGet(router, "/events", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"实时连接数已达上限"}` {
		t.Fatalf("第 9 连接 503：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRoutesBodyGuardErrors(t *testing.T) {
	router, _ := readyRouter()
	recorder := doWrite(router, http.MethodPost, "/containers", `{}`, map[string]string{
		"Origin": "http://127.0.0.1:48101", "Host": "127.0.0.1:48101", "Content-Type": "text/plain",
	})
	if recorder.Code != 415 || recorder.Body.String() != `{"error":"Content-Type 必须为 application/json"}` {
		t.Fatalf("415：%d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doWrite(router, http.MethodPost, "/containers", "not-json", sameOriginCTHeaders())
	if recorder.Code != 400 || recorder.Body.String() != `{"error":"请求体不是有效 JSON"}` {
		t.Fatalf("400：%d %s", recorder.Code, recorder.Body.String())
	}
}

func sameOriginCTHeaders() map[string]string {
	headers := sameOriginHeaders()
	headers["Content-Type"] = "application/json"
	return headers
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// captureLogs seam.Logs 记录器。
type captureLogs struct {
	mu         sync.Mutex
	operations []seam.OperationRecord
	runtimes   []string
}

func (c *captureLogs) Runtime(level, source, message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.runtimes = append(c.runtimes, level+":"+message)
}

func (c *captureLogs) RecordOperation(rec seam.OperationRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.operations = append(c.operations, rec)
}

func TestRoutesTerminalUpgradeAudit(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasSuffix(call.Path, "/json") {
			return 200, containerInspectForStatus("running"), true
		}
		return 0, "", false
	})
	service := newService(engine, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
	logs := &captureLogs{}
	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		transport:    engine,
		execSessions: newExecSessionsWithFakeKit(engine),
		logs:         logs,
	})
	// 升级需要真实 WS 握手：httptest 不便驱动 gorilla 升级，改为断言升级前审计已按
	// 200 登记（TS 版在 recordPanelOperation 之后才升级）。用伪装 Upgrade 请求驱动
	// 到升级一步：gorilla 拒绝非 WS 握手，handler 返回且审计已落。
	recorder := doGet(router, "/containers/"+strings.Repeat("c", 64)+"/terminal", sameOriginHeaders())
	_ = recorder
	if len(logs.operations) != 1 {
		t.Fatalf("升级路径应记审计：%+v", logs.operations)
	}
	rec := logs.operations[0]
	if rec.Category != "containers" || rec.Action != "打开容器终端" || rec.Target == nil || *rec.Target != "容器 "+strings.Repeat("c", 64) {
		t.Fatalf("审计字段：%+v", rec)
	}
	if rec.Method != "GET" || rec.Path != shared.DockerMount+"/containers/"+strings.Repeat("c", 64)+"/terminal" {
		t.Fatalf("审计 method/path：%+v", rec)
	}
	if rec.HTTPStatus == nil || *rec.HTTPStatus != 200 || rec.Result != "success" {
		t.Fatalf("审计 status/result：%+v", rec)
	}
}

// newExecSessionsWithFakeKit 用最简 fake TerminalKit 装配 exec 会话表。
func newExecSessionsWithFakeKit(engine *fakeEngine) *execSessions {
	return newExecSessions(execSessionsConfig{
		kit: &fakeTerminalKit{},
		createExecRunner: func(containerID string) execRunner {
			return createContainerExecRunner("/nonexistent.sock", containerID)
		},
		identityForContainer: func(containerID string) seam.TerminalIdentity {
			return seam.TerminalIdentity{User: "root", HostLabel: containerID[:13], HomeDir: "/"}
		},
		listDir:      func(string, string) ([]string, error) { return nil, nil },
		listCommands: func(string, shellKind) ([]string, error) { return nil, nil },
	})
}

// fakeTerminalKit 会话机替身：TryOpen 恒成功（会话编排行为归 terminals 域测试）。
type fakeTerminalKit struct{}

func (k *fakeTerminalKit) NewService(deps seam.TerminalHostDeps, spec seam.ShellSessionSpec,
	identity func() seam.TerminalIdentity, maxSessions int) seam.TerminalsService {
	return &fakeTerminalsService{}
}

func (k *fakeTerminalKit) NewTotalLimitedService(inner seam.TerminalsService, getActive func() int, max int) seam.TerminalsService {
	return inner
}

func (k *fakeTerminalKit) NewConnEvents(svc seam.TerminalsService, revocation seam.SessionConnections, sessionID string) seam.TerminalConnEvents {
	return &fakeConnEvents{}
}

type fakeTerminalsService struct{}

func (s *fakeTerminalsService) TryOpen() (seam.TerminalSession, bool) { return &fakeSession{}, true }
func (s *fakeTerminalsService) ActiveCount() int                      { return 0 }

type fakeSession struct{}

func (s *fakeSession) ID() string { return "fake" }

type fakeConnEvents struct{}

func (e *fakeConnEvents) OnOpen(conn seam.WsConn)              {}
func (e *fakeConnEvents) OnMessage(conn seam.WsConn, t []byte) {}
func (e *fakeConnEvents) OnClose()                             {}

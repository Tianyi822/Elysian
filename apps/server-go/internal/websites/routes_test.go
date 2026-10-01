package websites

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
)

// 路由片（websitesRoutes.test.ts 4 例 + 守卫链次序的 Go 对等）。

// fakeService 路由层服务假件：记录调用并回放固定结果。
type fakeService struct {
	mu             sync.Mutex
	runtimeCalls   int
	createInput    *createRequest
	setAccessID    string
	setAccessInput *accessInput
	runningInput   map[string]bool
	removeID       string
}

func (s *fakeService) RuntimeCatalog(context.Context) (runtimeCatalogReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runtimeCalls++
	return runtimeReportFixture(), nil
}

func (s *fakeService) List(context.Context) (websiteListReport, error) {
	return websiteListReport{Projects: []websiteProject{}, Proxy: websiteProxyStatus{State: ProxyStateActive}}, nil
}

func (s *fakeService) Create(_ context.Context, input createRequest) (mutateResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.createInput = &input
	return mutateResult{Project: websiteProject{ID: "p", Kind: input.Kind, Name: input.Name, Port: input.Port}}, nil
}

func (s *fakeService) Update(context.Context, string, updateRequest) (websiteProject, error) {
	return websiteProject{}, nil
}

func (s *fakeService) SetAccess(_ context.Context, id string, access accessInput) (mutateResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setAccessID = id
	s.setAccessInput = &access
	return mutateResult{Project: websiteProject{ID: id}}, nil
}

func (s *fakeService) SetRunning(_ context.Context, id string, running bool) (websiteProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runningInput == nil {
		s.runningInput = map[string]bool{}
	}
	s.runningInput[id] = running
	return websiteProject{ID: id}, nil
}

func (s *fakeService) Logs(context.Context, string) ([]string, error) {
	return []string{"日志"}, nil
}

func (s *fakeService) Remove(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeID = id
	return nil
}

func (s *fakeService) ReconcileProxy(context.Context) (websiteProxyStatus, error) {
	return websiteProxyStatus{State: ProxyStateActive, Detail: nil}, nil
}

// newMountedRouter 可用态路由：直接挂 fake service（等价 TS createWebsitesApp({available:true, service})）。
func newMountedRouter(service *fakeService) http.Handler {
	router := chi.NewRouter()
	mountService(router, service)
	return router
}

// doRequest 发送 JSON 请求（Host 固定 localhost，同源判定经回环名单）。
func doRequest(handler http.Handler, method, path, origin, contentType, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Host = "localhost"
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func errorOf(recorder *httptest.ResponseRecorder) string {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return body.Error
}

func TestRouterUnavailableAlways503(t *testing.T) {
	router := NewRouter(Deps{})
	for _, item := range []struct{ method, path string }{
		{http.MethodGet, "/api/websites"},
		{http.MethodPost, "/api/websites"},
		{http.MethodGet, "/api/websites/unknown"},
	} {
		request := httptest.NewRequest(item.method, item.path, nil)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s 应整片 503，得到 %d", item.method, item.path, recorder.Code)
		}
		if got := errorOf(recorder); got != "真实网站管理仅在 Docker 环境可用" {
			t.Fatalf("503 文案不符：%s", got)
		}
	}
}

func TestRouterRuntimesNoStore(t *testing.T) {
	service := &fakeService{}
	recorder := doRequest(newMountedRouter(service), http.MethodGet, "/runtimes", "", "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("版本端点应禁浏览器缓存")
	}
	if !strings.Contains(recorder.Body.String(), `"fetchedAt":"2026-09-30T00:00:00.000Z"`) {
		t.Fatalf("应返回动态目录：%s", recorder.Body.String())
	}
	if service.runtimeCalls != 1 {
		t.Fatalf("runtimeCatalog 应恰被调用一次，得到 %d", service.runtimeCalls)
	}
}

func TestRouterCreateDefaultsHTMLCommand(t *testing.T) {
	service := &fakeService{}
	recorder := doRequest(newMountedRouter(service), http.MethodPost, "/", "http://localhost", "application/json",
		`{"kind":"html","name":"site","port":8080,"access":{"mode":"direct"}}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("创建应 201，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	input := service.createInput
	if input == nil || input.Access.Mode != AccessModeDirect {
		t.Fatalf("应解析访问模式")
	}
	if input.Command != "nginx -g daemon off;" {
		t.Fatalf("HTML 应落缺省命令，得到 %q", input.Command)
	}
}

func TestRouterAccessEndpointAndLegacy404(t *testing.T) {
	service := &fakeService{}
	router := newMountedRouter(service)
	recorder := doRequest(router, http.MethodPut, "/p/access", "http://localhost", "application/json", `{"mode":"direct"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("访问端点应 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if service.setAccessID != "p" || service.setAccessInput == nil || service.setAccessInput.Mode != AccessModeDirect {
		t.Fatalf("应按 id 调 setAccess")
	}
	// 旧域名端点已不存在 → 404（Hono/chi 缺省兜底）。
	old := doRequest(router, http.MethodPut, "/p/domain", "http://localhost", "application/json", `{"domain":null}`)
	if old.Code != http.StatusNotFound {
		t.Fatalf("旧域名端点应 404，得到 %d", old.Code)
	}
}

func TestRouterAccessCertificateHalfRejected(t *testing.T) {
	recorder := doRequest(newMountedRouter(&fakeService{}), http.MethodPut, "/p/access", "http://localhost", "application/json",
		`{"mode":"domain","domain":"example.com","certificatePem":"cert"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("证书材料缺一应 400，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if got := errorOf(recorder); got != "请同时上传证书链和私钥" {
		t.Fatalf("文案不符：%s", got)
	}
}

func TestRouterGuardChain(t *testing.T) {
	router := newMountedRouter(&fakeService{})
	// 同源：写请求缺 Origin → 403 先于读体。
	recorder := doRequest(router, http.MethodPost, "/", "", "application/json", `{"kind":"html"}`)
	if recorder.Code != http.StatusForbidden || errorOf(recorder) != "请求来源不允许" {
		t.Fatalf("跨源写应 403，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	// 415：Content-Type 不符。
	recorder = doRequest(router, http.MethodPost, "/", "http://localhost", "text/plain", `{}`)
	if recorder.Code != http.StatusUnsupportedMediaType || errorOf(recorder) != "Content-Type 必须为 application/json" {
		t.Fatalf("Content-Type 不符应 415，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	// 400：空体。
	recorder = doRequest(router, http.MethodPost, "/", "http://localhost", "application/json", "")
	if recorder.Code != http.StatusBadRequest || errorOf(recorder) != "请求体不能为空" {
		t.Fatalf("空体应 400，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	// 404：未知路径（本域缺省兜底）。
	recorder = doRequest(router, http.MethodGet, "/nope", "", "", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知路径应 404，得到 %d", recorder.Code)
	}
}

func TestRouterRunningBoolAndDeleteConfirm(t *testing.T) {
	service := &fakeService{}
	router := newMountedRouter(service)
	recorder := doRequest(router, http.MethodPost, "/p/running", "http://localhost", "application/json", `{"running":"yes"}`)
	if recorder.Code != http.StatusBadRequest || errorOf(recorder) != "启停状态须为布尔值" {
		t.Fatalf("非布尔 running 应 400，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doRequest(router, http.MethodPost, "/p/running", "http://localhost", "application/json", `{"running":true}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("启停应 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if !service.runningInput["p"] {
		t.Fatalf("应按 body.running 调 setRunning")
	}
	recorder = doRequest(router, http.MethodDelete, "/p", "http://localhost", "application/json", `{"confirm":"NOPE"}`)
	if recorder.Code != http.StatusBadRequest || errorOf(recorder) != "必须确认删除站点及数据" {
		t.Fatalf("缺确认应 400，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = doRequest(router, http.MethodDelete, "/p", "http://localhost", "application/json", `{"confirm":"DELETE_WEBSITE_AND_DATA"}`)
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("确认后应 200 {ok:true}，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	if service.removeID != "p" {
		t.Fatalf("应按 id 调 remove")
	}
}

func TestRouterLogsHeadersAndReconcile(t *testing.T) {
	router := newMountedRouter(&fakeService{})
	recorder := doRequest(router, http.MethodGet, "/p/logs", "", "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("日志应 200，得到 %d", recorder.Code)
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("日志端点应带 no-store/no-cache 头")
	}
	if !strings.Contains(recorder.Body.String(), `"logs":["日志"]`) {
		t.Fatalf("日志响应形状不符：%s", recorder.Body.String())
	}
	recorder = doRequest(router, http.MethodPost, "/proxy/reconcile", "http://localhost", "application/json", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("对账应 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Proxy   websiteProxyStatus `json:"proxy"`
		Applied bool               `json:"applied"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("对账响应应为 JSON：%v", err)
	}
	if !body.Applied || body.Proxy.State != ProxyStateActive || body.Proxy.Detail != nil {
		t.Fatalf("applied 派生布尔不符：%+v", body)
	}
}

package terminals

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 终端路由的守卫链测试（盘点 §8.5 对等移植）：503 整片（含未知路径）、/status 200、
// /ws 升级前同源校验矩阵、未知路径 404 剥前缀文案、操作日志记录与撤销接线。
// 升级路径用真实 gorilla 握手（httptest.Server 支持劫持），对齐 TS 版经 mocked
// upgradeWebSocket 验证传参的锚点。

// mountedRouter 按装配层形态挂到 shared.TerminalMount（不可用时走 503 分支）。
func mountedRouter(deps Deps, svc serviceApi) chi.Router {
	var sub chi.Router
	if !deps.Available {
		sub = unavailableRouter()
	} else {
		sub = newRouterWithService(deps, svc)
	}
	parent := chi.NewRouter()
	parent.Mount(shared.TerminalMount, sub)
	return parent
}

func doRequest(t *testing.T, handler http.Handler, method, path string, header map[string]string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(method, "http://localhost:5173"+path, nil)
	// 与 TS 版测试的 req() 同口径：缺省带同源头（Origin 与 Host 一致）；显式传
	// 空串表示删除该头（Origin 缺失用例）。
	req.Header.Set("Origin", "http://localhost:5173")
	for k, v := range header {
		if v == "" {
			req.Header.Del(k)
			continue
		}
		req.Header.Set(k, v)
	}
	// httptest.NewRequest 以 URL 推 Host；显式 Host 用例经 req.Header["Host"] 覆盖。
	if hosts := req.Header.Values("Host"); len(hosts) > 0 {
		req.Host = hosts[0]
		req.Header.Del("Host")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func Test不可用时一律503(t *testing.T) {
	handler := mountedRouter(Deps{Available: false}, upgradableService{})
	for _, tc := range []struct{ method, path string }{
		{"GET", "/status"},
		{"GET", "/ws"},
		{"POST", "/ws"},
		{"GET", "/nowhere"},
	} {
		code, body := doRequest(t, handler, tc.method, shared.TerminalMount+tc.path, nil)
		if code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s = %d，期望 503", tc.method, tc.path, code)
		}
		if body != `{"error":"真实终端仅在 Docker 容器内可用"}` {
			t.Fatalf("%s %s 文案 = %s", tc.method, tc.path, body)
		}
	}
}

func TestStatus可用时返回200OK(t *testing.T) {
	handler := mountedRouter(Deps{Available: true}, upgradableService{})
	code, body := doRequest(t, handler, "GET", shared.TerminalMount+"/status", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d，期望 200", code)
	}
	if body != `{"ok":true}` {
		t.Fatalf("status 体 = %s", body)
	}
}

func TestWs升级前置同源校验矩阵(t *testing.T) {
	handler := mountedRouter(Deps{Available: true}, upgradableService{})
	cases := []struct {
		name   string
		header map[string]string
	}{
		{"Origin 缺失即拒", map[string]string{"Origin": ""}},
		{"Origin host 与 Host 不一致", map[string]string{"Origin": "http://evil.example"}},
		{"Origin 端口与 Host 不一致", map[string]string{"Origin": "http://localhost:9999"}},
		{"Host hostname 不在回环名单（rebinding 形）", map[string]string{
			"Host": "evil.example:5173", "Origin": "http://evil.example:5173"}},
		{"Host 是畸形值", map[string]string{"Host": "http://a b", "Origin": "http://a b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body := doRequest(t, handler, "GET", shared.TerminalMount+"/ws", tc.header)
			if code != http.StatusForbidden {
				t.Fatalf("= %d，期望 403", code)
			}
			if body != `{"error":"请求来源不允许"}` {
				t.Fatalf("文案 = %s", body)
			}
		})
	}
}

func Test未知路径404且文案剥挂载前缀(t *testing.T) {
	handler := mountedRouter(Deps{Available: true}, upgradableService{})
	code, body := doRequest(t, handler, "GET", shared.TerminalMount+"/nowhere", nil)
	if code != http.StatusNotFound {
		t.Fatalf("= %d，期望 404", code)
	}
	if body != `{"error":"未知终端端点：GET /nowhere"}` {
		t.Fatalf("文案 = %s", body)
	}
}

func Test同源写方法打已知路径落404剥前缀(t *testing.T) {
	handler := mountedRouter(Deps{Available: true}, upgradableService{})
	code, body := doRequest(t, handler, "POST", shared.TerminalMount+"/ws", nil)
	if code != http.StatusNotFound {
		t.Fatalf("= %d，期望 404", code)
	}
	if body != `{"error":"未知终端端点：POST /ws"}` {
		t.Fatalf("文案 = %s", body)
	}
}

func Test跨源写未知路径先403后404(t *testing.T) {
	handler := mountedRouter(Deps{Available: true}, upgradableService{})
	code, body := doRequest(t, handler, "POST", shared.TerminalMount+"/nowhere", map[string]string{"Origin": ""})
	if code != http.StatusForbidden {
		t.Fatalf("= %d，期望 403", code)
	}
	if body != `{"error":"请求来源不允许"}` {
		t.Fatalf("文案 = %s", body)
	}
}

func TestWs升级记操作日志(t *testing.T) {
	logs := &fakeLogs{}
	handler := mountedRouter(Deps{Available: true, Logs: logs}, upgradableService{})
	// 无 Upgrade 头：gorilla 以 400 回绝，但操作日志发生在升级之前（盘点 §2.2：
	// 记录必须在升级之前，升级之后没有 HTTP 响应可挂）。
	code, _ := doRequest(t, handler, "GET", shared.TerminalMount+"/ws", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("无 Upgrade 头 = %d，期望 400", code)
	}
	records := logs.snapshot()
	if len(records) != 1 {
		t.Fatalf("操作日志 %d 条，期望恰 1 条", len(records))
	}
	rec := records[0]
	status := 200
	want := seam.OperationRecord{
		Category:   "terminals",
		Action:     "打开本机终端会话",
		Result:     "success",
		Method:     "GET",
		Path:       shared.TerminalMount + "/ws",
		HTTPStatus: &status,
	}
	if rec.Category != want.Category || rec.Action != want.Action || rec.Result != want.Result ||
		rec.Method != want.Method || rec.Path != want.Path || rec.Target != nil || rec.Summary != nil ||
		rec.HTTPStatus == nil || *rec.HTTPStatus != *want.HTTPStatus {
		t.Fatalf("操作日志 = %+v，期望 %+v", rec, want)
	}
	// 403 路径（同源不过）不记日志。
	doRequest(t, handler, "GET", shared.TerminalMount+"/ws", map[string]string{"Origin": ""})
	if got := len(logs.snapshot()); got != 1 {
		t.Fatalf("403 不应记日志，共 %d 条", got)
	}
}

func dialTerminalWs(t *testing.T, handler http.Handler, cookie string) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + shared.TerminalMount + "/ws"
	header := http.Header{}
	header.Set("Origin", srv.URL) // Origin 与 Host（URL 推得）一致，hostname 127.0.0.1 在回环名单
	if cookie != "" {
		header.Set("Cookie", cookie)
	}
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("合法升级失败：%v", err)
	}
	return conn
}

func TestWs合法升级的撤销接线带Cookie(t *testing.T) {
	connections := newTestSessionConnections()
	handler := mountedRouter(Deps{Available: true, SessionConns: connections}, upgradableService{})
	conn := dialTerminalWs(t, handler, "elysian_session=abc")
	defer conn.Close()

	waitFor(t, func() bool { return connections.count("abc") >= 1 }, "onOpen 未登记 closer")
	// revoke 触发 closer：连接以 1008 + 中文 reason 关闭（closer 先自摘再关闭）。
	connections.Revoke("abc")
	_, _, err := conn.ReadMessage()
	closeErr, ok := err.(*websocket.CloseError)
	if !ok || closeErr.Code != seam.SessionRevokedCloseCode || closeErr.Text != seam.SessionRevokedCloseReason {
		t.Fatalf("撤销后应收到 1008 撤销关闭：%v", err)
	}
	if got := connections.count("abc"); got != 0 {
		t.Fatalf("closer 应先自摘，残留 %d", got)
	}
}

func TestWs合法升级不带Cookie不登记(t *testing.T) {
	connections := newTestSessionConnections()
	handler := mountedRouter(Deps{Available: true, SessionConns: connections}, upgradableService{})
	conn := dialTerminalWs(t, handler, "")
	defer conn.Close()
	time.Sleep(100 * time.Millisecond) // OnOpen 在升级后立即执行
	if got := connections.count("abc"); got != 0 {
		t.Fatalf("不带 Cookie 不应登记，得 %d", got)
	}
}

func TestWs合法升级onClose注销closer(t *testing.T) {
	connections := newTestSessionConnections()
	handler := mountedRouter(Deps{Available: true, SessionConns: connections}, upgradableService{})
	conn := dialTerminalWs(t, handler, "elysian_session=abc")
	waitFor(t, func() bool { return connections.count("abc") >= 1 }, "onOpen 未登记 closer")
	_ = conn.Close() // 客户端断开 → 服务端读循环结束 → OnClose 注销
	waitFor(t, func() bool { return connections.count("abc") == 0 }, "onClose 未注销 closer")
	connections.Revoke("abc") // 已注销：不重复关闭
}

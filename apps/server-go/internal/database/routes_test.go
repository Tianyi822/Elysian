package database

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"elysian/server/internal/contract"
	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// databaseRoutes.test.ts 对等测试：HTTP 守卫链、列表合并、审计口径与终端帧检查。

const testSecret = "password-hidden-from-list"

// fakeService 假服务型数据库服务。
type fakeService struct {
	mu                sync.Mutex
	listed            []serviceInstance
	revealed          databaseSecret
	removed           []string
	removedContainers []string
	discovered        []discoveredCall
	createCalled      bool
	revealCalled      bool
	openSession       Session
}

func (f *fakeService) List(context.Context) ([]serviceInstance, error) {
	return f.listed, nil
}

func (f *fakeService) Discover(_ context.Context, engine string, versionTag *string) (discoverResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.discovered = append(f.discovered, discoveredCall{engine: engine, versionTag: versionTag})
	return discoverResult{Images: []contract.ContainerImage{}, Containers: []containerCandidate{}}, nil
}

type discoveredCall struct {
	engine     string
	versionTag *string
}

func (f *fakeService) Create(context.Context, createRequest) (createResponse, error) {
	f.createCalled = true
	return createResponse{}, nil
}

func (f *fakeService) Reveal(context.Context, string) (databaseSecret, error) {
	f.revealCalled = true
	return f.revealed, nil
}

func (f *fakeService) Remove(_ context.Context, id string) error {
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeService) RemoveContainer(_ context.Context, id string) error {
	f.removedContainers = append(f.removedContainers, id)
	return nil
}

func (f *fakeService) Reconcile(context.Context, string) (serviceInstance, error) {
	return serviceInstance{}, nil
}

func (f *fakeService) Forget(context.Context, string) error { return nil }

func (f *fakeService) OpenSession(context.Context, string) (Session, error) {
	if f.openSession != nil {
		return f.openSession, nil
	}
	return nil, errors.New("session not configured")
}

// fakeSqlite 假 SQLite 托管服务。
type fakeSqlite struct {
	mu        sync.Mutex
	listed    []sqliteInstance
	created   []string
	imported  []string
	removed   []string
	forgetIDs []string
}

func (f *fakeSqlite) List(context.Context) ([]sqliteInstance, error) { return f.listed, nil }

func (f *fakeSqlite) Create(_ context.Context, name any) (sqliteInstance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, name.(string))
	return sqliteInstance{ID: "sqlite-new", Engine: engineSQLite, Name: name.(string)}, nil
}

func (f *fakeSqlite) ImportFile(_ context.Context, name string, _ io.Reader, _ int64, _ string) (sqliteInstance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imported = append(f.imported, name)
	return sqliteInstance{ID: "sqlite-imported", Engine: engineSQLite, Name: name}, nil
}

func (f *fakeSqlite) Download(context.Context, string) (sqliteSnapshot, error) {
	return sqliteSnapshot{}, nil
}

func (f *fakeSqlite) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeSqlite) Reconcile(context.Context, string) (sqliteInstance, bool, error) {
	return sqliteInstance{}, true, nil
}

func (f *fakeSqlite) Forget(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgetIDs = append(f.forgetIDs, id)
	return nil
}

func (f *fakeSqlite) OpenSession(context.Context, string) (Session, error) {
	return nil, errors.New("session not configured")
}

// recordedLog 记录审计调用的假日志。
type recordedLog struct {
	mu   sync.Mutex
	rows []seam.OperationRecord
}

func (l *recordedLog) Runtime(string, string, string) {}

func (l *recordedLog) RecordOperation(rec seam.OperationRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rows = append(l.rows, rec)
}

// routerFixture 组装被测路由。
type routerFixture struct {
	router  chi.Router
	service *fakeService
	sqlite  *fakeSqlite
	logs    *recordedLog
}

func newRouterFixture(service Service, sqlite SqliteService, logs seam.Logs) chi.Router {
	return newRouter(routerDeps{available: true, service: service, sqlite: sqlite, logs: logs})
}

func sameOriginHeaders() map[string]string {
	return map[string]string{"Host": "localhost:48100", "Origin": "http://localhost:48100", "Content-Type": "application/json"}
}

func doRequest(t *testing.T, router chi.Router, method, target string, headers map[string]string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Host = "localhost:48100"
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestDiscoverPassesVersionTag(t *testing.T) {
	service := &fakeService{}
	router := newRouterFixture(service, nil, nil)
	if status := doRequest(t, router, "GET", "/discover?engine=MySQL", nil, nil).Code; status != 200 {
		t.Fatalf("省略 versionTag 应 200，实际 %d", status)
	}
	if len(service.discovered) != 1 || service.discovered[0].engine != "MySQL" || service.discovered[0].versionTag != nil {
		t.Fatalf("discover 参数透传不符：%+v", service.discovered)
	}
	if status := doRequest(t, router, "GET", "/discover?engine=MySQL&versionTag=8.4", nil, nil).Code; status != 200 {
		t.Fatal("带版本查询应 200")
	}
	if service.discovered[1].versionTag == nil || *service.discovered[1].versionTag != "8.4" {
		t.Fatalf("versionTag 应透传 8.4：%+v", service.discovered[1].versionTag)
	}
	if status := doRequest(t, router, "GET", "/discover?engine=Oracle", nil, nil).Code; status != 400 {
		t.Fatal("未知引擎应 400")
	}
}

func TestListMergesServiceThenSqlite(t *testing.T) {
	service := &fakeService{listed: []serviceInstance{{
		ID: "db-1", Engine: engineMySQL, Name: "orders", Version: "8.4", Status: statusRunning,
		UpdatedAt: "2026-09-28T00:00:00.000Z", CredentialUsername: "reader", HasCredentials: boolPtr(true),
	}}}
	files := &fakeSqlite{listed: []sqliteInstance{{
		ID: "sqlite-123", Engine: engineSQLite, Name: "notes", Version: "3.54", Status: statusRunning,
		UpdatedAt: "2026-09-28T00:00:00.000Z", Source: sourceManaged,
	}}}
	router := newRouterFixture(service, files, nil)
	recorder := doRequest(t, router, "GET", "/", nil, nil)
	if recorder.Code != 200 {
		t.Fatalf("列表应 200，实际 %d", recorder.Code)
	}
	var rows []map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &rows) != nil {
		t.Fatal("列表 JSON 解析失败")
	}
	if len(rows) != 2 || rows[0]["engine"] != "MySQL" || rows[1]["engine"] != "SQLite" {
		t.Fatalf("列表应服务型在前 SQLite 在后：%s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), testSecret) {
		t.Fatal("列表不得包含密码")
	}
}

func TestRevealGuardsAndNoStore(t *testing.T) {
	service := &fakeService{revealed: databaseSecret{Username: "reader", Password: testSecret}}
	router := newRouterFixture(service, nil, nil)
	blocked := doRequest(t, router, "POST", "/db-1/reveal", map[string]string{
		"Host": "localhost:48100", "Origin": "http://evil.example", "Content-Type": "application/json",
	}, []byte("{}"))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("跨源 reveal 应 403，实际 %d", blocked.Code)
	}
	revealed := doRequest(t, router, "POST", "/db-1/reveal", sameOriginHeaders(), []byte("{}"))
	if revealed.Code != 200 || revealed.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("reveal 应 200 且 no-store，实际 %d %q", revealed.Code, revealed.Header().Get("Cache-Control"))
	}
	if !strings.Contains(revealed.Body.String(), testSecret) {
		t.Fatal("reveal 应回普通账号凭证")
	}
}

func TestRemoveContainerConfirmGuard(t *testing.T) {
	service := &fakeService{}
	router := newRouterFixture(service, nil, nil)
	headers := sameOriginHeaders()
	denied := doRequest(t, router, "DELETE", "/db-1/container", headers, []byte(`{"confirm":false}`))
	if denied.Code != 400 || !strings.Contains(denied.Body.String(), "必须确认删除容器及全部数据") {
		t.Fatalf("错 confirm 应 400，实际 %d %s", denied.Code, denied.Body.String())
	}
	if len(service.removedContainers) != 0 {
		t.Fatal("错 confirm 不应调用 service")
	}
	accepted := doRequest(t, router, "DELETE", "/db-1/container", headers, []byte(`{"confirm":"DELETE_CONTAINER_AND_DATA"}`))
	if accepted.Code != 200 || len(service.removedContainers) != 1 {
		t.Fatalf("正确 confirm 应 200 并调用 service：%d", accepted.Code)
	}
}

func TestTerminalUpgradeGuards(t *testing.T) {
	logs := &recordedLog{}
	router := newRouterFixture(&fakeService{}, nil, logs)
	denied := doRequest(t, router, "GET", "/db-1/terminal", map[string]string{
		"Host": "localhost:48100", "Origin": "http://evil.example",
	}, nil)
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "请求来源不允许") {
		t.Fatalf("非同源终端 GET 应 403，实际 %d", denied.Code)
	}
	logs.mu.Lock()
	if len(logs.rows) != 1 || logs.rows[0].Category != "database" || logs.rows[0].Action != "发起数据库协议终端连接" ||
		logs.rows[0].Result != "failure" || logs.rows[0].HTTPStatus == nil || *logs.rows[0].HTTPStatus != 403 {
		t.Fatalf("403 拒绝应记 failure/403 审计：%+v", logs.rows)
	}
	logs.mu.Unlock()

	logs = &recordedLog{}
	router = newRouterFixture(nil, &fakeSqlite{}, logs)
	unavailable := doRequest(t, router, "GET", "/db-1/terminal", map[string]string{
		"Host": "localhost:48100", "Origin": "http://localhost:48100",
	}, nil)
	if unavailable.Code != http.StatusServiceUnavailable || !strings.Contains(unavailable.Body.String(), "数据库终端服务不可用") {
		t.Fatalf("只挂 sqlite 时 MySQL 终端应 503，实际 %d", unavailable.Code)
	}
	logs.mu.Lock()
	if len(logs.rows) != 1 || logs.rows[0].Result != "failure" || logs.rows[0].HTTPStatus == nil || *logs.rows[0].HTTPStatus != 503 {
		t.Fatalf("503 拒绝应记 failure/503 审计：%+v", logs.rows)
	}
	logs.mu.Unlock()
}

func TestTerminalFrameViolation(t *testing.T) {
	if reason := terminalFrameViolation(websocket.BinaryMessage, []byte("binary")); reason != "终端消息无效" {
		t.Fatalf("二进制帧应判「终端消息无效」，实际 %q", reason)
	}
	if reason := terminalFrameViolation(websocket.TextMessage, []byte("x")); reason != "" {
		t.Fatalf("普通文本帧应放行，实际 %q", reason)
	}
	if reason := terminalFrameViolation(websocket.TextMessage, []byte(strings.Repeat("a", 65*1024))); reason != "输入超过 64 KiB" {
		t.Fatalf("65 KiB 帧应判超限，实际 %q", reason)
	}
	if reason := terminalFrameViolation(websocket.TextMessage, []byte(strings.Repeat("a", 64*1024))); reason != "" {
		t.Fatalf("64 KiB 帧应放行，实际 %q", reason)
	}
	if reason := terminalFrameViolation(websocket.TextMessage, []byte(`{"type":"execute","text":"SELECT 1"}`)); reason != "" {
		t.Fatalf("合法 JSON 帧应放行，实际 %q", reason)
	}
}

// fakeWsConn 可编程的 seam.WsConn 假件。
type fakeWsConn struct {
	readyState     int
	bufferedAmount int64
	sent           []string
	closeCode      int
	closeReason    string
}

func (c *fakeWsConn) SendText(text string) bool {
	if c.readyState != 1 {
		return false
	}
	c.sent = append(c.sent, text)
	return true
}

func (c *fakeWsConn) BufferedAmount() int64 { return c.bufferedAmount }

func (c *fakeWsConn) Close(code int, reason string) {
	c.closeCode = code
	c.closeReason = reason
}

func (c *fakeWsConn) ReadMessage() (int, []byte, error) { return 0, nil, errors.New("unused") }

func TestSendGuardedWatermark(t *testing.T) {
	payload := wsErrorFrame{Type: "error", Text: "上一条命令仍在执行"}
	// 低于水位：发送。
	conn := &fakeWsConn{readyState: 1, bufferedAmount: 1024*1024 - 1}
	sendGuarded(conn, func() bool { return conn.readyState == 1 }, payload)
	if len(conn.sent) != 1 || conn.closeCode != 0 {
		t.Fatalf("低于水位应发送：%v", conn.sent)
	}
	// 达到水位：不发并 1008。
	for _, amount := range []int64{1024 * 1024, 1024*1024 + 1} {
		conn = &fakeWsConn{readyState: 1, bufferedAmount: amount}
		sendGuarded(conn, func() bool { return conn.readyState == 1 }, payload)
		if len(conn.sent) != 0 || conn.closeCode != 1008 || conn.closeReason != "输出缓冲超限" {
			t.Fatalf("水位达 1 MiB 应 close(1008 输出缓冲超限)：%d %q", conn.closeCode, conn.closeReason)
		}
	}
	// 非 OPEN：不发也不断开。
	conn = &fakeWsConn{readyState: 3, bufferedAmount: 1024 * 1024 * 8}
	sendGuarded(conn, func() bool { return conn.readyState == 1 }, payload)
	if len(conn.sent) != 0 || conn.closeCode != 0 {
		t.Fatal("非 OPEN 不应发送或断开")
	}
}

func TestSqliteRoutesMergeAndConfirm(t *testing.T) {
	service := &fakeService{listed: []serviceInstance{{ID: "db-1", Engine: engineMySQL}}}
	files := &fakeSqlite{listed: []sqliteInstance{{ID: "sqlite-123", Engine: engineSQLite, Name: "notes"}}}
	router := newRouterFixture(service, files, nil)
	headers := sameOriginHeaders()

	recorder := doRequest(t, router, "GET", "/", nil, nil)
	var rows []map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &rows) != nil || len(rows) != 2 || rows[0]["engine"] != "MySQL" || rows[1]["engine"] != "SQLite" {
		t.Fatalf("合并列表应 MySQL 在前 SQLite 在后：%s", recorder.Body.String())
	}

	created := doRequest(t, router, "POST", "/sqlite", headers, []byte(`{"name":"notes"}`))
	if created.Code != 201 {
		t.Fatalf("POST /sqlite 应 201，实际 %d", created.Code)
	}
	if len(files.created) != 1 || files.created[0] != "notes" {
		t.Fatalf("create 应收到 name=notes：%v", files.created)
	}

	uploadHeaders := map[string]string{"Host": "localhost:48100", "Origin": "http://localhost:48100", "Content-Type": "application/octet-stream"}
	uploaded := doRequest(t, router, "POST", "/sqlite/import?name=copy", uploadHeaders, []byte("bytes"))
	if uploaded.Code != 201 || len(files.imported) != 1 || files.imported[0] != "copy" {
		t.Fatalf("import 应 201 且透传 name：%d %v", uploaded.Code, files.imported)
	}

	denied := doRequest(t, router, "DELETE", "/sqlite/sqlite-123", headers, []byte(`{"confirm":false}`))
	if denied.Code != 400 || !strings.Contains(denied.Body.String(), "必须确认删除 SQLite 文件") {
		t.Fatalf("错 confirm 应 400，实际 %d %s", denied.Code, denied.Body.String())
	}
	if len(files.removed) != 0 {
		t.Fatal("错 confirm 不应调用 remove")
	}
	removed := doRequest(t, router, "DELETE", "/sqlite/sqlite-123", headers, []byte(`{"confirm":"DELETE_SQLITE_FILE"}`))
	if removed.Code != 200 || len(files.removed) != 1 || files.removed[0] != "123" {
		t.Fatalf("正确 confirm 应 200 且收到去前缀 id：%d %v", removed.Code, files.removed)
	}
}

func TestUnavailableDomainReturns503(t *testing.T) {
	router := newRouter(routerDeps{available: false})
	for _, testCase := range []struct {
		method, target string
	}{
		{"GET", "/"}, {"GET", "/nowhere"}, {"POST", "/"}, {"DELETE", "/db-1"},
	} {
		recorder := doRequest(t, router, testCase.method, testCase.target, map[string]string{"Host": "localhost:48100", "Origin": "http://localhost:48100", "Content-Type": "application/json"}, []byte("{}"))
		if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "真实数据库仅在 Docker 环境可用") {
			t.Fatalf("%s %s 非 Docker 环境应整片 503，实际 %d %s", testCase.method, testCase.target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestServiceMissingReturns503(t *testing.T) {
	router := newRouterFixture(nil, &fakeSqlite{}, nil)
	recorder := doRequest(t, router, "GET", "/discover?engine=MySQL", nil, nil)
	if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "容器数据库服务不可用") {
		t.Fatalf("仅挂 sqlite 时服务型端点应 503，实际 %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSameOriginGuardRejectsCrossSiteWrites(t *testing.T) {
	router := newRouterFixture(&fakeService{}, &fakeSqlite{}, nil)
	recorder := doRequest(t, router, "DELETE", "/sqlite/sqlite-123", map[string]string{
		"Host": "localhost:48100", "Origin": "http://evil.example", "Content-Type": "application/json",
	}, []byte(`{"confirm":"DELETE_SQLITE_FILE"}`))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "请求来源不允许") {
		t.Fatalf("跨源写应 403 在读体之前，实际 %d %s", recorder.Code, recorder.Body.String())
	}
}

// 编译期锚定：错误映射按 shared.InvalidRequestError 自带状态码回显。
func TestWriteErrorMapsStatus(t *testing.T) {
	recorder := httptest.NewRecorder()
	middleware.WriteError(recorder, &shared.InvalidRequestError{Status: 409, Message: "数据库已登记"})
	if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), "数据库已登记") {
		t.Fatalf("InvalidRequestError 应按 Status 回显：%d %s", recorder.Code, recorder.Body.String())
	}
}

var _ = context.Background

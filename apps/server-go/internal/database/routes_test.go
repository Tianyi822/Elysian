package database

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// databaseRoutes.test.ts 对等测试：HTTP 守卫链、容器列表与 SQLite 分流、确认守卫。

const testSecret = "password-hidden-from-list"

// fakeService 假容器数据库服务。
type fakeService struct {
	mu                sync.Mutex
	listed            []containerInstance
	revealed          databaseSecret
	removedContainers []string
	createCalled      bool
	reconciled        []string
	forgotten         []string
}

func (f *fakeService) List(context.Context) ([]containerInstance, error) {
	return f.listed, nil
}

func (f *fakeService) Create(context.Context, createRequest) (createResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalled = true
	return createResponse{}, nil
}

func (f *fakeService) Reveal(context.Context, string) (databaseSecret, error) {
	return f.revealed, nil
}

func (f *fakeService) RemoveContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removedContainers = append(f.removedContainers, id)
	return nil
}

func (f *fakeService) Reconcile(_ context.Context, id string) (containerInstance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reconciled = append(f.reconciled, id)
	return containerInstance{}, nil
}

func (f *fakeService) Forget(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgotten = append(f.forgotten, id)
	return nil
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

// newRouterFixture 组装被测路由。
func newRouterFixture(service Service, sqlite SqliteService) chi.Router {
	return newRouter(routerDeps{available: true, service: service, sqlite: sqlite})
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

func TestListReturnsContainerRowsOnly(t *testing.T) {
	service := &fakeService{listed: []containerInstance{{
		ID: "c1", Engine: engineMySQL, Name: "mysql-main", Version: "8.4", Status: statusRunning,
		Image: "mysql:8.4", ContainerID: "c1", Ports: []containerPortView{}, Networks: []string{},
		CredentialsVerified: true, UpdatedAt: "2026-09-28T00:00:00.000Z",
	}}}
	files := &fakeSqlite{listed: []sqliteInstance{{
		ID: "sqlite-123", Engine: engineSQLite, Name: "notes", Version: "3.54", Status: statusRunning,
		UpdatedAt: "2026-09-28T00:00:00.000Z", Source: sourceManaged,
	}}}
	router := newRouterFixture(service, files)
	recorder := doRequest(t, router, "GET", "/", nil, nil)
	if recorder.Code != 200 {
		t.Fatalf("容器列表应 200，实际 %d", recorder.Code)
	}
	var rows []map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &rows) != nil {
		t.Fatal("容器列表 JSON 解析失败")
	}
	if len(rows) != 1 || rows[0]["engine"] != "MySQL" || rows[0]["containerId"] != "c1" {
		t.Fatalf("GET / 只返回容器实例行：%s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "SQLite") {
		t.Fatal("容器列表不得混入 SQLite 行")
	}
	if strings.Contains(recorder.Body.String(), testSecret) {
		t.Fatal("列表不得包含密码")
	}
	// SQLite 行走独立端点。
	sqliteList := doRequest(t, router, "GET", "/sqlite", nil, nil)
	if sqliteList.Code != 200 {
		t.Fatalf("GET /sqlite 应 200，实际 %d", sqliteList.Code)
	}
	var sqliteRows []map[string]any
	if json.Unmarshal(sqliteList.Body.Bytes(), &sqliteRows) != nil || len(sqliteRows) != 1 || sqliteRows[0]["engine"] != "SQLite" {
		t.Fatalf("GET /sqlite 只返回 SQLite 行：%s", sqliteList.Body.String())
	}
	if strings.Contains(sqliteList.Body.String(), "MySQL") {
		t.Fatal("SQLite 列表不得混入容器行")
	}
}

func TestRetiredEndpointsReturnNotFound(t *testing.T) {
	router := newRouterFixture(&fakeService{}, &fakeSqlite{})
	for _, target := range []string{"/db-1", "/db-1/terminal", "/discover?engine=MySQL"} {
		method := "DELETE"
		if strings.HasPrefix(target, "/db-1/terminal") || strings.HasPrefix(target, "/discover") {
			method = "GET"
		}
		recorder := doRequest(t, router, method, target, sameOriginHeaders(), []byte("{}"))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s 退役端点应 404，实际 %d", method, target, recorder.Code)
		}
	}
}

func TestRevealGuardsAndNoStore(t *testing.T) {
	service := &fakeService{revealed: databaseSecret{Username: "root", Password: testSecret}}
	router := newRouterFixture(service, nil)
	blocked := doRequest(t, router, "POST", "/container-id/reveal", map[string]string{
		"Host": "localhost:48100", "Origin": "http://evil.example", "Content-Type": "application/json",
	}, []byte("{}"))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("跨源 reveal 应 403，实际 %d", blocked.Code)
	}
	revealed := doRequest(t, router, "POST", "/container-id/reveal", sameOriginHeaders(), []byte("{}"))
	if revealed.Code != 200 || revealed.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("reveal 应 200 且 no-store，实际 %d %q", revealed.Code, revealed.Header().Get("Cache-Control"))
	}
	if !strings.Contains(revealed.Body.String(), testSecret) {
		t.Fatal("reveal 应回管理员凭证")
	}
}

func TestRemoveContainerConfirmGuard(t *testing.T) {
	service := &fakeService{}
	router := newRouterFixture(service, nil)
	headers := sameOriginHeaders()
	denied := doRequest(t, router, "DELETE", "/container-id/container", headers, []byte(`{"confirm":false}`))
	if denied.Code != 400 || !strings.Contains(denied.Body.String(), "必须确认删除容器及全部数据") {
		t.Fatalf("错 confirm 应 400，实际 %d %s", denied.Code, denied.Body.String())
	}
	if len(service.removedContainers) != 0 {
		t.Fatal("错 confirm 不应调用 service")
	}
	accepted := doRequest(t, router, "DELETE", "/container-id/container", headers, []byte(`{"confirm":"DELETE_CONTAINER_AND_DATA"}`))
	if accepted.Code != 200 || len(service.removedContainers) != 1 || service.removedContainers[0] != "container-id" {
		t.Fatalf("正确 confirm 应 200 并按容器 ID 调用 service：%d", accepted.Code)
	}
}

func TestReconcileAndForgetUseContainerID(t *testing.T) {
	service := &fakeService{}
	router := newRouterFixture(service, nil)
	headers := sameOriginHeaders()
	if status := doRequest(t, router, "POST", "/container-id/reconcile", headers, nil).Code; status != 200 {
		t.Fatalf("reconcile 应 200，实际 %d", status)
	}
	if status := doRequest(t, router, "DELETE", "/container-id/registration", headers, nil).Code; status != 200 {
		t.Fatalf("forget 应 200，实际 %d", status)
	}
	if len(service.reconciled) != 1 || service.reconciled[0] != "container-id" || len(service.forgotten) != 1 || service.forgotten[0] != "container-id" {
		t.Fatalf("id 语义应为容器 ID：%v %v", service.reconciled, service.forgotten)
	}
}

func TestSqliteRoutesMergeAndConfirm(t *testing.T) {
	files := &fakeSqlite{listed: []sqliteInstance{{ID: "sqlite-123", Engine: engineSQLite, Name: "notes"}}}
	router := newRouterFixture(&fakeService{}, files)
	headers := sameOriginHeaders()

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
		{"GET", "/"}, {"GET", "/sqlite"}, {"GET", "/nowhere"}, {"DELETE", "/container-id"},
	} {
		recorder := doRequest(t, router, testCase.method, testCase.target, map[string]string{"Host": "localhost:48100", "Origin": "http://localhost:48100", "Content-Type": "application/json"}, []byte("{}"))
		if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "真实数据库仅在 Docker 环境可用") {
			t.Fatalf("%s %s 非 Docker 环境应整片 503，实际 %d %s", testCase.method, testCase.target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestServiceMissingReturns503(t *testing.T) {
	router := newRouterFixture(nil, &fakeSqlite{})
	recorder := doRequest(t, router, "GET", "/", nil, nil)
	if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "容器数据库服务不可用") {
		t.Fatalf("仅挂 sqlite 时容器端点应 503，实际 %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSameOriginGuardRejectsCrossSiteWrites(t *testing.T) {
	router := newRouterFixture(&fakeService{}, &fakeSqlite{})
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
	middleware.WriteError(recorder, &shared.InvalidRequestError{Status: 409, Message: "数据库容器已登记"})
	if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), "数据库容器已登记") {
		t.Fatalf("InvalidRequestError 应按 Status 回显：%d %s", recorder.Code, recorder.Body.String())
	}
}

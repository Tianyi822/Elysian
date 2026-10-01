package security

// 用户管理路由的对等测试（对齐 usersRoutes.test.ts，security 盘点 §8）：不可用 503、
// 根路径双形、透传（含 password 字段）、六种 400 文案、URL 解码、404 剥前缀、
// 跨源 403 先于读体、415/413、POST /sync 不读体。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"elysian/server/internal/middleware"
)

// fakeUsersAPI 路由测试的 fake service。
type fakeUsersAPI struct {
	calls           []string
	err             error
	users           []HostUser
	user            HostUser
	total           int
	capturedCreates []struct {
		name  string
		input HostUserInput
	}
	capturedUpdates []struct {
		id    string
		input HostUserInput
	}
	capturedRemoves []string
}

func (f *fakeUsersAPI) List() ([]HostUser, error) {
	f.calls = append(f.calls, "list")
	return f.users, f.err
}

func (f *fakeUsersAPI) Create(name string, input HostUserInput) (HostUser, error) {
	f.calls = append(f.calls, "create")
	f.capturedCreates = append(f.capturedCreates, struct {
		name  string
		input HostUserInput
	}{name, input})
	return f.user, f.err
}

func (f *fakeUsersAPI) Update(userId string, input HostUserInput) (HostUser, error) {
	f.calls = append(f.calls, "update")
	f.capturedUpdates = append(f.capturedUpdates, struct {
		id    string
		input HostUserInput
	}{userId, input})
	return f.user, f.err
}

func (f *fakeUsersAPI) Remove(userId string) error {
	f.calls = append(f.calls, "remove")
	f.capturedRemoves = append(f.capturedRemoves, userId)
	return f.err
}

func (f *fakeUsersAPI) SyncFromSystem() (int, error) {
	f.calls = append(f.calls, "syncFromSystem")
	return f.total, f.err
}

func newWorkingUsersDeps(fake *fakeUsersAPI) Deps {
	return Deps{Available: true, users: fake}
}

func TestUsersRouter不可用整片503(t *testing.T) {
	parent := mountUsers(Deps{Available: false})
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/security/users"},
		{http.MethodGet, "/api/security/users/"},
		{http.MethodPost, "/api/security/users/sync"},
		{http.MethodDelete, "/api/security/users/ops"},
		{http.MethodPut, "/api/security/users/nope/deeper"},
	} {
		rec := doReq(parent, c.method, c.path, "", false)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s 应 503，得 %d", c.method, c.path, rec.Code)
		}
		if want := `{"error":"真实用户管理仅在 Docker 容器内可用"}`; bodyOf(rec) != want {
			t.Errorf("%s %s 文案不符：%s", c.method, c.path, bodyOf(rec))
		}
	}
	// 跨源写请求同样 503。
	rec := doReq(parent, http.MethodPost, "/api/security/users", `{"name":"x"}`, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("跨源在不可用分支应 503，得 %d", rec.Code)
	}
}

func TestUsersRouter根路径双形与形状(t *testing.T) {
	note := "值班账号"
	fake := &fakeUsersAPI{
		users: []HostUser{{ID: "elysian", Name: "elysian", IsAdmin: true, LoginMethod: "password", Status: "active", Note: &note, CreatedAt: nil}},
		total: 1,
	}
	parent := mountUsers(newWorkingUsersDeps(fake))

	for _, path := range []string{"/api/security/users", "/api/security/users/"} {
		rec := doReq(parent, http.MethodGet, path, "", false)
		if rec.Code != 200 {
			t.Errorf("%s 应命中列表端点（尾斜杠宽容），得 %d", path, rec.Code)
		}
		want := `{"users":[{"id":"elysian","name":"elysian","isAdmin":true,"loginMethod":"password","status":"active","note":"值班账号","createdAt":null}]}`
		if bodyOf(rec) != want {
			t.Errorf("%s 形状不符：\n got %s\nwant %s", path, bodyOf(rec), want)
		}
	}

	rec := doReq(parent, http.MethodPost, "/api/security/users/sync", "", false)
	if rec.Code != 200 || bodyOf(rec) != `{"total":1}` {
		t.Errorf("sync 形状不符：%d %s", rec.Code, bodyOf(rec))
	}
}

func TestUsersRouterPOST透传含密码(t *testing.T) {
	fake := &fakeUsersAPI{}
	parent := mountUsers(newWorkingUsersDeps(fake))

	body := `{"name":"newops","loginMethod":"password","status":"active","isAdmin":true,"note":"值班账号","password":"Str0ngPass!1"}`
	rec := doReq(parent, http.MethodPost, "/api/security/users", body, false)
	if rec.Code != 200 || len(fake.capturedCreates) != 1 {
		t.Fatalf("POST 透传失败：%d %s", rec.Code, bodyOf(rec))
	}
	got := fake.capturedCreates[0]
	if got.name != "newops" || got.input.LoginMethod != "password" || got.input.Status != "active" || !got.input.IsAdmin {
		t.Errorf("透传字段不符：%+v", got)
	}
	if got.input.Note == nil || *got.input.Note != "值班账号" {
		t.Errorf("备注透传不符：%v", got.input.Note)
	}
	if got.input.Password == nil || *got.input.Password != "Str0ngPass!1" {
		t.Errorf("密码透传不符：%v", got.input.Password)
	}

	// 不携带 password 时透传对象也没有该键（nil）。
	rec = doReq(parent, http.MethodPost, "/api/security/users",
		`{"name":"newops2","loginMethod":"none","status":"active","isAdmin":false,"note":null}`, false)
	if rec.Code != 200 || len(fake.capturedCreates) != 2 || fake.capturedCreates[1].input.Password != nil {
		t.Errorf("不携带密码应透传 nil：%d %+v", rec.Code, fake.capturedCreates)
	}

	// 响应 {user:...}。
	if bodyOf(rec) != `{"user":{"id":"","name":"","isAdmin":false,"loginMethod":"","status":"","note":null,"createdAt":null}}` {
		t.Errorf("POST 响应形状不符：%s", bodyOf(rec))
	}
}

func TestUsersRouterPUT与DELETE透传(t *testing.T) {
	fake := &fakeUsersAPI{}
	parent := mountUsers(newWorkingUsersDeps(fake))

	rec := doReq(parent, http.MethodPut, "/api/security/users/newops",
		`{"loginMethod":"key","status":"disabled","isAdmin":false,"note":null}`, false)
	if rec.Code != 200 || len(fake.capturedUpdates) != 1 || fake.capturedUpdates[0].id != "newops" {
		t.Fatalf("PUT 透传失败：%d", rec.Code)
	}
	if fake.capturedUpdates[0].input.LoginMethod != "key" || fake.capturedUpdates[0].input.Status != "disabled" {
		t.Errorf("PUT 字段不符：%+v", fake.capturedUpdates[0])
	}

	rec = doReq(parent, http.MethodPut, "/api/security/users/%E8%BF%90%E7%BB%B4",
		`{"loginMethod":"none","status":"active","isAdmin":false,"note":null}`, false)
	if rec.Code != 200 || fake.capturedUpdates[1].id != "运维" {
		t.Errorf("路径参数应 URL 解码：%v", fake.capturedUpdates)
	}

	rec = doReq(parent, http.MethodDelete, "/api/security/users/newops", "", false)
	if rec.Code != 200 || bodyOf(rec) != `{"ok":true}` {
		t.Errorf("DELETE 响应不符：%d %s", rec.Code, bodyOf(rec))
	}
	if len(fake.capturedRemoves) != 1 || fake.capturedRemoves[0] != "newops" {
		t.Errorf("DELETE 应传 id：%v", fake.capturedRemoves)
	}
}

func TestUsersRouter六种400文案(t *testing.T) {
	fake := &fakeUsersAPI{}
	parent := mountUsers(newWorkingUsersDeps(fake))
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   string
	}{
		{"用户名请求体无效", http.MethodPost, "/api/security/users", `{"name":"","loginMethod":"none","status":"active","isAdmin":false,"note":null}`, `{"error":"用户名请求体无效"}`},
		{"无效的登录方式", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"随便","status":"active","isAdmin":false,"note":null}`, `{"error":"无效的登录方式：随便"}`},
		{"无效的登录方式缺键", http.MethodPut, "/api/security/users/x", `{"status":"active","isAdmin":false,"note":null}`, `{"error":"无效的登录方式：undefined"}`},
		{"无效的账号状态", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"none","status":"冻结","isAdmin":false,"note":null}`, `{"error":"无效的账号状态：冻结"}`},
		{"管理员归属需为布尔值", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"none","status":"active","isAdmin":"yes","note":null}`, `{"error":"管理员归属需为布尔值"}`},
		{"备注需为字符串或 null", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"none","status":"active","isAdmin":false,"note":5}`, `{"error":"备注需为字符串或 null"}`},
		{"备注缺键同样拒绝", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"none","status":"active","isAdmin":false}`, `{"error":"备注需为字符串或 null"}`},
		{"密码需为字符串", http.MethodPost, "/api/security/users", `{"name":"x","loginMethod":"none","status":"active","isAdmin":false,"note":null,"password":123}`, `{"error":"密码需为字符串"}`},
	}
	for _, c := range cases {
		rec := doReq(parent, c.method, c.path, c.body, false)
		if rec.Code != 400 || bodyOf(rec) != c.want {
			t.Errorf("%s：得 %d %s，want 400 %s", c.name, rec.Code, bodyOf(rec), c.want)
		}
	}
}

func TestUsersRouter错误分类(t *testing.T) {
	fake := &fakeUsersAPI{err: sharedInvalidRequest("业务校验失败")}
	parent := mountUsers(newWorkingUsersDeps(fake))
	rec := doReq(parent, http.MethodGet, "/api/security/users", "", false)
	if rec.Code != 400 || bodyOf(rec) != `{"error":"业务校验失败"}` {
		t.Errorf("invalidRequest 应 400：%d %s", rec.Code, bodyOf(rec))
	}

	fake = &fakeUsersAPI{err: errFake("服务端故障")}
	parent = mountUsers(newWorkingUsersDeps(fake))
	rec = doReq(parent, http.MethodGet, "/api/security/users", "", false)
	if rec.Code != 500 || bodyOf(rec) != `{"error":"服务端故障"}` {
		t.Errorf("普通错误应 500：%d %s", rec.Code, bodyOf(rec))
	}
}

func TestUsersRouter未知端点404剥前缀(t *testing.T) {
	fake := &fakeUsersAPI{}
	parent := mountUsers(newWorkingUsersDeps(fake))

	rec := doReq(parent, http.MethodGet, "/api/security/users/nope", "", false)
	if rec.Code != 404 || bodyOf(rec) != `{"error":"未知用户管理端点：GET /nope"}` {
		t.Errorf("404 文案不符：%d %s", rec.Code, bodyOf(rec))
	}
	rec = doReq(parent, http.MethodGet, "/api/security/users/nope/deeper", "", false)
	if bodyOf(rec) != `{"error":"未知用户管理端点：GET /nope/deeper"}` {
		t.Errorf("更深路径 404 文案不符：%s", bodyOf(rec))
	}
	// 方法不匹配走同一 404 文案。
	rec = doReq(parent, http.MethodPut, "/api/security/users", `{"x":1}`, false)
	if rec.Code != 404 || bodyOf(rec) != `{"error":"未知用户管理端点：PUT /"}` {
		t.Errorf("根路径 PUT 方法不匹配应 404：%d %s", rec.Code, bodyOf(rec))
	}
}

func TestUsersRouter守卫次序(t *testing.T) {
	fake := &fakeUsersAPI{}
	parent := mountUsers(newWorkingUsersDeps(fake))

	// 跨源 403 先于读体（坏 JSON 佐证）。
	rec := doReq(parent, http.MethodPost, "/api/security/users", `{坏`, true)
	if rec.Code != 403 || bodyOf(rec) != `{"error":"请求来源不允许"}` {
		t.Errorf("跨源 403 应先于读体：%d %s", rec.Code, bodyOf(rec))
	}

	// 415。
	req := httptest.NewRequest(http.MethodPost, "/api/security/users", strings.NewReader(`{}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "text/plain")
	rec2 := httptest.NewRecorder()
	parent.ServeHTTP(rec2, req)
	if rec2.Code != 415 || bodyOf(rec2) != `{"error":"Content-Type 必须为 application/json"}` {
		t.Errorf("text/plain 应 415：%d %s", rec2.Code, bodyOf(rec2))
	}

	// 413 双拦：申报。
	req = httptest.NewRequest(http.MethodPost, "/api/security/users", strings.NewReader(`{}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = middleware.DefaultJSONBodyMaxBytes + 1
	rec3 := httptest.NewRecorder()
	parent.ServeHTTP(rec3, req)
	if rec3.Code != 413 || bodyOf(rec3) != `{"error":"请求体过大"}` {
		t.Errorf("申报超限应 413：%d %s", rec3.Code, bodyOf(rec3))
	}

	// 413 双拦：实读（chunked）。
	big := `{"pad":"` + strings.Repeat("x", int(middleware.DefaultJSONBodyMaxBytes)+1024) + `"}`
	req2 := httptest.NewRequest(http.MethodPost, "/api/security/users", io.NopCloser(strings.NewReader(big)))
	req2.Host = "127.0.0.1:48101"
	req2.Header.Set("Origin", testOrigin)
	req2.Header.Set("Content-Type", "application/json")
	rec4 := httptest.NewRecorder()
	parent.ServeHTTP(rec4, req2)
	if rec4.Code != 413 || bodyOf(rec4) != `{"error":"请求体过大"}` {
		t.Errorf("实读超限应 413：%d %s", rec4.Code, bodyOf(rec4))
	}

	// POST /sync 不读体：text/plain 与任意体都行。
	req = httptest.NewRequest(http.MethodPost, "/api/security/users/sync", strings.NewReader("随便什么体"))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "text/plain")
	rec5 := httptest.NewRecorder()
	parent.ServeHTTP(rec5, req)
	if rec5.Code != 200 {
		t.Errorf("sync 不读体（无 415 拦截）：%d %s", rec5.Code, bodyOf(rec5))
	}

	// 同源大小写归一放行。
	req = httptest.NewRequest(http.MethodPost, "/api/security/users", strings.NewReader(
		`{"name":"x","loginMethod":"none","status":"active","isAdmin":false,"note":null}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", "HTTP://127.0.0.1:48101")
	req.Header.Set("Content-Type", "application/json")
	rec6 := httptest.NewRecorder()
	parent.ServeHTTP(rec6, req)
	if rec6.Code != 200 {
		t.Errorf("Origin 大小写归一后应放行：%d %s", rec6.Code, bodyOf(rec6))
	}
}

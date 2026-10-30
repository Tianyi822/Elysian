package security

// SSH 路由的对等测试（对齐 sshRoutes.test.ts，security 盘点 §8）：不可用整片 503、
// 六个 GET 数据形状、PUT 透传、一次性私钥、形状 400 文案、401/503/403/415/413/404
// 的次序、JS Number() 强转语义。fake service 驱动，不执行任何真实命令。

import (
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

// ---------- fake service ----------

type capturedKey struct {
	name   string
	userId string
}

type fakeSshAPI struct {
	mu                sync.Mutex
	err               error
	overview          SshOverview
	settings          SshAuthSettings
	rootAuth          SshRootAuth
	reset             SshPasswordResetResult
	keysReport        sshListKeysReport
	accounts          []SshKeyAccount
	records           []SshLoginRecord
	key               SshLoginKey
	calls             []string
	capturedEnabled   []bool
	capturedAuthM     [][2]bool
	capturedPorts     []float64
	capturedPolicies  []string
	capturedPasswords []string
	capturedKeys      []capturedKey
	capturedKeyIds    []string
}

func (f *fakeSshAPI) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeSshAPI) Overview() (SshOverview, error) {
	f.record("overview")
	return f.overview, f.err
}

func (f *fakeSshAPI) Settings() (SshAuthSettings, error) {
	f.record("settings")
	return f.settings, f.err
}

func (f *fakeSshAPI) RootAuth() (SshRootAuth, error) {
	f.record("rootAuth")
	return f.rootAuth, f.err
}

func (f *fakeSshAPI) SetServiceEnabled(enabled bool) (SshOverview, error) {
	f.record("setServiceEnabled")
	f.mu.Lock()
	f.capturedEnabled = append(f.capturedEnabled, enabled)
	f.mu.Unlock()
	return f.overview, f.err
}

func (f *fakeSshAPI) SetAuthMethods(passwordAuthEnabled, keyAuthEnabled bool) (SshAuthSettings, error) {
	f.record("setAuthMethods")
	f.mu.Lock()
	f.capturedAuthM = append(f.capturedAuthM, [2]bool{passwordAuthEnabled, keyAuthEnabled})
	f.mu.Unlock()
	return f.settings, f.err
}

func (f *fakeSshAPI) SetPort(port float64) (SshAuthSettings, error) {
	f.record("setPort")
	f.mu.Lock()
	f.capturedPorts = append(f.capturedPorts, port)
	f.mu.Unlock()
	return f.settings, f.err
}

func (f *fakeSshAPI) SaveRootLoginPolicy(policy string) (SshRootAuth, error) {
	f.record("saveRootLoginPolicy")
	f.mu.Lock()
	f.capturedPolicies = append(f.capturedPolicies, policy)
	f.mu.Unlock()
	return f.rootAuth, f.err
}

func (f *fakeSshAPI) ResetRootPassword(password string) (SshPasswordResetResult, error) {
	f.record("resetRootPassword")
	f.mu.Lock()
	f.capturedPasswords = append(f.capturedPasswords, password)
	f.mu.Unlock()
	return f.reset, f.err
}

func (f *fakeSshAPI) CreateRootKey() (SshRootAuth, error) {
	f.record("createRootKey")
	return f.rootAuth, f.err
}

func (f *fakeSshAPI) ListKeysWithReport() (sshListKeysReport, error) {
	f.record("listKeysWithReport")
	return f.keysReport, f.err
}

func (f *fakeSshAPI) ListLoginRecords() ([]SshLoginRecord, error) {
	f.record("listLoginRecords")
	return f.records, f.err
}

func (f *fakeSshAPI) KeyAccounts() ([]SshKeyAccount, error) {
	f.record("keyAccounts")
	return f.accounts, f.err
}

func (f *fakeSshAPI) CreateKey(name string, userId string) (SshLoginKey, error) {
	f.record("createKey")
	f.mu.Lock()
	f.capturedKeys = append(f.capturedKeys, capturedKey{name: name, userId: userId})
	f.mu.Unlock()
	return f.key, f.err
}

func (f *fakeSshAPI) RemoveKey(keyId string) error {
	f.record("removeKey")
	f.mu.Lock()
	f.capturedKeyIds = append(f.capturedKeyIds, keyId)
	f.mu.Unlock()
	return f.err
}

// ---------- HTTP 辅助 ----------

const testOrigin = "http://127.0.0.1:48101"

// doReq 发出请求：origin 非空时带同源头；crossOrigin 为真时刻意跨源。
func doReq(parent http.Handler, method, path, body string, crossOrigin bool) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Host = "127.0.0.1:48101"
	if crossOrigin {
		req.Header.Set("Origin", "http://evil.example")
	} else {
		req.Header.Set("Origin", testOrigin)
	}
	if body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	parent.ServeHTTP(rec, req)
	return rec
}

// mountSsh 把 SSH 片挂到父路由（对齐 app.ts 的 Mount 形态）。
func mountSsh(deps Deps) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(shared.SshMount, NewSshRouter(deps))
	return parent
}

// mountUsers 同上（用户片）。
func mountUsers(deps Deps) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(shared.UsersMount, NewUsersRouter(deps))
	return parent
}

func bodyOf(rec *httptest.ResponseRecorder) string {
	return rec.Body.String()
}

// ---------- SSH 路由用例 ----------

func TestSshRouter不可用整片503(t *testing.T) {
	parent := mountSsh(Deps{Available: false})
	cases := []struct{ method, path string }{
		{http.MethodGet, "/api/security/ssh/overview"},
		{http.MethodPost, "/api/security/ssh/nope"},
		{http.MethodPut, "/api/security/ssh/"},
		{http.MethodDelete, "/api/security/ssh/keys/sshkey-x"},
	}
	for _, c := range cases {
		rec := doReq(parent, c.method, c.path, "", false)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s 应 503，得 %d", c.method, c.path, rec.Code)
		}
		if want := `{"error":"真实 SSH 管理仅在 Docker 容器内或正式安装中可用"}`; bodyOf(rec) != want {
			t.Errorf("%s %s 文案不符：%s", c.method, c.path, bodyOf(rec))
		}
	}
	// 跨源请求同样 503（不可用分支先于同源守卫）。
	rec := doReq(parent, http.MethodPut, "/api/security/ssh/port", `{"port":22}`, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("跨源写请求在不可用分支应 503，得 %d", rec.Code)
	}
}

func newWorkingSshDeps(fake *fakeSshAPI) Deps {
	return Deps{Available: true, ssh: fake}
}

func TestSshRouter六个GET各回各的形状(t *testing.T) {
	changedAt := "2026-09-20T01:02:03.000Z"
	fake := &fakeSshAPI{
		overview: SshOverview{Enabled: true, Status: "running", ChangedAt: &changedAt, Stats: SshLoginStats{
			Today:     SshLoginCounts{Succeeded: 1, Failed: 2},
			Yesterday: SshLoginCounts{Succeeded: 3, Failed: 4},
			Last7Days: SshLoginCounts{Succeeded: 5, Failed: 6},
		}},
		settings: SshAuthSettings{PasswordAuthEnabled: false, KeyAuthEnabled: true, Port: 2202},
		rootAuth: SshRootAuth{Policy: "prohibit-password", Key: nil, PasswordResetAt: nil},
	}
	parent := mountSsh(newWorkingSshDeps(fake))

	rec := doReq(parent, http.MethodGet, "/api/security/ssh/overview", "", false)
	if rec.Code != 200 {
		t.Fatalf("overview 应 200：%d %s", rec.Code, bodyOf(rec))
	}
	want := `{"enabled":true,"status":"running","changedAt":"2026-09-20T01:02:03.000Z","stats":{"today":{"succeeded":1,"failed":2},"yesterday":{"succeeded":3,"failed":4},"last7Days":{"succeeded":5,"failed":6}}}`
	if bodyOf(rec) != want {
		t.Errorf("overview 形状（含键序）不符：\n got %s\nwant %s", bodyOf(rec), want)
	}

	rec = doReq(parent, http.MethodGet, "/api/security/ssh/settings", "", false)
	if bodyOf(rec) != `{"passwordAuthEnabled":false,"keyAuthEnabled":true,"port":2202}` {
		t.Errorf("settings 形状不符：%s", bodyOf(rec))
	}

	rec = doReq(parent, http.MethodGet, "/api/security/ssh/root-auth", "", false)
	if bodyOf(rec) != `{"policy":"prohibit-password","key":null,"passwordResetAt":null}` {
		t.Errorf("root-auth 形状不符：%s", bodyOf(rec))
	}

	// keys 附带 ignoredInvalidLines；空列表序列化为 []。
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/keys", "", false)
	if bodyOf(rec) != `{"keys":[],"ignoredInvalidLines":0}` {
		t.Errorf("keys 空形状不符：%s", bodyOf(rec))
	}

	fake.keysReport = sshListKeysReport{
		Keys:                []SshLoginKey{{ID: "sshkey-00112233", Name: "部署机", UserID: "elysian", Algorithm: "ssh-ed25519 256", Fingerprint: "SHA256:x", CreatedAt: changedAt, PublicKey: "ssh-ed25519 AAAA c"}},
		IgnoredInvalidLines: 2,
	}
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/keys", "", false)
	wantKeys := `{"keys":[{"id":"sshkey-00112233","name":"部署机","userId":"elysian","algorithm":"ssh-ed25519 256","fingerprint":"SHA256:x","createdAt":"2026-09-20T01:02:03.000Z","publicKey":"ssh-ed25519 AAAA c"}],"ignoredInvalidLines":2}`
	if bodyOf(rec) != wantKeys {
		t.Errorf("keys 形状不符（列表不带私钥）：\n got %s\nwant %s", bodyOf(rec), wantKeys)
	}

	fake.accounts = []SshKeyAccount{{ID: "elysian", Name: "elysian"}}
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/key-accounts", "", false)
	if bodyOf(rec) != `{"accounts":[{"id":"elysian","name":"elysian"}]}` {
		t.Errorf("key-accounts 形状不符：%s", bodyOf(rec))
	}

	fake.records = []SshLoginRecord{{ID: "login-1", IP: "1.2.3.4", Port: 5, At: changedAt, User: "root", Result: "succeeded"}}
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/login-records", "", false)
	if bodyOf(rec) != `{"records":[{"id":"login-1","ip":"1.2.3.4","port":5,"at":"2026-09-20T01:02:03.000Z","user":"root","result":"succeeded"}]}` {
		t.Errorf("login-records 形状不符：%s", bodyOf(rec))
	}
}

func TestSshRouter四个PUT透传(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))

	rec := doReq(parent, http.MethodPut, "/api/security/ssh/service-enabled", `{"enabled":true}`, false)
	if rec.Code != 200 || len(fake.capturedEnabled) != 1 || !fake.capturedEnabled[0] {
		t.Errorf("service-enabled 透传失败：%d", rec.Code)
	}
	rec = doReq(parent, http.MethodPut, "/api/security/ssh/auth-methods", `{"passwordAuthEnabled":false,"keyAuthEnabled":true}`, false)
	if rec.Code != 200 || len(fake.capturedAuthM) != 1 || fake.capturedAuthM[0] != [2]bool{false, true} {
		t.Errorf("auth-methods 透传失败：%d", rec.Code)
	}
	rec = doReq(parent, http.MethodPut, "/api/security/ssh/port", `{"port":2202}`, false)
	if rec.Code != 200 || len(fake.capturedPorts) != 1 || fake.capturedPorts[0] != 2202 {
		t.Errorf("port 透传失败：%d", rec.Code)
	}
	rec = doReq(parent, http.MethodPut, "/api/security/ssh/root-login-policy", `{"policy":"yes"}`, false)
	if rec.Code != 200 || len(fake.capturedPolicies) != 1 || fake.capturedPolicies[0] != "yes" {
		t.Errorf("root-login-policy 透传失败：%d", rec.Code)
	}
}

func TestSshRouter端口强转语义(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))

	cases := []struct {
		name    string
		body    string
		want    float64
		invalid bool
	}{
		{"数字字符串", `{"port":"2202"}`, 2202, false},
		{"null 转 0 过路由", `{"port":null}`, 0, false},
		{"true 转 1", `{"port":true}`, 1, false},
		{"乱串 NaN", `{"port":"abc"}`, 0, true},
		{"缺键 undefined", `{}`, 0, true},
	}
	for _, c := range cases {
		rec := doReq(parent, http.MethodPut, "/api/security/ssh/port", c.body, false)
		if c.invalid {
			if rec.Code != 400 || bodyOf(rec) != `{"error":"端口请求体无效"}` {
				t.Errorf("%s：应 400 端口请求体无效，得 %d %s", c.name, rec.Code, bodyOf(rec))
			}
			continue
		}
		if rec.Code != 200 || len(fake.capturedPorts) == 0 || fake.capturedPorts[len(fake.capturedPorts)-1] != c.want {
			t.Errorf("%s：透传值不符：%v", c.name, fake.capturedPorts)
		}
	}
}

func TestSshRouter密码与密钥端点(t *testing.T) {
	private := "-----PRIVATE-----"
	fake := &fakeSshAPI{
		reset: SshPasswordResetResult{Auth: SshRootAuth{Policy: "no"}, Strength: "strong"},
		key:   SshLoginKey{ID: "sshkey-aabb", Name: "部署机", UserID: "elysian", PrivateKey: &private},
	}
	parent := mountSsh(newWorkingSshDeps(fake))

	rec := doReq(parent, http.MethodPost, "/api/security/ssh/root-password", `{"password":"Str0ngPass!1"}`, false)
	if rec.Code != 200 || len(fake.capturedPasswords) != 1 || fake.capturedPasswords[0] != "Str0ngPass!1" {
		t.Errorf("root-password 透传失败：%d", rec.Code)
	}
	if bodyOf(rec) != `{"auth":{"policy":"no","key":null,"passwordResetAt":null},"strength":"strong"}` {
		t.Errorf("root-password 响应形状不符：%s", bodyOf(rec))
	}

	rec = doReq(parent, http.MethodPost, "/api/security/ssh/root-key", `{}`, false)
	if rec.Code != 200 {
		t.Errorf("root-key 空 JSON 对象应 200：%d %s", rec.Code, bodyOf(rec))
	}
	// 空体 → 400 请求体不能为空（读体只为走守卫）。
	req := httptest.NewRequest(http.MethodPost, "/api/security/ssh/root-key", nil)
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	parent.ServeHTTP(rec2, req)
	if rec2.Code != 400 || bodyOf(rec2) != `{"error":"请求体不能为空"}` {
		t.Errorf("root-key 空体应 400：%d %s", rec2.Code, bodyOf(rec2))
	}

	rec = doReq(parent, http.MethodPost, "/api/security/ssh/keys", `{"name":"部署机","userId":"elysian"}`, false)
	if rec.Code != 200 || len(fake.capturedKeys) != 1 || fake.capturedKeys[0].name != "部署机" || fake.capturedKeys[0].userId != "elysian" {
		t.Fatalf("keys 创建透传失败：%d", rec.Code)
	}
	want := `{"key":{"id":"sshkey-aabb","name":"部署机","userId":"elysian","algorithm":"","fingerprint":"","createdAt":"","publicKey":"","privateKey":"-----PRIVATE-----"}}`
	if bodyOf(rec) != want {
		t.Errorf("创建响应应携带一次性私钥：\n got %s\nwant %s", bodyOf(rec), want)
	}

	rec = doReq(parent, http.MethodDelete, "/api/security/ssh/keys/sshkey-aabb", "", false)
	if rec.Code != 200 || bodyOf(rec) != `{"ok":true}` {
		t.Errorf("删除响应应为 {ok:true}：%d %s", rec.Code, bodyOf(rec))
	}
	if len(fake.capturedKeyIds) != 1 || fake.capturedKeyIds[0] != "sshkey-aabb" {
		t.Errorf("删除应传 id：%v", fake.capturedKeyIds)
	}
	// URL 解码后的 id。
	rec = doReq(parent, http.MethodDelete, "/api/security/ssh/keys/%E5%AF%86%E9%92%A5", "", false)
	if len(fake.capturedKeyIds) != 2 || fake.capturedKeyIds[1] != "密钥" {
		t.Errorf("路径参数应 URL 解码：%v", fake.capturedKeyIds)
	}
}

func TestSshRouter形状400文案(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   string
	}{
		{"开关值无效", http.MethodPut, "/api/security/ssh/service-enabled", `{"enabled":"x"}`, `{"error":"开关值无效"}`},
		{"登录方式开关需为布尔值", http.MethodPut, "/api/security/ssh/auth-methods", `{"passwordAuthEnabled":true,"keyAuthEnabled":"x"}`, `{"error":"登录方式开关需为布尔值"}`},
		{"无效的 Root 登录策略", http.MethodPut, "/api/security/ssh/root-login-policy", `{"policy":"随便"}`, `{"error":"无效的 Root 登录策略：随便"}`},
		{"无效的 Root 登录策略非字符串", http.MethodPut, "/api/security/ssh/root-login-policy", `{"policy":5}`, `{"error":"无效的 Root 登录策略：5"}`},
		{"密钥请求体无效", http.MethodPost, "/api/security/ssh/keys", `{"name":1}`, `{"error":"密钥请求体无效"}`},
		{"密码请求体无效", http.MethodPost, "/api/security/ssh/root-password", `{"password":""}`, `{"error":"密码请求体无效"}`},
		{"密码请求体非字符串", http.MethodPost, "/api/security/ssh/root-password", `{"password":123}`, `{"error":"密码请求体无效"}`},
	}
	for _, c := range cases {
		rec := doReq(parent, c.method, c.path, c.body, false)
		if rec.Code != 400 || bodyOf(rec) != c.want {
			t.Errorf("%s：得 %d %s，want 400 %s", c.name, rec.Code, bodyOf(rec), c.want)
		}
	}
}

func TestSshRouter错误分类(t *testing.T) {
	fake := &fakeSshAPI{err: shared.InvalidRequest("业务校验失败")}
	parent := mountSsh(newWorkingSshDeps(fake))
	rec := doReq(parent, http.MethodGet, "/api/security/ssh/overview", "", false)
	if rec.Code != 400 || bodyOf(rec) != `{"error":"业务校验失败"}` {
		t.Errorf("invalidRequest 应 400：%d %s", rec.Code, bodyOf(rec))
	}

	fake = &fakeSshAPI{err: errFake("服务端故障")}
	parent = mountSsh(newWorkingSshDeps(fake))
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/overview", "", false)
	if rec.Code != 500 || bodyOf(rec) != `{"error":"服务端故障"}` {
		t.Errorf("普通错误应 500：%d %s", rec.Code, bodyOf(rec))
	}
}

// errFake 普通 error 的测试替身。
type errFake string

func (e errFake) Error() string { return string(e) }

func TestSshRouter未知端点404(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))

	rec := doReq(parent, http.MethodGet, "/api/security/ssh/nope", "", false)
	if rec.Code != 404 || bodyOf(rec) != `{"error":"未知 SSH 端点：GET /nope"}` {
		t.Errorf("未知端点 404 文案（剥挂载前缀）不符：%d %s", rec.Code, bodyOf(rec))
	}
	// 更深路径。
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/nope/deeper", "", false)
	if bodyOf(rec) != `{"error":"未知 SSH 端点：GET /nope/deeper"}` {
		t.Errorf("更深路径 404 文案不符：%s", bodyOf(rec))
	}
	// 挂载根路径：剥空归一 /。
	rec = doReq(parent, http.MethodGet, "/api/security/ssh", "", false)
	if rec.Code != 404 || bodyOf(rec) != `{"error":"未知 SSH 端点：GET /"}` {
		t.Errorf("根路径 404 文案不符：%d %s", rec.Code, bodyOf(rec))
	}
	// 方法不匹配同样走 404 兜底（Hono app.all('*') 行为）。
	rec = doReq(parent, http.MethodPost, "/api/security/ssh/overview", `{}`, false)
	if rec.Code != 404 || bodyOf(rec) != `{"error":"未知 SSH 端点：POST /overview"}` {
		t.Errorf("方法不匹配应 404 文案：%d %s", rec.Code, bodyOf(rec))
	}
	// 尾斜杠（全局剥一层后命中）。
	rec = doReq(parent, http.MethodGet, "/api/security/ssh/overview/", "", false)
	if rec.Code != 200 {
		t.Errorf("尾斜杠宽容：得 %d %s", rec.Code, bodyOf(rec))
	}
}

func TestSshRouter守卫次序(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))

	// 跨源写请求在解析任何请求体之前就被拒绝（体故意坏 JSON 佐证次序）。
	rec := doReq(parent, http.MethodPut, "/api/security/ssh/port", `{坏 JSON`, true)
	if rec.Code != 403 || bodyOf(rec) != `{"error":"请求来源不允许"}` {
		t.Errorf("跨源 403 应先于读体：%d %s", rec.Code, bodyOf(rec))
	}
	// 无 Origin 的写请求同样 403。
	req := httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", strings.NewReader(`{"port":22}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	parent.ServeHTTP(rec2, req)
	if rec2.Code != 403 {
		t.Errorf("无 Origin 写请求应 403：%d", rec2.Code)
	}
	// GET 放行（无 Origin 也 200）。
	req = httptest.NewRequest(http.MethodGet, "/api/security/ssh/overview", nil)
	req.Host = "127.0.0.1:48101"
	rec3 := httptest.NewRecorder()
	parent.ServeHTTP(rec3, req)
	if rec3.Code != 200 {
		t.Errorf("GET 应放行：%d", rec3.Code)
	}

	// text/plain 415。
	req = httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", strings.NewReader(`{"port":22}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "text/plain")
	rec4 := httptest.NewRecorder()
	parent.ServeHTTP(rec4, req)
	if rec4.Code != 415 || bodyOf(rec4) != `{"error":"Content-Type 必须为 application/json"}` {
		t.Errorf("text/plain 应 415：%d %s", rec4.Code, bodyOf(rec4))
	}

	// 415 对 application/json; charset=utf-8 放行（前缀匹配）。
	req = httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", strings.NewReader(`{"port":22}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	rec5 := httptest.NewRecorder()
	parent.ServeHTTP(rec5, req)
	if rec5.Code != 200 {
		t.Errorf("application/json; charset=utf-8 应放行：%d %s", rec5.Code, bodyOf(rec5))
	}

	// 坏 JSON 400。
	rec = doReq(parent, http.MethodPut, "/api/security/ssh/port", `{坏`, false)
	if rec.Code != 400 || bodyOf(rec) != `{"error":"请求体不是有效 JSON"}` {
		t.Errorf("坏 JSON 应 400：%d %s", rec.Code, bodyOf(rec))
	}
	// 空体 400。
	req = httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", nil)
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	rec6 := httptest.NewRecorder()
	parent.ServeHTTP(rec6, req)
	if rec6.Code != 400 || bodyOf(rec6) != `{"error":"请求体不能为空"}` {
		t.Errorf("空体应 400：%d %s", rec6.Code, bodyOf(rec6))
	}
}

func TestSshRouter体积双拦413(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))

	// 申报 content-length 超限直接拒。
	req := httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", strings.NewReader(`{"port":22}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = middleware.DefaultJSONBodyMaxBytes + 1
	rec := httptest.NewRecorder()
	parent.ServeHTTP(rec, req)
	if rec.Code != 413 || bodyOf(rec) != `{"error":"请求体过大"}` {
		t.Errorf("申报超限应 413：%d %s", rec.Code, bodyOf(rec))
	}

	// 申报正常但实读超限（chunked）同样拒。
	big := `{"pad":"` + strings.Repeat("x", int(middleware.DefaultJSONBodyMaxBytes)+1024) + `"}`
	req2 := httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", io.NopCloser(strings.NewReader(big)))
	req2.Host = "127.0.0.1:48101"
	req2.Header.Set("Origin", testOrigin)
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	parent.ServeHTTP(rec2, req2)
	if rec2.Code != 413 || bodyOf(rec2) != `{"error":"请求体过大"}` {
		t.Errorf("实读超限应 413：%d %s", rec2.Code, bodyOf(rec2))
	}
}

func TestSshRouter同源大小写归一放行(t *testing.T) {
	fake := &fakeSshAPI{}
	parent := mountSsh(newWorkingSshDeps(fake))
	req := httptest.NewRequest(http.MethodPut, "/api/security/ssh/port", strings.NewReader(`{"port":22}`))
	req.Host = "127.0.0.1:48101"
	req.Header.Set("Origin", "HTTP://127.0.0.1:48101")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	parent.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("Origin 大小写归一后应放行：%d %s", rec.Code, bodyOf(rec))
	}
}

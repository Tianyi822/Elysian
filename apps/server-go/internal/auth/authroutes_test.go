package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/seam"
)

// 登录片路由测试（authRoutes.test.ts 对等用例）：内存 fake（真实 scrypt hasher——时序
// 与往返行为本身就是被测对象）+ httptest 直驱 NewRouter。锚定 Cookie 属性逐项、401
// 文案逐字、哑哈希时序纪律、限流、logout 幂等与 /session 三种组合、returnTo 裁决分支
// 与设置页三端点。设置端点不经 RequireSession——鉴权接线回归在 authwiring_test.go。

const testOrigin = "http://localhost:5173"

// recordingHasher 包住真实 scrypt 实现，记录每次 verify 的 stored（断言哑哈希纪律）。
type recordingHasher struct {
	inner      PasswordHasher
	verifyArgs []verifyCall
}

func newRecordingHasher() *recordingHasher {
	return &recordingHasher{inner: NewScryptHasher()}
}

func (h *recordingHasher) Hash(plain string) (string, error) { return h.inner.Hash(plain) }

func (h *recordingHasher) Verify(plain, stored string) (bool, error) {
	h.verifyArgs = append(h.verifyArgs, verifyCall{plain: plain, stored: stored})
	return h.inner.Verify(plain, stored)
}

// spyConnections 记录型撤销表：断言三条失效路径对撤销表的调用（不依赖 terminals 片）。
type spyConnections struct {
	registered   []string
	unregistered []string
	revoked      []string
	revokeOthers []string
	revokeAlls   int
}

func (s *spyConnections) Register(sessionID string, _ func()) {
	s.registered = append(s.registered, sessionID)
}

func (s *spyConnections) Unregister(sessionID string, _ func()) {
	s.unregistered = append(s.unregistered, sessionID)
}

func (s *spyConnections) Revoke(sessionID string) {
	s.revoked = append(s.revoked, sessionID)
}

func (s *spyConnections) RevokeOthers(keepSessionID string) {
	s.revokeOthers = append(s.revokeOthers, keepSessionID)
}

func (s *spyConnections) RevokeAll() { s.revokeAlls++ }

// routesFixture 登录片测试夹具。
type routesFixture struct {
	deps        Deps
	router      chi.Router
	hasher      *recordingHasher
	credentials CredentialsStore
	sessions    SessionStore
	clock       *fakeClock
}

func newRoutesFixture(t *testing.T, mutate func(deps *Deps)) *routesFixture {
	t.Helper()
	hasher := newRecordingHasher()
	credentials := NewMemoryCredentialsStore(nil)
	clock := &fakeClock{ms: time.Now().UnixMilli()}
	deps := Deps{
		Enabled:       true,
		DevAccount:    false,
		Credentials:   credentials,
		Sessions:      NewMemorySessionStore(clock.now),
		Hasher:        hasher,
		ReturnOrigins: NewMemoryReturnOriginRegistry(nil),
		Now:           clock.now,
		Diag:          &bytes.Buffer{},
	}
	if mutate != nil {
		mutate(&deps)
	}
	return &routesFixture{
		deps:        deps,
		router:      NewRouter(deps),
		hasher:      hasher,
		credentials: deps.Credentials,
		sessions:    deps.Sessions,
		clock:       clock,
	}
}

// setCredentialsHash 换凭据哈希（内存 store 直写，epoch 用固定值）。
func (f *routesFixture) setCredentialsHash(t *testing.T, hash string) {
	t.Helper()
	_, err := f.credentials.Write(hash)
	if err != nil {
		t.Fatalf("写凭据失败：%v", err)
	}
}

// request 直驱路由器；Go 的 Host 是请求字段不是 header，headers 里的 "Host" 显式落到
// req.Host（与 TS 侧 host 头等价）。
func (f *routesFixture) request(method, path, rawBody string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		if name == "Host" {
			req.Host = value
			continue
		}
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	f.router.ServeHTTP(recorder, req)
	return recorder
}

func (f *routesFixture) login(body string) *httptest.ResponseRecorder {
	return f.request(http.MethodPost, "/login", body, map[string]string{
		"Origin": testOrigin,
		"Host":   "localhost:5173",
	})
}

// cookieValue 从 Set-Cookie 整串取出 `elysian_session=<值>` 段。
func cookiePair(setCookie string) string {
	return strings.SplitN(setCookie, ";", 2)[0]
}

func decodeJSON(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("响应不是 JSON 对象：%v（原文 %s）", err, recorder.Body.String())
	}
	return parsed
}

func wantStatusBody(t *testing.T, recorder *httptest.ResponseRecorder, status int, errorMessage string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("状态码 = %d，期望 %d（响应 %s）", recorder.Code, status, recorder.Body.String())
	}
	body := decodeJSON(t, recorder)
	if body["error"] != errorMessage {
		t.Fatalf("响应体 = %v，期望 error=%q", body, errorMessage)
	}
}

// —— POST /login ——

func TestLoginSuccessCookieAttributes(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		hash, err := NewScryptHasher().Hash("right-password")
		if err != nil {
			t.Fatalf("Hash 失败：%v", err)
		}
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: "admin", PasswordHash: hash, PasswordChangedAt: testEpoch})
	})
	recorder := f.login(`{"username":"admin","password":"right-password"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v，期望 {ok:true}", body)
	}
	cookie := recorder.Header().Get("Set-Cookie")
	pattern := `^elysian_session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800$`
	if !regexp.MustCompile(pattern).MatchString(cookie) {
		t.Errorf("Set-Cookie 属性逐项不符：%q", cookie)
	}
}

func TestLoginWrongPassword401(t *testing.T) {
	f := newRoutesFixture(t, nil)
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	recorder := f.login(`{"username":"admin","password":"wrong-password"}`)
	wantStatusBody(t, recorder, http.StatusUnauthorized, "用户名或密码错误")
}

func TestLoginWrongUsername401DummyHashOnce(t *testing.T) {
	f := newRoutesFixture(t, nil)
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	recorder := f.login(`{"username":"nosuch","password":"whatever"}`)
	wantStatusBody(t, recorder, http.StatusUnauthorized, "用户名或密码错误")
	if len(f.hasher.verifyArgs) != 1 || f.hasher.verifyArgs[0].stored != DummyHash {
		t.Errorf("恰好一次哑哈希 verify，得 %v", f.hasher.verifyArgs)
	}
}

func TestLoginCredentialsMissing401(t *testing.T) {
	f := newRoutesFixture(t, nil)
	recorder := f.login(`{"username":"admin","password":"whatever"}`)
	wantStatusBody(t, recorder, http.StatusUnauthorized, "用户名或密码错误")
	if len(f.hasher.verifyArgs) != 1 || f.hasher.verifyArgs[0].stored != DummyHash {
		t.Errorf("凭据缺失也恰好一次哑哈希 verify，得 %v", f.hasher.verifyArgs)
	}
}

func TestLoginDevAccountDisabled(t *testing.T) {
	f := newRoutesFixture(t, nil)
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	recorder := f.login(`{"username":"dev","password":"dev-elysian"}`)
	wantStatusBody(t, recorder, http.StatusUnauthorized, "用户名或密码错误")
	if len(f.hasher.verifyArgs) != 1 || f.hasher.verifyArgs[0].stored != DummyHash {
		t.Errorf("dev 关闭时 dev 账号与任意错误口令无异，得 %v", f.hasher.verifyArgs)
	}
}

func TestLoginDevAccountEnabled(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.DevAccount = true
	})
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	recorder := f.login(`{"username":"dev","password":"dev-elysian"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	cookie := recorder.Header().Get("Set-Cookie")
	if !regexp.MustCompile(`^elysian_session=[A-Za-z0-9_-]{43}`).MatchString(cookie) {
		t.Fatalf("dev 登录走同一会话机制：%q", cookie)
	}
	// dev 登录的会话与 admin 凭据同 epoch：改密后同样失效。
	sessionRes := f.request(http.MethodGet, "/session", "", map[string]string{
		"Cookie": cookiePair(cookie),
	})
	body := decodeJSON(t, sessionRes)
	if body["authenticated"] != true || body["devAccount"] != true {
		t.Errorf("dev 会话探测 = %v，期望 authenticated:true devAccount:true", body)
	}
}

func TestLoginDevAccountWrongPassword401(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) { deps.DevAccount = true })
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	recorder := f.login(`{"username":"dev","password":"not-dev-password"}`)
	wantStatusBody(t, recorder, http.StatusUnauthorized, "用户名或密码错误")
	if len(f.hasher.verifyArgs) != 1 || f.hasher.verifyArgs[0].stored != DummyHash {
		t.Errorf("dev 密码错恰好一次哑哈希 verify，得 %v", f.hasher.verifyArgs)
	}
}

func TestLoginInvalidBodyShapes(t *testing.T) {
	// 放宽限额：本用例连发多次，锚定的是形状校验而不是限流（限流另有专测）。
	f := newRoutesFixture(t, func(deps *Deps) { deps.LoginRateLimit = 20 })
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	longUsername := strings.Repeat("a", 257)
	bodies := []string{
		`{}`,
		`{"username":"admin"}`,
		`{"username":"","password":"x"}`,
		`{"username":"admin","password":""}`,
		`{"username":1,"password":"x"}`,
		fmt.Sprintf(`{"username":%q,"password":"x"}`, longUsername),
		`["admin","x"]`,
	}
	for _, body := range bodies {
		recorder := f.login(body)
		wantStatusBody(t, recorder, http.StatusBadRequest, "请求体不合法")
	}
}

func TestLoginNonJSONContentType415(t *testing.T) {
	f := newRoutesFixture(t, nil)
	req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader("username=admin&password=x"))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Origin", testOrigin)
	req.Host = "localhost:5173"
	recorder := httptest.NewRecorder()
	f.router.ServeHTTP(recorder, req)
	wantStatusBody(t, recorder, http.StatusUnsupportedMediaType, "Content-Type 必须为 application/json")
}

func TestLoginRateLimit429AndRecovery(t *testing.T) {
	// 窗口用可控时钟推进（不依赖真实 sleep）：3 次尝试都在窗口内，滚过后恢复。
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.LoginRateLimit = 2
		deps.LoginRateWindow = 1500 * time.Millisecond
	})
	f.setCredentialsHash(t, mustHash(t, "right-password"))
	if recorder := f.login(`{"username":"admin","password":"right-password"}`); recorder.Code != http.StatusOK {
		t.Fatalf("第一次应 200，得 %d", recorder.Code)
	}
	if recorder := f.login(`{"username":"admin","password":"wrong"}`); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("第二次应 401，得 %d", recorder.Code)
	}
	limited := f.login(`{"username":"admin","password":"right-password"}`)
	wantStatusBody(t, limited, http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试")
	retryAfter, err := strconv.Atoi(limited.Header().Get("Retry-After"))
	if err != nil || retryAfter < 1 {
		t.Errorf("Retry-After = %q，期望 ≥1 的整秒", limited.Header().Get("Retry-After"))
	}

	f.clock.ms += 1600
	if recorder := f.login(`{"username":"admin","password":"right-password"}`); recorder.Code != http.StatusOK {
		t.Errorf("窗口滚过后恢复 200，得 %d", recorder.Code)
	}
}

func TestLoginCookieSecureSuffix(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.CookieSecure = true
		hash, err := NewScryptHasher().Hash("right-password")
		if err != nil {
			t.Fatalf("Hash 失败：%v", err)
		}
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: "admin", PasswordHash: hash, PasswordChangedAt: testEpoch})
	})
	recorder := f.login(`{"username":"admin","password":"right-password"}`)
	cookie := recorder.Header().Get("Set-Cookie")
	pattern := `^elysian_session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$`
	if !regexp.MustCompile(pattern).MatchString(cookie) {
		t.Errorf("ELYSIAN_COOKIE_SECURE=1 时末尾追加 ; Secure：%q", cookie)
	}
}

func TestLoginCrossOrigin403(t *testing.T) {
	f := newRoutesFixture(t, nil)
	recorder := f.request(http.MethodPost, "/login", `{"username":"admin","password":"x"}`, map[string]string{
		"Origin": "http://evil.example",
		"Host":   "localhost:5173",
	})
	wantStatusBody(t, recorder, http.StatusForbidden, "请求来源不允许")
}

func TestLoginDisabledAlwaysOK(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) { deps.Enabled = false })
	recorder := f.login(`{"username":"whatever","password":"whatever"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v", body)
	}
	if recorder.Header().Get("Set-Cookie") != "" {
		t.Error("演示语义不下发 Cookie")
	}
}

// —— POST /logout ——

func TestLogoutDestroysSessionAndClearsCookie(t *testing.T) {
	f := newRoutesFixture(t, nil)
	f.setCredentialsHash(t, mustHash(t, "p"))
	loginRes := f.login(`{"username":"admin","password":"p"}`)
	cookie := cookiePair(loginRes.Header().Get("Set-Cookie"))

	recorder := f.request(http.MethodPost, "/logout", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173", "Cookie": cookie,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if got := recorder.Header().Get("Set-Cookie"); got != "elysian_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" {
		t.Errorf("清 Cookie 整串不符：%q", got)
	}
	sessionRes := f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": cookie})
	body := decodeJSON(t, sessionRes)
	if body["authenticated"] != false {
		t.Errorf("登出后会话已销毁：%v", body)
	}
}

func TestLogoutIdempotentWithoutSession(t *testing.T) {
	f := newRoutesFixture(t, nil)
	recorder := f.request(http.MethodPost, "/logout", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v", body)
	}
	if !strings.Contains(recorder.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Error("幂等登出仍清 Cookie")
	}
}

func TestLogoutTriggersRevoke(t *testing.T) {
	connections := &spyConnections{}
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.SessionConns = connections
	})
	f.setCredentialsHash(t, mustHash(t, "p"))
	loginRes := f.login(`{"username":"admin","password":"p"}`)
	cookie := cookiePair(loginRes.Header().Get("Set-Cookie"))
	sessionID := strings.TrimPrefix(cookie, seam.SessionCookieName+"=")

	recorder := f.request(http.MethodPost, "/logout", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173", "Cookie": cookie,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if len(connections.revoked) != 1 || connections.revoked[0] != sessionID {
		t.Errorf("revoke 应以登录下发的会话 id 被调一次：%v", connections.revoked)
	}
}

// —— GET /session ——

func TestSessionProbeStates(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		hash, err := NewScryptHasher().Hash("right-password")
		if err != nil {
			t.Fatalf("Hash 失败：%v", err)
		}
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: "admin", PasswordHash: hash, PasswordChangedAt: testEpoch})
	})
	// 未登录。
	anonymous := f.request(http.MethodGet, "/session", "", nil)
	if anonymous.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", anonymous.Code)
	}
	if cache := anonymous.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control = %q，期望 no-store", cache)
	}
	body := decodeJSON(t, anonymous)
	if body["authenticated"] != false || body["devAccount"] != false {
		t.Errorf("未登录探测 = %v", body)
	}

	// 已登录。
	loginRes := f.login(`{"username":"admin","password":"right-password"}`)
	cookie := cookiePair(loginRes.Header().Get("Set-Cookie"))
	loggedIn := f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": cookie})
	body = decodeJSON(t, loggedIn)
	if body["authenticated"] != true || body["devAccount"] != false {
		t.Errorf("已登录探测 = %v", body)
	}

	// 改密后（epoch 变化）旧 Cookie 回 false。
	if _, err := f.credentials.Write(mustHash(t, "new-password")); err != nil {
		t.Fatalf("改密失败：%v", err)
	}
	afterChange := f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": cookie})
	body = decodeJSON(t, afterChange)
	if body["authenticated"] != false {
		t.Errorf("改密后探测 = %v，期望 authenticated:false", body)
	}
}

func TestSessionProbeDisabled(t *testing.T) {
	for _, devAccount := range []bool{false, true} {
		f := newRoutesFixture(t, func(deps *Deps) {
			deps.Enabled = false
			deps.DevAccount = devAccount
		})
		body := decodeJSON(t, f.request(http.MethodGet, "/session", "", nil))
		if body["authenticated"] != true || body["devAccount"] != devAccount {
			t.Errorf("演示语义恒已登录（dev=%v）：%v", devAccount, body)
		}
	}
}

// —— GET /session 的回跳裁决 ——

const returnTool = "http://127.0.0.1:5173"

func newReturnToFixture(t *testing.T, origins []string) *routesFixture {
	t.Helper()
	hash := mustHash(t, "return-password")
	return newRoutesFixture(t, func(deps *Deps) {
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: "admin", PasswordHash: hash, PasswordChangedAt: testEpoch})
		deps.ReturnOrigins = NewMemoryReturnOriginRegistry(origins)
	})
}

func (f *routesFixture) loginCookie(t *testing.T) string {
	t.Helper()
	loginRes := f.login(`{"username":"admin","password":"return-password"}`)
	if loginRes.Code != http.StatusOK {
		t.Fatalf("登录失败：%d（%s）", loginRes.Code, loginRes.Body.String())
	}
	return cookiePair(loginRes.Header().Get("Set-Cookie"))
}

func TestSessionReturnToKeySetUnchangedWithoutParam(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	cookie := f.loginCookie(t)
	body := decodeJSON(t, f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": cookie}))
	if len(body) != 2 {
		t.Errorf("不带 returnTo 时响应键不扩张：%v", body)
	}
	if _, has := body["returnTo"]; has {
		t.Error("不应含 returnTo 键")
	}
}

func TestSessionReturnToHit(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	cookie := f.loginCookie(t)
	recorder := f.request(http.MethodGet, "/session?returnTo="+encodeURIComponent(returnTool+"/projects/42"), "", map[string]string{"Cookie": cookie})
	body := decodeJSON(t, recorder)
	if body["authenticated"] != true || body["devAccount"] != false || body["returnTo"] != returnTool+"/projects/42" {
		t.Errorf("命中名单应回 href：%v", body)
	}
}

func TestSessionReturnToMiss(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	cookie := f.loginCookie(t)
	recorder := f.request(http.MethodGet, "/session?returnTo="+encodeURIComponent("http://127.0.0.1:9999/x"), "", map[string]string{"Cookie": cookie})
	body := decodeJSON(t, recorder)
	if body["returnTo"] != nil {
		t.Errorf("名单外回 null：%v", body)
	}
}

func TestSessionReturnToAnswersWhenLoggedOut(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	recorder := f.request(http.MethodGet, "/session?returnTo="+encodeURIComponent(returnTool+"/x"), "", nil)
	body := decodeJSON(t, recorder)
	if body["authenticated"] != false || body["returnTo"] != returnTool+"/x" {
		t.Errorf("未登录时也回答裁决：%v", body)
	}
}

// brokenRegistry 白名单读取恒报错的 fake。
type brokenRegistry struct{ err error }

func (r brokenRegistry) List() ([]string, error) { return nil, r.err }

func TestSessionReturnToRegistryErrorDegrades(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	cookie := f.loginCookie(t)
	// 复用登录时的 store：authenticated:true 只能来自代码而非夹具。
	broken := newRoutesFixture(t, func(deps *Deps) {
		deps.Credentials = f.credentials
		deps.Sessions = f.sessions
		deps.Hasher = f.deps.Hasher
		deps.ReturnOrigins = brokenRegistry{err: &codedError{code: "EACCES", message: "模拟读取故障"}}
		deps.Diag = f.deps.Diag
	})
	recorder := broken.request(http.MethodGet, "/session?returnTo="+encodeURIComponent(returnTool+"/x"), "", map[string]string{"Cookie": cookie})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	body := decodeJSON(t, recorder)
	if body["authenticated"] != true || body["returnTo"] != nil {
		t.Errorf("白名单报错不拖累探测，按空表判 null：%v", body)
	}
	diag := f.deps.Diag.(*bytes.Buffer).String()
	if !strings.HasPrefix(strings.TrimRight(diag, "\n"), SSOOriginsUnavailable+"：会话探测按空表回跳（EACCES）") {
		t.Errorf("期望一行含 errno 的中文诊断，得 %q", diag)
	}
}

func TestSessionReturnToNoStore(t *testing.T) {
	f := newReturnToFixture(t, []string{returnTool})
	cookie := f.loginCookie(t)
	recorder := f.request(http.MethodGet, "/session?returnTo="+encodeURIComponent(returnTool+"/x"), "", map[string]string{"Cookie": cookie})
	if cache := recorder.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("回答 returnTo 的分支同样 no-store，得 %q", cache)
	}
}

func TestSessionReturnToDisabledDemo(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Enabled = false
		deps.ReturnOrigins = NewMemoryReturnOriginRegistry([]string{returnTool})
	})
	body := decodeJSON(t, f.request(http.MethodGet, "/session?returnTo="+encodeURIComponent(returnTool+"/x"), "", nil))
	if _, has := body["returnTo"]; has {
		t.Errorf("演示语义不回答 returnTo：%v", body)
	}
}

// encodeURIComponent 百分号编码（URL query 值用）。
func encodeURIComponent(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case strings.ContainsRune("-_.!~*'()", r):
			b.WriteRune(r)
		default:
			for _, byte_ := range []byte(string(r)) {
				fmt.Fprintf(&b, "%%%02X", byte_)
			}
		}
	}
	return b.String()
}

func mustHash(t *testing.T, plain string) string {
	t.Helper()
	hash, err := NewScryptHasher().Hash(plain)
	if err != nil {
		t.Fatalf("Hash(%q) 失败：%v", plain, err)
	}
	return hash
}

// —— 设置端点（requireSession 之外的直驱行为）——

func newSettingsFixture(t *testing.T, mutate func(deps *Deps)) (*routesFixture, *recordingCredentialsStore) {
	t.Helper()
	hasher := newRecordingHasher()
	credentials := &recordingCredentialsStore{inner: NewMemoryCredentialsStore(&PanelCredentials{
		Username:          "admin",
		PasswordHash:      mustHash(t, "current-password"),
		PasswordChangedAt: testEpoch,
	})}
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Credentials = credentials
		deps.Hasher = hasher
		if mutate != nil {
			mutate(deps)
		}
	})
	return f, credentials
}

func (f *routesFixture) changePassword(body string, headers map[string]string) *httptest.ResponseRecorder {
	all := map[string]string{"Origin": testOrigin, "Host": "localhost:5173"}
	for name, value := range headers {
		all[name] = value
	}
	return f.request(http.MethodPost, "/password", body, all)
}

func TestPasswordChangeSuccess(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	before := credentials.InnerCurrent(t).PasswordChangedAt
	cookie := f.loginCookie2(t, "current-password")

	recorder := f.changePassword(`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, map[string]string{"Cookie": cookie})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v", body)
	}
	if got := recorder.Header().Get("Set-Cookie"); got != "elysian_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" {
		t.Errorf("成功清 Cookie：%q", got)
	}
	if credentials.writes != 1 {
		t.Fatalf("恰好一次 write，得 %d", credentials.writes)
	}
	ok, err := NewScryptHasher().Verify("brand-new-password", credentials.lastWrite)
	if err != nil || !ok {
		t.Errorf("write 收到可验证的新哈希：%q", credentials.lastWrite)
	}
	after := credentials.InnerCurrent(t).PasswordChangedAt
	if after == before {
		t.Errorf("passwordChangedAt 应前移：%q", after)
	}
}

func TestPasswordChangeWrongCurrent(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	recorder := f.changePassword(`{"currentPassword":"wrong-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, nil)
	wantStatusBody(t, recorder, http.StatusBadRequest, "当前密码不正确")
	if credentials.writes != 0 {
		t.Errorf("凭据不应被改写（writes=%d）", credentials.writes)
	}
}

func TestPasswordChangeMismatch(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	recorder := f.changePassword(`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"different-password"}`, nil)
	wantStatusBody(t, recorder, http.StatusBadRequest, "两次输入的密码不一致")
	if credentials.writes != 0 {
		t.Errorf("凭据不应被改写（writes=%d）", credentials.writes)
	}
}

func TestPasswordChangeTooShort(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	recorder := f.changePassword(`{"currentPassword":"current-password","newPassword":"short","confirmNewPassword":"short"}`, nil)
	wantStatusBody(t, recorder, http.StatusBadRequest, "密码至少需要 8 位")
	if credentials.writes != 0 {
		t.Errorf("凭据不应被改写（writes=%d）", credentials.writes)
	}
}

func TestPasswordChangeInvalidBodyShapes(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	confirmLong := strings.Repeat("brand-new-password", 20)
	bodies := []string{
		`{}`,
		`{"newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		`{"currentPassword":"","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		`{"currentPassword":"current-password","newPassword":"","confirmNewPassword":"brand-new-password"}`,
		fmt.Sprintf(`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":%q}`, confirmLong),
		`{"currentPassword":1,"newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		`["current-password"]`,
	}
	for _, body := range bodies {
		recorder := f.changePassword(body, nil)
		wantStatusBody(t, recorder, http.StatusBadRequest, "请求体不合法")
	}
	if credentials.writes != 0 {
		t.Errorf("凭据不应被改写（writes=%d）", credentials.writes)
	}
}

func TestPasswordChangeNonJSON415(t *testing.T) {
	f, _ := newSettingsFixture(t, nil)
	req := httptest.NewRequest(http.MethodPost, "/password", strings.NewReader("currentPassword=a"))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Origin", testOrigin)
	req.Host = "localhost:5173"
	recorder := httptest.NewRecorder()
	f.router.ServeHTTP(recorder, req)
	wantStatusBody(t, recorder, http.StatusUnsupportedMediaType, "Content-Type 必须为 application/json")
}

func TestPasswordChangeCredentialsUnavailable(t *testing.T) {
	f := newRoutesFixture(t, nil) // 空内存凭据
	recorder := f.changePassword(`{"currentPassword":"whatever","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, nil)
	wantStatusBody(t, recorder, http.StatusBadRequest, "面板凭据不可用，无法修改密码")
}

// ioErrorCredentials Current 正常、Write 恒失败（写盘 IO 故障分型）。
type ioErrorCredentials struct{ inner CredentialsStore }

func (s *ioErrorCredentials) Current() (*PanelCredentials, error) { return s.inner.Current() }

func (s *ioErrorCredentials) Write(string) (*PanelCredentials, error) {
	return nil, fmt.Errorf("EACCES: permission denied, open '/root/.Elysian/config/panel-credentials.json.tmp'")
}

func TestPasswordChangeWriteIOError500(t *testing.T) {
	ioErr := &ioErrorCredentials{inner: NewMemoryCredentialsStore(&PanelCredentials{
		Username: "admin", PasswordHash: mustHash(t, "current-password"), PasswordChangedAt: testEpoch,
	})}
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Credentials = ioErr
		deps.Hasher = newRecordingHasher()
	})
	cookie := f.loginCookie2(t, "current-password")
	recorder := f.changePassword(`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, map[string]string{"Cookie": cookie})
	wantStatusBody(t, recorder, http.StatusInternalServerError,
		"EACCES: permission denied, open '/root/.Elysian/config/panel-credentials.json.tmp'")
}

func TestPasswordChangeTriggersRevokeAll(t *testing.T) {
	connections := &spyConnections{}
	f, _ := newSettingsFixture(t, func(deps *Deps) { deps.SessionConns = connections })

	wrong := f.changePassword(`{"currentPassword":"wrong-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, nil)
	if wrong.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d", wrong.Code)
	}
	if connections.revokeAlls != 0 {
		t.Error("当前密码错时不触发 revokeAll")
	}
	recorder := f.changePassword(`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if connections.revokeAlls != 1 {
		t.Errorf("改密成功触发一次 revokeAll（得 %d）", connections.revokeAlls)
	}
}

// loginCookie2 以指定密码登录取 Cookie 段（设置端点夹具共用）。
func (f *routesFixture) loginCookie2(t *testing.T, password string) string {
	t.Helper()
	loginRes := f.login(fmt.Sprintf(`{"username":"admin","password":%q}`, password))
	if loginRes.Code != http.StatusOK {
		t.Fatalf("登录失败：%d（%s）", loginRes.Code, loginRes.Body.String())
	}
	return cookiePair(loginRes.Header().Get("Set-Cookie"))
}

// InnerCurrent 取被包装 store 的当前凭据（测试断言用）。
func (s *recordingCredentialsStore) InnerCurrent(t *testing.T) *PanelCredentials {
	t.Helper()
	current, err := s.inner.Current()
	if err != nil || current == nil {
		t.Fatalf("取当前凭据失败：%v", err)
	}
	return current
}

// —— GET /sessions ——

func TestSessionsListProjection(t *testing.T) {
	clock := &fakeClock{ms: 1_760_000_000_000}
	sessions := NewMemorySessionStore(clock.now)
	if _, err := sessions.Create(testEpoch); err != nil { // oldest：随后过期
		t.Fatalf("Create 失败：%v", err)
	}
	clock.ms += 60_000
	if _, err := sessions.Create(testEpoch); err != nil { // middle：仍有效、非当前
		t.Fatalf("Create 失败：%v", err)
	}
	clock.ms += int64(SessionIdleTTL/time.Millisecond) - 30_000
	current, err := sessions.Create(testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}

	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Sessions = sessions
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{
			Username: "admin", PasswordHash: mustHash(t, "p"), PasswordChangedAt: testEpoch,
		})
	})
	recorder := f.request(http.MethodGet, "/sessions", "", map[string]string{"Cookie": "elysian_session=" + current.ID})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if cache := recorder.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control = %q", cache)
	}
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应失败：%v", err)
	}
	if len(body.Sessions) != 2 {
		t.Fatalf("过期会话不出现，只剩两行：%v", body.Sessions)
	}
	for _, row := range body.Sessions {
		if len(row) != 3 {
			t.Errorf("三字段投影：%v", row)
		}
		if _, ok := row["createdAt"]; !ok {
			t.Errorf("缺 createdAt：%v", row)
		}
		if _, ok := row["lastUsedAt"]; !ok {
			t.Errorf("缺 lastUsedAt：%v", row)
		}
	}
	if strings.Contains(recorder.Body.String(), "pwdEpoch") {
		t.Error("JSON 不含 pwdEpoch")
	}
	if strings.Contains(recorder.Body.String(), current.ID) {
		t.Error("JSON 不含会话 id")
	}
	// 恰一行 current:true 且排最前（最近活跃倒序）。
	if body.Sessions[0]["current"] != true || body.Sessions[1]["current"] != false {
		t.Errorf("恰一行 current:true 排最前：%v", body.Sessions)
	}
	first, _ := time.Parse(time.RFC3339, body.Sessions[0]["lastUsedAt"].(string))
	second, _ := time.Parse(time.RFC3339, body.Sessions[1]["lastUsedAt"].(string))
	if !first.After(second) {
		t.Errorf("按最近活跃倒序：%v / %v", first, second)
	}
	// 倒序首行的 lastUsedAt 就是当前会话的创建时刻（可控时钟的 now）。
	if first.UnixMilli() != clock.ms {
		t.Errorf("倒序首行 lastUsedAt = %d，期望 %d", first.UnixMilli(), clock.ms)
	}
}

// —— POST /sessions/logout-others ——

func TestLogoutOthersKeepsCurrent(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{
			Username: "admin", PasswordHash: mustHash(t, "p"), PasswordChangedAt: testEpoch,
		})
	})
	first, _ := f.sessions.Create(testEpoch)
	second, _ := f.sessions.Create(testEpoch)
	third, _ := f.sessions.Create(testEpoch)

	recorder := f.request(http.MethodPost, "/sessions/logout-others", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173", "Cookie": "elysian_session=" + second.ID,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v", body)
	}
	for id, expectValid := range map[string]bool{first.ID: false, second.ID: true, third.ID: false} {
		validated, err := f.sessions.Validate(id, testEpoch)
		if err != nil {
			t.Fatalf("Validate 失败：%v", err)
		}
		if (validated != nil) != expectValid {
			t.Errorf("会话 %s 有效=%v，期望 %v", id, validated != nil, expectValid)
		}
	}
	list := f.request(http.MethodGet, "/sessions", "", map[string]string{"Cookie": "elysian_session=" + second.ID})
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应失败：%v", err)
	}
	if len(body.Sessions) != 1 || body.Sessions[0]["current"] != true {
		t.Errorf("随后 GET /sessions 只剩当前行：%v", body.Sessions)
	}
}

func TestLogoutOthersTriggersRevokeOthers(t *testing.T) {
	connections := &spyConnections{}
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.SessionConns = connections
		deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{
			Username: "admin", PasswordHash: mustHash(t, "p"), PasswordChangedAt: testEpoch,
		})
	})
	if _, err := f.sessions.Create(testEpoch); err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	current, err := f.sessions.Create(testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	recorder := f.request(http.MethodPost, "/sessions/logout-others", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173", "Cookie": "elysian_session=" + current.ID,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", recorder.Code)
	}
	if len(connections.revokeOthers) != 1 || connections.revokeOthers[0] != current.ID {
		t.Errorf("revokeOthers(当前 id) 恰一次：%v", connections.revokeOthers)
	}
}

// —— enabled:false 的设置端点 ——

func TestSettingsDisabled503NoFiles(t *testing.T) {
	dir := tempDir(t)
	credentialsPath := filepath.Join(dir, "config", "panel-credentials.json")
	sessionsPath := filepath.Join(dir, "state", "panel-sessions.json")
	f := newRoutesFixture(t, func(deps *Deps) {
		deps.Enabled = false
		deps.Credentials = NewFileCredentialsStore(credentialsPath)
		deps.Sessions = NewFileSessionStore(sessionsPath, nil)
	})

	wantStatusBody(t, f.changePassword(`{"currentPassword":"a","newPassword":"b","confirmNewPassword":"c"}`, nil),
		http.StatusServiceUnavailable, AuthDisabledMessage)
	wantStatusBody(t, f.request(http.MethodGet, "/sessions", "", nil),
		http.StatusServiceUnavailable, AuthDisabledMessage)
	wantStatusBody(t, f.request(http.MethodPost, "/sessions/logout-others", "", map[string]string{
		"Origin": testOrigin, "Host": "localhost:5173",
	}), http.StatusServiceUnavailable, AuthDisabledMessage)

	for _, path := range []string{credentialsPath, sessionsPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("不应写任何文件：%s", path)
		}
	}
}

// —— 未知端点 ——

func TestUnknownEndpoint404(t *testing.T) {
	f := newRoutesFixture(t, nil)
	recorder := f.request(http.MethodGet, "/nowhere", "", nil)
	wantStatusBody(t, recorder, http.StatusNotFound, "未知鉴权端点：GET /nowhere")
}

func TestMethodMismatchFallsTo404(t *testing.T) {
	// Hono app.all('*') 语义：已注册路径的方法不匹配同样落 404 兜底，不是 405。
	f := newRoutesFixture(t, nil)
	recorder := f.request(http.MethodGet, "/login", "", nil)
	wantStatusBody(t, recorder, http.StatusNotFound, "未知鉴权端点：GET /login")
}

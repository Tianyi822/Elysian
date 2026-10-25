package client

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// 传输层契约测试：Origin 头逐字注入（§3.2）、Cookie 注入、五态错误分类（§3.1）
// 与登录形状（client:"cli" 分道会话）。桩服务器对齐后端真实行为（同源守卫、错误
// 正文 {error,code}、Set-Cookie 形态）。

// recordingServer 记录请求并按路由表响应；路由表未命中回 404。
type recordingServer struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
}

type recordedRequest struct {
	Method      string
	Path        string
	Query       string
	Origin      string
	Host        string
	Cookie      string
	ContentType string
	Body        string
}

func newRecordingServer(routes map[string]http.HandlerFunc) *recordingServer {
	rec := &recordingServer{}
	mux := http.NewServeMux()
	for pattern, handler := range routes {
		handler := handler
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body))
			rec.mu.Lock()
			rec.requests = append(rec.requests, recordedRequest{
				Method:      r.Method,
				Path:        r.URL.Path,
				Query:       r.URL.RawQuery,
				Origin:      r.Header.Get("Origin"),
				Host:        r.Host,
				Cookie:      r.Header.Get("Cookie"),
				ContentType: r.Header.Get("Content-Type"),
				Body:        string(body),
			})
			rec.mu.Unlock()
			handler(w, r)
		})
	}
	rec.server = httptest.NewServer(mux)
	return rec
}

func (r *recordingServer) URL() string { return r.server.URL }

func (r *recordingServer) last() recordedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.requests[len(r.requests)-1]
}

func (r *recordingServer) Close() { r.server.Close() }

func respondJSON(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// TestOriginAndCookieInjectionEveryRequest Origin 契约：全部请求（含 GET 与写请求）
// 携带与 Host 逐字一致的 Origin；会话 Cookie 注入 Cookie 头；写请求带 JSON
// Content-Type——同源守卫（middleware/guard.go:35-49）的通过前提。
func TestOriginAndCookieInjectionEveryRequest(t *testing.T) {
	sameOriginGuard := func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == "" || r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "origin mismatch", http.StatusForbidden)
			return
		}
		respondJSON(200, `{"items":[],"nextCursor":"","hasMore":false}`)(w, r)
	}
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions": sameOriginGuard,
	})
	defer rec.Close()

	c := New(rec.URL())
	c.SetSessionCookie("sess-1")
	page, err := c.ListSessionsByActivity(context.Background(), "")
	if err != nil {
		t.Fatalf("GET 应通过同源判定：%v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("空页解析失败：%+v", page)
	}
	got := rec.last()
	if got.Origin != "http://"+got.Host {
		t.Fatalf("Origin 应与 Host 逐字一致：origin=%q host=%q", got.Origin, got.Host)
	}
	if got.Cookie != "elysian_session=sess-1" {
		t.Fatalf("Cookie 应注入 elysian_session：%q", got.Cookie)
	}
	if got.Query != "limit=50&sort=activity" {
		t.Fatalf("会话列表应带活动排序与 50 页大小：%q", got.Query)
	}

	// 写请求（POST）在同源判定下同样通过，且带 JSON Content-Type。
	if _, err := c.CreateSession(context.Background(), CreateSessionInput{Title: "t", ModelProfileID: "p1", ModelRevision: 3}); err != nil {
		t.Fatalf("POST 应通过同源判定：%v", err)
	}
	write := rec.last()
	if write.Method != "POST" || write.ContentType != "application/json" {
		t.Fatalf("写请求应为 POST + JSON：%+v", write)
	}
	if write.Origin != "http://"+write.Host {
		t.Fatalf("写请求 Origin 应与 Host 一致：%q vs %q", write.Origin, write.Host)
	}
}

// TestLoginCLIChannelAndCookieExtraction 登录契约：请求体含 client:"cli"；成功提取
// Set-Cookie 的 elysian_session；失败 401 回服务端中文消息。
func TestLoginCLIChannelAndCookieExtraction(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/auth/login": func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client"] != "cli" || body["username"] != "admin" {
				http.Error(w, "bad body", http.StatusBadRequest)
				return
			}
			w.Header().Set("Set-Cookie", "elysian_session=cli-cookie-1; Path=/; HttpOnly; Max-Age=1209600; SameSite=Lax")
			_, _ = io.WriteString(w, `{"ok":true}`)
		},
	})
	defer rec.Close()

	c := New(rec.URL())
	if err := c.Login(context.Background(), "admin", "secret"); err != nil {
		t.Fatalf("登录应成功：%v", err)
	}
	if c.SessionCookie() != "cli-cookie-1" {
		t.Fatalf("应从 Set-Cookie 提取会话值，得到 %q", c.SessionCookie())
	}
	if got := rec.last().ContentType; got != "application/json" {
		t.Fatalf("登录请求应为 JSON：%q", got)
	}
}

func TestLoginWrongPasswordSurfacesServerError(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/auth/login": respondJSON(401, `{"error":"用户名或密码错误"}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	err := c.Login(context.Background(), "admin", "bad")
	if err == nil {
		t.Fatal("401 应报错")
	}
	e, ok := err.(*Error)
	if !ok {
		t.Fatalf("应返回 *Error，得到 %T", err)
	}
	if e.Kind != KindUnauthorized || e.Message != "用户名或密码错误" {
		t.Fatalf("401 分类与消息不符：%+v", e)
	}
}

// TestLoginRateLimitCarriesRetryAfter 登录限流 429：Retry-After 头转为建议秒数。
func TestLoginRateLimitCarriesRetryAfter(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "37")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(429)
			_, _ = io.WriteString(w, `{"error":"登录尝试过于频繁，请稍后再试"}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	err := c.Login(context.Background(), "admin", "x")
	e, ok := err.(*Error)
	if !ok || e.RetryAfter != 37 || e.Message != "登录尝试过于频繁，请稍后再试" {
		t.Fatalf("429 应带 Retry-After=37 与服务端消息：%+v", err)
	}
}

// TestProbeSessionPassiveQuery 判活请求带 ?passive=1（不续期空闲期）。
func TestProbeSessionPassiveQuery(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/auth/session": respondJSON(200, `{"authenticated":true,"devAccount":false}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	ok, err := c.ProbeSession(context.Background())
	if err != nil || !ok {
		t.Fatalf("判活应成功且已登录：%v %v", ok, err)
	}
	if got := rec.last().Query; got != "passive=1" {
		t.Fatalf("判活应带 passive=1：%q", got)
	}
}

// TestKindClassificationMatrix 五态分类矩阵：连接拒绝→未启动；超时→连接异常；
// 401→无权限；403→版本错位；503→Agent 不可用；其余→服务端错误。
func TestKindClassificationMatrix(t *testing.T) {
	// 连接拒绝：取空闲端口（无监听者）后立即请求。
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("无法获取空闲端口：%v", err)
	}
	deadURL := "http://" + listener.Addr().String()
	listener.Close()
	c := New(deadURL)
	_, err = c.GetSession(context.Background(), "s1")
	if e, ok := err.(*Error); !ok || e.Kind != KindNotRunning {
		t.Fatalf("连接拒绝应判未启动：%v", err)
	}

	// 超时：桩延迟超过客户端时限。
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, "{}")
	}))
	defer slow.Close()
	c = New(slow.URL)
	c.http.Timeout = 80 * time.Millisecond
	if _, err := c.GetSession(context.Background(), "s1"); err == nil {
		t.Fatal("超时应报错")
	} else if e, ok := err.(*Error); !ok || e.Kind != KindUnreachable {
		t.Fatalf("超时应判连接异常：%v", err)
	}

	// 状态码矩阵。
	for _, tc := range []struct {
		status int
		kind   Kind
	}{
		{401, KindUnauthorized},
		{403, KindForbidden},
		{503, KindUnavailable},
		{409, KindServer},
	} {
		rec := newRecordingServer(map[string]http.HandlerFunc{
			"/api/agent/sessions/s1": respondJSON(tc.status, `{"error":"服务端消息","code":"some-code"}`),
		})
		c := New(rec.URL())
		_, err := c.GetSession(context.Background(), "s1")
		rec.Close()
		e, ok := err.(*Error)
		if !ok || e.Kind != tc.kind || e.Status != tc.status {
			t.Fatalf("HTTP %d 应分类 %d，得到 %+v", tc.status, tc.kind, err)
		}
		if e.Message != "服务端消息" || e.Code != "some-code" {
			t.Fatalf("服务端正文应保留：%+v", e)
		}
		if e.Hint == "" && tc.status != 409 {
			t.Fatalf("五态错误应带提示：%+v", e)
		}
	}
}

// TestBadResponseClassified 2xx 但响应体非契约 JSON：判 KindBadResponse，不静默。
func TestBadResponseClassified(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1": respondJSON(200, `{"id":42}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	if _, err := c.GetSession(context.Background(), "s1"); err == nil {
		t.Fatal("id 非字符串应解析失败")
	} else if e, ok := err.(*Error); !ok || e.Kind != KindBadResponse {
		t.Fatalf("解析失败应判 KindBadResponse：%v", err)
	}
}

// TestHintForForbiddenHint 403 提示指向升级动作（版本错位兜底，§3.1）。
func TestHintForForbiddenHint(t *testing.T) {
	if hint := HintFor(KindForbidden); !strings.Contains(hint, "install.sh") {
		t.Fatalf("403 提示应指向安装脚本：%q", hint)
	}
	if hint := HintFor(KindNotRunning); !strings.Contains(hint, "systemctl start elysian") {
		t.Fatalf("未启动提示应指向启动命令：%q", hint)
	}
}

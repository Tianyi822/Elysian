// Package middleware 的骨架测试：钉住请求 ID、剥尾斜杠、同源判定与读体守卫的口径。
package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

// recordingHandler 记录中间件改写后的请求形状。
type recordingHandler struct {
	path   string
	called bool
}

func (h *recordingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.called = true
	h.path = r.URL.Path
	w.WriteHeader(http.StatusOK)
}

func TestRequestID(t *testing.T) {
	cases := []struct {
		name       string
		inbound    string
		wantEchoed bool
	}{
		{"合法回显", "abc-123", true},
		{"缺失自生成", "", false},
		{"超长拒绝", strings.Repeat("a", 129), false},
		{"含空白拒绝", "bad id", false},
		{"中文拒绝", "请求", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
			if tc.inbound != "" {
				req.Header.Set(RequestIDHeader, tc.inbound)
			}
			RequestID(&recordingHandler{}).ServeHTTP(rec, req)
			got := rec.Header().Get(RequestIDHeader)
			if got == "" {
				t.Fatal("响应头缺少 X-Request-Id")
			}
			if tc.wantEchoed && got != tc.inbound {
				t.Errorf("应回显 %q，实际 %q", tc.inbound, got)
			}
			if !tc.wantEchoed && got == tc.inbound {
				t.Errorf("不应回显非法值 %q", tc.inbound)
			}
			if !tc.wantEchoed && len(got) != 16 {
				t.Errorf("自生成请求 ID 应为 16 位 hex，实际 %q", got)
			}
		})
	}
}

func TestStripTailSlash(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"单斜杠剥一层", "/api/auth/login/", "/api/auth/login"},
		{"双斜杠只剥一层", "/api/auth/login//", "/api/auth/login/"},
		{"根路径不变", "/", "/"},
		{"无尾斜杠不变", "/api/auth/login", "/api/auth/login"},
		{"非 API 不剥", "/about/", "/about/"},
		{"api 根剥斜杠", "/api/", "/api"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &recordingHandler{}
			StripTailSlash(h).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, tc.in, nil))
			if !h.called {
				t.Fatal("中间件未放行到下一层")
			}
			if h.path != tc.want {
				t.Errorf("路径 %q 剥后为 %q，期望 %q", tc.in, h.path, tc.want)
			}
		})
	}
}

func TestSameOrigin(t *testing.T) {
	makeReq := func(method, origin, host string) *http.Request {
		req := httptest.NewRequest(method, "/api/x", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		req.Host = host
		return req
	}
	cases := []struct {
		name   string
		method string
		origin string
		host   string
		want   bool
	}{
		{"GET 免校验", http.MethodGet, "", "127.0.0.1:48101", true},
		{"HEAD 免校验", http.MethodHead, "", "127.0.0.1:48101", true},
		{"写请求同源回环", http.MethodPost, "http://127.0.0.1:48101", "127.0.0.1:48101", true},
		{"写请求同源 localhost", http.MethodPut, "http://localhost:48101", "localhost:48101", true},
		{"写请求缺 Origin", http.MethodPost, "", "127.0.0.1:48101", false},
		{"写请求跨源", http.MethodPost, "http://evil.example", "127.0.0.1:48101", false},
		{"写请求 Host 不在名单", http.MethodPost, "http://lan-host:48101", "lan-host:48101", false},
		{"大小写归一", http.MethodPost, "http://LOCALHOST:48101", "localhost:48101", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SameOrigin(makeReq(tc.method, tc.origin, tc.host)); got != tc.want {
				t.Errorf("SameOrigin = %v，期望 %v", got, tc.want)
			}
		})
	}
	// WS 升级专用版：GET 也不放行。
	if SameOriginUpgrade(makeReq(http.MethodGet, "", "127.0.0.1:48101")) {
		t.Error("SameOriginUpgrade 对缺 Origin 的 GET 应当拒绝")
	}
	if !SameOriginUpgrade(makeReq(http.MethodGet, "http://127.0.0.1:48101", "127.0.0.1:48101")) {
		t.Error("SameOriginUpgrade 对同源回环 GET 应当放行")
	}
}

func TestSameOriginGuardForbidden(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/x", nil)
	req.Header.Set("Origin", "http://evil.example")
	req.Host = "127.0.0.1:48101"
	rec := httptest.NewRecorder()
	SameOriginGuard()(&recordingHandler{}).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("状态码 = %d，期望 403", rec.Code)
	}
	if body := rec.Body.String(); body != `{"error":"请求来源不允许"}` {
		t.Errorf("响应体 = %q，期望 403 中文文案", body)
	}
}

func TestReadJSONBody(t *testing.T) {
	t.Run("Content-Type 错误 415", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "text/plain")
		_, err := ReadJSONBody(httptest.NewRecorder(), req, 0)
		assertGuardError(t, err, http.StatusUnsupportedMediaType, "Content-Type 必须为 application/json")
	})
	t.Run("申报超限 413", func(t *testing.T) {
		body := strings.Repeat(" ", 10)
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		_, err := ReadJSONBody(httptest.NewRecorder(), req, 4)
		assertGuardError(t, err, http.StatusRequestEntityTooLarge, "请求体过大")
	})
	t.Run("实读超限 413", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader(`{"a":"0123456789"}`))
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = -1 // 隐去申报长度，逼实读累计路径
		_, err := ReadJSONBody(httptest.NewRecorder(), req, 8)
		assertGuardError(t, err, http.StatusRequestEntityTooLarge, "请求体过大")
	})
	t.Run("空体 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader("   "))
		req.Header.Set("Content-Type", "application/json")
		_, err := ReadJSONBody(httptest.NewRecorder(), req, 0)
		assertGuardError(t, err, http.StatusBadRequest, "请求体不能为空")
	})
	t.Run("坏 JSON 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader("{bad"))
		req.Header.Set("Content-Type", "application/json")
		_, err := ReadJSONBody(httptest.NewRecorder(), req, 0)
		assertGuardError(t, err, http.StatusBadRequest, "请求体不是有效 JSON")
	})
	t.Run("合法体解析", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader(`{"ok":true}`))
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		got, err := ReadJSONBody(httptest.NewRecorder(), req, 0)
		if err != nil {
			t.Fatalf("合法体不应报错：%v", err)
		}
		obj, ok := got.(map[string]any)
		if !ok || obj["ok"] != true {
			t.Errorf("解析结果 = %#v，期望 {ok:true}", got)
		}
	})
}

func TestWriteErrorMapping(t *testing.T) {
	t.Run("守卫错误按自带状态", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, shared.InvalidRequest("参数不合法"))
		if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"参数不合法"}` {
			t.Errorf("状态 %d 响应 %q", rec.Code, rec.Body.String())
		}
	})
	t.Run("未知错误一律 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, errString("服务端故障"))
		if rec.Code != http.StatusInternalServerError || rec.Body.String() != `{"error":"服务端故障"}` {
			t.Errorf("状态 %d 响应 %q", rec.Code, rec.Body.String())
		}
	})
}

func TestEndpointErrorHandlerRecoversPanic(t *testing.T) {
	boom := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(shared.InvalidRequest("炸了"))
	})
	rec := httptest.NewRecorder()
	EndpointErrorHandler(boom).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"炸了"}` {
		t.Errorf("panic 应经同路径映射：状态 %d 响应 %q", rec.Code, rec.Body.String())
	}
}

func assertGuardError(t *testing.T, err error, wantStatus int, wantMessage string) {
	t.Helper()
	if err == nil {
		t.Fatal("期望错误，实际为 nil")
	}
	var guard *shared.EndpointGuardError
	var invalid *shared.InvalidRequestError
	switch {
	case errors.As(err, &guard):
		checkErr(t, guard.Status, guard.Message, wantStatus, wantMessage)
	case errors.As(err, &invalid):
		checkErr(t, invalid.Status, invalid.Message, wantStatus, wantMessage)
	default:
		t.Fatalf("错误类型不含状态：%v", err)
	}
}

func checkErr(t *testing.T, status int, message string, wantStatus int, wantMessage string) {
	t.Helper()
	if status != wantStatus || message != wantMessage {
		t.Errorf("错误 = (%d, %q)，期望 (%d, %q)", status, message, wantStatus, wantMessage)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

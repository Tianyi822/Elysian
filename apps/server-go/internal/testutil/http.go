// Package testutil 提供 Go 测试共用的 HTTP 夹具，不参与生产装配。
package testutil

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
)

func SameOriginHeaders(host string) map[string]string {
	return map[string]string{"Host": host, "Origin": "http://" + host}
}

func Do(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func DoJSON(t testing.TB, handler http.Handler, req *http.Request, dst any) int {
	t.Helper()
	rec := Do(handler, req)
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("响应不是 JSON：%q", rec.Body.String())
	}
	return rec.Code
}

func MountAt(path string, handler http.Handler) http.Handler {
	parent := chi.NewRouter()
	parent.Use(middleware.StripTailSlash)
	parent.Mount(path, handler)
	return parent
}

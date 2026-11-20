package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSecurityProxyDeadlineCancelsBodyRead(t *testing.T) {
	done := make(chan struct{})
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); close(done) })
	w := httptest.NewRecorder()
	boundedSecurityProxy(proxy, 20*time.Millisecond).ServeHTTP(w, httptest.NewRequest("GET", "/api/security/firewall", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "操作结果尚未确认") {
		t.Fatal(w.Code, w.Body.String())
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("代理响应体读取没有取消")
	}
}

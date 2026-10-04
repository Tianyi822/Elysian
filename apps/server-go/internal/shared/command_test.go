package shared

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSystemCommandDeadlineEndsInheritedPipes(t *testing.T) {
	ctx, stop := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer stop()
	cmd, bounded, cancel := SystemCommand(ctx, "sh", "-c", "sleep 60 & wait")
	defer cancel()
	start := time.Now()
	_, err := cmd.Output()
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatal("系统命令或继承管道的子进程未被有界终止")
	}
	if err := SystemCommandError(bounded, err); !strings.Contains(err.Error(), "操作结果尚未确认") {
		t.Fatal(err)
	}
}

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

package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

func TestLocalDemoAgentReportsUnavailableWithoutStartingResources(t *testing.T) {
	handler, closeResource, err := newProductionHarness(&config.Config{}, nil)
	if err != nil || closeResource != nil {
		t.Fatalf("演示模式不得创建资源：%v", err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/runtime", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Fatalf("应报告不可用：%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, sameOriginRequest(http.MethodPost, "/runs", `{}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("演示任务不能伪装为已创建：%d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentAssemblyIsBehindSessionGuard(t *testing.T) {
	var requests, closes atomic.Int32
	factory := func(*config.Config, seam.DockerViews) (http.Handler, func(context.Context) error, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { requests.Add(1); w.WriteHeader(http.StatusNoContent) }),
			func(context.Context) error { closes.Add(1); return nil }, nil
	}
	runtime, err := newAssembly(&config.Config{}, &fakeLogsService{}, auth.Deps{Enabled: true, Credentials: fakeCredentialsStore{}, Sessions: auth.NewMemorySessionStore(nil)}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	for _, target := range []string{"/api/agent/runtime", "/api/agent/runs", "/api/agent/sessions", "/api/agent/sessions/s/messages", "/api/agent/runs/r/model-requests", "/api/agent/runs/r/output", "/api/agent/memory-spaces", "/api/agent/memory-extractions", "/api/agent/wiki/spaces", "/api/agent/sessions/s/authorizations"} {
		rec := httptest.NewRecorder()
		runtime.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s 必须鉴权：%d", target, rec.Code)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("未登录请求进入了 Agent 路由")
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if closes.Load() != 1 {
		t.Fatalf("资源只应关闭一次：%d", closes.Load())
	}
}

func TestAgentStorageFailureDoesNotStopPanel(t *testing.T) {
	logs := &fakeLogsService{}
	factory := func(*config.Config, seam.DockerViews) (http.Handler, func(context.Context) error, error) {
		return nil, nil, errors.New("测试存储不可写")
	}
	runtime, err := newAssembly(&config.Config{}, logs, auth.Deps{Enabled: false, Credentials: fakeCredentialsStore{}, Sessions: auth.NewMemorySessionStore(nil)}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	for _, test := range []struct {
		path   string
		status int
	}{{"/api/health", 200}, {"/api/agent/runtime", 200}, {"/api/agent/runs", 503}} {
		rec := httptest.NewRecorder()
		runtime.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, test.path, nil))
		if rec.Code != test.status {
			t.Fatalf("%s：%d %s", test.path, rec.Code, rec.Body.String())
		}
	}
	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.runtimes) == 0 || logs.runtimes[0][1] != "server.agent" {
		t.Fatal("装配失败必须写运行日志")
	}
}

func TestRuntimeCloseCanContinueWaitingAfterTimeout(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	runtime := &Runtime{closeDone: make(chan struct{}), closeFuncs: []func(context.Context) error{func(context.Context) error { close(started); <-release; return nil }}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.Close(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("等待应取消：%v", err)
	}
	<-started
	close(release)
	wait, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := runtime.Close(wait); err != nil {
		t.Fatalf("再次关闭应能等同一次收尾：%v", err)
	}
}

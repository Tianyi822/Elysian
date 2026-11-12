package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

type countedSessionStore struct {
	auth.SessionStore
	checks, validates atomic.Int32
}

type countedSessionConnections struct {
	seam.SessionConnections
	registered atomic.Int32
}

func (c *countedSessionConnections) Register(id string, close func()) func() {
	c.registered.Add(1)
	return c.SessionConnections.Register(id, close)
}

func (s *countedSessionStore) Check(id, epoch string) (*auth.PanelSession, error) {
	s.checks.Add(1)
	return s.SessionStore.Check(id, epoch)
}
func (s *countedSessionStore) Validate(id, epoch string) (*auth.PanelSession, error) {
	s.validates.Add(1)
	return s.SessionStore.Validate(id, epoch)
}

func TestOnlyAgentOutputUsesPassiveStreamGuard(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		passive      bool
		socket       bool
	}{
		{http.MethodGet, "/api/agent/runs/run-1/output", true, false},
		{http.MethodGet, "/api/agent/runs/run-1", false, false},
		{http.MethodGet, "/api/agent/runs/run-1/model-requests", false, false},
		{http.MethodPost, "/api/agent/runs/run-1/output", false, false},
		{http.MethodGet, "/api/agent/runs/a/b/output", false, false},
		{http.MethodGet, "/api/agent/runs//output", false, false},
		{http.MethodGet, "/api/terminals/ws", false, true},
		{http.MethodGet, "/api/terminals/status", false, false},
		{http.MethodPost, "/api/terminals/ws", false, false},
		{http.MethodGet, "/api/docker/containers/abc123/terminal", false, true},
		{http.MethodGet, "/api/docker/containers//terminal", false, false},
		{http.MethodGet, "/api/docker/containers/a/b/terminal", false, false},
		{http.MethodGet, "/api/database/sql-session/ws", false, false},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			store := &countedSessionStore{SessionStore: auth.NewMemorySessionStore(nil)}
			session, _, err := store.Create("none", "")
			if err != nil {
				t.Fatal(err)
			}
			connections := &countedSessionConnections{SessionConnections: auth.NewSessionConnections()}
			handler := panelSessionGuard(auth.Deps{Enabled: true, Sessions: store, Credentials: fakeCredentialsStore{}, SessionConns: connections})(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(204) }))
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Cookie", "elysian_session="+session.ID)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != 204 || (store.checks.Load() == 1) != tc.passive || (store.validates.Load() == 0) != tc.passive || (connections.registered.Load() == 1) != (tc.passive || tc.socket) {
				t.Fatalf("鉴权接线不符：status=%d check=%d validate=%d registered=%d", rec.Code, store.checks.Load(), store.validates.Load(), connections.registered.Load())
			}
		})
	}
}

func TestAgentOutputAssemblySharesAuthRevocationRegistry(t *testing.T) {
	store := auth.NewMemorySessionStore(nil)
	session, _, err := store.Create("none", "")
	if err != nil {
		t.Fatal(err)
	}
	connections := auth.NewSessionConnections()
	entered, done := make(chan struct{}), make(chan struct{})
	factory := func(*config.Config, seam.DockerViews) (http.Handler, func(context.Context) error, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { close(entered); <-req.Context().Done() }), nil, nil
	}
	runtime, err := newAssembly(&config.Config{}, &fakeLogsService{}, auth.Deps{Enabled: true, Credentials: fakeCredentialsStore{}, Sessions: store, SessionConns: connections}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/agent/runs/run-1/output", nil).WithContext(ctx)
	req.Header.Set("Cookie", "elysian_session="+session.ID)
	go func() { defer close(done); runtime.ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("输出流未进入装配的 Agent 路由")
	}
	logout := sameOriginRequest(http.MethodPost, "/api/auth/logout", "")
	logout.Header.Set("Cookie", "elysian_session="+session.ID)
	rec := httptest.NewRecorder()
	runtime.ServeHTTP(rec, logout)
	if rec.Code != 200 {
		t.Fatalf("登出失败：%d", rec.Code)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("装配未让登出取消 Agent 输出流")
	}
}

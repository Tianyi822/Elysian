package auth

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
)

func (f *streamTestFixture) socketHandler(next http.Handler) http.Handler {
	return requireSessionWebSocket(f.deps, func() (<-chan time.Time, func()) { return f.ticks, func() {} })(next)
}

type socketValidateHook struct {
	SessionStore
	after func()
}

func (s socketValidateHook) Validate(id, epoch string) (*PanelSession, error) {
	session, err := s.SessionStore.Validate(id, epoch)
	s.after()
	return session, err
}

func TestSessionWebSocketRevocationAroundRegistrationNeverOpens(t *testing.T) {
	for _, timing := range []string{"before-register", "after-register", "after-validate"} {
		t.Run(timing, func(t *testing.T) {
			f := newStreamTestFixture(t)
			revoke := func() {
				if err := f.deps.Sessions.Destroy(f.session.ID); err != nil {
					t.Fatal(err)
				}
				f.connections.Revoke(f.session.ID)
			}
			switch timing {
			case "before-register":
				f.deps.SessionConns = streamRegistrationHook{SessionConnections: f.connections, before: revoke}
			case "after-register":
				f.deps.SessionConns = streamRegistrationHook{SessionConnections: f.connections, after: revoke}
			case "after-validate":
				f.deps.Sessions = socketValidateHook{SessionStore: f.deps.Sessions, after: revoke}
			}
			rec := httptest.NewRecorder()
			f.socketHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("失效请求进入终端") })).ServeHTTP(rec, f.request(context.Background()))
			if rec.Code != http.StatusUnauthorized || len(f.connections.(*sessionConnections).bySession) != 0 {
				t.Fatalf("撤销交错未拒绝或残留登记：%d", rec.Code)
			}
		})
	}
}

func TestSessionWebSocketRejectsInvalidCookieOrMissingRevocationService(t *testing.T) {
	for _, cause := range []string{"missing-cookie", "unknown-session", "missing-registry"} {
		t.Run(cause, func(t *testing.T) {
			f := newStreamTestFixture(t)
			req := f.request(context.Background())
			want := http.StatusUnauthorized
			switch cause {
			case "missing-cookie":
				req.Header.Del("Cookie")
			case "unknown-session":
				req.Header.Set("Cookie", "elysian_session=unknown")
			case "missing-registry":
				f.deps.SessionConns = nil
				want = http.StatusInternalServerError
			}
			rec := httptest.NewRecorder()
			f.socketHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("无效会话进入终端") })).ServeHTTP(rec, req)
			if rec.Code != want {
				t.Fatalf("拒绝状态：%d，期望 %d", rec.Code, want)
			}
		})
	}
}

func startSessionWebSocket(t *testing.T, f *streamTestFixture) (*websocket.Conn, <-chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	server := httptest.NewServer(f.socketHandler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		defer close(done)
		conn, err := middleware.Upgrade(w, req)
		if err != nil {
			return
		}
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if !conn.(seam.BinaryWsConn).SendBinary(data) {
				return
			}
		}
	})))
	t.Cleanup(server.Close)
	t.Cleanup(func() { f.connections.Revoke(f.session.ID) })
	headers := http.Header{"Cookie": []string{"elysian_session=" + f.session.ID}}
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), headers)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.WriteMessage(websocket.BinaryMessage, []byte("\x1b[31m中文\x00\xff")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	typ, data, err := client.ReadMessage()
	if err != nil || typ != websocket.BinaryMessage || string(data) != "\x1b[31m中文\x00\xff" {
		t.Fatalf("带鉴权的原始 WS 字节握手/回显失败：%d %q %v", typ, data, err)
	}
	return client, done
}

func requireRevokedSocket(t *testing.T, client *websocket.Conn, done <-chan struct{}) {
	t.Helper()
	_, _, err := client.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != seam.SessionRevokedCloseCode || closed.Text != seam.SessionRevokedCloseReason {
		t.Fatalf("会话撤销未保留关闭码和原因：%v", err)
	}
	awaitStreamSignal(t, done, "撤销后终端处理器未退出/清理")
}

func TestSessionWebSocketPassiveExpiryAndCredentialsCloseEstablishedSocket(t *testing.T) {
	for _, cause := range []string{"idle", "absolute", "epoch", "credential-read-error"} {
		t.Run(cause, func(t *testing.T) {
			f := newStreamTestFixture(t)
			credentials := &streamFailingCredentials{CredentialsStore: f.deps.Credentials}
			f.deps.Credentials = credentials
			client, done := startSessionWebSocket(t, f)
			switch cause {
			case "idle":
				f.now.Add(int64((SessionIdleTTL + time.Millisecond) / time.Millisecond))
			case "absolute":
				f.now.Add(int64((SessionAbsoluteTTL + time.Millisecond) / time.Millisecond))
				store := f.deps.Sessions.(*sessionStoreCore)
				store.mu.Lock()
				store.cached[0].LastUsedAt = f.now.Load()
				store.mu.Unlock()
			case "epoch":
				if _, err := f.deps.Credentials.Write("changed-by-cli"); err != nil {
					t.Fatal(err)
				}
			case "credential-read-error":
				credentials.fail.Store(true)
			}
			f.tick(t)
			requireRevokedSocket(t, client, done)
		})
	}
}

func TestSessionWebSocketAuthChangesCloseAllEstablishedSockets(t *testing.T) {
	for _, action := range []struct{ name, path, body string }{
		{"logout", "/logout", ""},
		{"new-login", "/login", `{"username":"dev","password":"dev-elysian"}`},
		{"password", "/password", `{"currentPassword":"old-password","newPassword":"changed-password","confirmNewPassword":"changed-password"}`},
		{"username", "/username", `{"currentPassword":"old-password","newUsername":"operator"}`},
	} {
		t.Run(action.name, func(t *testing.T) {
			f := newStreamTestFixture(t)
			f.deps.DevAccount = true
			f.deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: PanelUsername, PasswordHash: mustHash(t, "old-password"), PasswordChangedAt: "none"})
			first, firstDone := startSessionWebSocket(t, f)
			second, secondDone := startSessionWebSocket(t, f)
			client := wiringClient{handler: NewRouter(f.deps)}
			rec := client.postJSON(action.path, action.body, "elysian_session="+f.session.ID)
			if rec.Code != http.StatusOK {
				t.Fatalf("鉴权操作失败：%d %s", rec.Code, rec.Body.String())
			}
			requireRevokedSocket(t, first, firstDone)
			requireRevokedSocket(t, second, secondDone)
		})
	}
}

type socketHijackHook struct {
	http.ResponseWriter
	afterHijack func()
	afterWrite  func()
}

func (w socketHijackHook) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if w.afterHijack != nil {
		w.afterHijack()
	}
	if w.afterWrite != nil {
		conn = &socketWriteHook{Conn: conn, after: sync.OnceFunc(w.afterWrite)}
	}
	return conn, rw, nil
}

type socketWriteHook struct {
	net.Conn
	after func()
}

func (c *socketWriteHook) Write(data []byte) (int, error) {
	n, err := c.Conn.Write(data)
	c.after()
	return n, err
}

func TestSessionWebSocketRevokedDuringHandshakeNeverStartsTerminal(t *testing.T) {
	for _, timing := range []string{"during-hijack", "after-handshake-write"} {
		t.Run(timing, func(t *testing.T) {
			f := newStreamTestFixture(t)
			var opened atomic.Bool
			done := make(chan struct{})
			handler := f.socketHandler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				defer close(done)
				conn, err := middleware.Upgrade(w, req)
				if err == nil {
					opened.Store(true)
					conn.Close(1000, "")
				}
			}))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				hook := socketHijackHook{ResponseWriter: w}
				revoke := func() { f.connections.Revoke(f.session.ID) }
				if timing == "during-hijack" {
					hook.afterHijack = revoke
				} else {
					hook.afterWrite = revoke
				}
				handler.ServeHTTP(hook, req)
			}))
			defer server.Close()
			client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Cookie": []string{"elysian_session=" + f.session.ID}})
			if err == nil {
				_ = client.SetReadDeadline(time.Now().Add(time.Second))
				if _, _, err := client.ReadMessage(); err == nil {
					t.Error("握手间隙撤销后仍可读取终端")
				}
				_ = client.Close()
			}
			awaitStreamSignal(t, done, "握手期间撤销未退出")
			if opened.Load() {
				t.Fatal("撤销后的迟到握手仍启动了终端")
			}
		})
	}
}

func TestSessionWebSocketOrdinaryResponseAndReconnectRenewActivity(t *testing.T) {
	f := newStreamTestFixture(t)
	f.now.Add(int64(time.Hour / time.Millisecond))
	rec := httptest.NewRecorder()
	f.socketHandler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(rec, f.request(context.Background()))
	session, err := f.deps.Sessions.Check(f.session.ID, "none")
	if rec.Code != http.StatusNoContent || err != nil || session == nil || session.LastUsedAt != f.now.Load() {
		t.Fatalf("WS 打开未保留普通响应/活动续期：%d %+v %v", rec.Code, session, err)
	}
	if len(f.connections.(*sessionConnections).bySession) != 0 {
		t.Fatal("普通响应结束后残留连接登记")
	}
}

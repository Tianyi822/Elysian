package auth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

type streamTestFixture struct {
	deps        Deps
	connections seam.SessionConnections
	session     *PanelSession
	now         atomic.Int64
	ticks       chan time.Time
}

func newStreamTestFixture(t *testing.T) *streamTestFixture {
	t.Helper()
	f := &streamTestFixture{connections: NewSessionConnections(), ticks: make(chan time.Time)}
	f.now.Store(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	now := func() time.Time { return time.UnixMilli(f.now.Load()) }
	f.deps = Deps{Enabled: true, Sessions: NewMemorySessionStore(now), Credentials: NewMemoryCredentialsStore(nil), SessionConns: f.connections, Now: now, Diag: io.Discard}
	var err error
	f.session, _, err = f.deps.Sessions.Create("none")
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *streamTestFixture) handler(next http.Handler) http.Handler {
	return requireSessionStream(f.deps, func() (<-chan time.Time, func()) { return f.ticks, func() {} })(next)
}

func (f *streamTestFixture) request(ctx context.Context) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/agent/runs/test/output", nil).WithContext(ctx)
	req.Header.Set("Cookie", "elysian_session="+f.session.ID)
	return req
}

func awaitStreamSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal(what)
	}
}

func (f *streamTestFixture) start(t *testing.T) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	entered, done := make(chan struct{}), make(chan struct{})
	handler := f.handler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: ping\ndata: {}\n\n"))
		_ = http.NewResponseController(w).Flush()
		close(entered)
		<-req.Context().Done()
		if n, err := w.Write([]byte("不能继续发送")); n != 0 || !errors.Is(err, context.Canceled) {
			t.Errorf("撤销后仍能写入：%d %v", n, err)
		}
	}))
	go func() { defer close(done); handler.ServeHTTP(httptest.NewRecorder(), f.request(ctx)) }()
	awaitStreamSignal(t, entered, "会话输出流未建立")
	t.Cleanup(func() { cancel(); awaitStreamSignal(t, done, "会话输出流未清理") })
	return cancel, done
}

func (f *streamTestFixture) tick(t *testing.T) {
	t.Helper()
	select {
	case f.ticks <- time.UnixMilli(f.now.Load()):
	case <-time.After(3 * time.Second):
		t.Fatal("复验未读取时钟")
	}
}

func TestSessionStreamRejectsMissingOrInvalidCookie(t *testing.T) {
	for _, cookie := range []string{"", "elysian_session=unknown"} {
		f := newStreamTestFixture(t)
		req := f.request(context.Background())
		req.Header.Set("Cookie", cookie)
		rec := httptest.NewRecorder()
		f.handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("未登录请求进入业务处理器") })).ServeHTTP(rec, req)
		if rec.Code != 401 || !strings.Contains(rec.Body.String(), UnauthorizedMessage) {
			t.Fatalf("未拒绝无效会话：%d %s", rec.Code, rec.Body.String())
		}
	}
}

type streamRegistrationHook struct {
	seam.SessionConnections
	before, after func()
}

func (c streamRegistrationHook) Register(id string, closer func()) func() {
	if c.before != nil {
		c.before()
	}
	unregister := c.SessionConnections.Register(id, closer)
	if c.after != nil {
		c.after()
	}
	return unregister
}

type streamCheckHook struct {
	SessionStore
	after func()
}

func (s streamCheckHook) Check(id, epoch string) (*PanelSession, error) {
	session, err := s.SessionStore.Check(id, epoch)
	s.after()
	return session, err
}

func TestSessionStreamRevocationDuringRegistrationNeverOpensStream(t *testing.T) {
	for _, timing := range []string{"before-register", "after-register", "after-check"} {
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
			case "after-check":
				f.deps.Sessions = streamCheckHook{SessionStore: f.deps.Sessions, after: revoke}
			}
			rec := httptest.NewRecorder()
			f.handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("旧校验的请求进入了输出流") })).ServeHTTP(rec, f.request(context.Background()))
			if rec.Code != 401 {
				t.Fatalf("撤销交错应拒绝：%d", rec.Code)
			}
			registry := f.connections.(*sessionConnections)
			if len(registry.bySession) != 0 {
				t.Fatal("拒绝后仍残留连接登记")
			}
		})
	}
}

func TestSessionStreamRevokeKeepsOtherSessionAndCleansExactConnection(t *testing.T) {
	f := newStreamTestFixture(t)
	_, active := f.start(t)
	cancel, closed := f.start(t)
	cancel()
	awaitStreamSignal(t, closed, "主动断开未退出")
	oldID := f.session.ID
	current, replaced, err := f.deps.Sessions.Create("none")
	if err != nil {
		t.Fatal(err)
	}
	f.session = current
	stopCurrent, newStream := f.start(t)
	for _, id := range replaced {
		f.connections.Revoke(id)
	}
	awaitStreamSignal(t, active, "新登录没有取消旧输出流")
	select {
	case <-newStream:
		t.Fatal("旧会话撤销误伤新会话")
	default:
	}
	f.connections.Revoke(oldID)
	select {
	case <-newStream:
		t.Fatal("迟到撤销误伤新会话")
	default:
	}
	stopCurrent()
	awaitStreamSignal(t, newStream, "新会话输出流未退出")
}

func TestSessionStreamPassiveChecksExpireIdleAbsoluteAndChangedEpoch(t *testing.T) {
	for _, cause := range []string{"idle", "absolute", "epoch"} {
		t.Run(cause, func(t *testing.T) {
			f := newStreamTestFixture(t)
			_, done := f.start(t)
			switch cause {
			case "idle":
				f.now.Add(int64((SessionIdleTTL + time.Millisecond) / time.Millisecond))
			case "absolute":
				// 在绝对过期前模拟真实活动续过空闲；绝对期限依然必须生效。
				f.now.Add(int64((SessionAbsoluteTTL - time.Minute) / time.Millisecond))
				store := f.deps.Sessions.(*sessionStoreCore)
				store.mu.Lock()
				store.cached[0].LastUsedAt = f.now.Load()
				store.mu.Unlock()
				f.now.Add(int64(2 * time.Minute / time.Millisecond))
			case "epoch":
				if _, err := f.deps.Credentials.Write("测试哈希"); err != nil {
					t.Fatal(err)
				}
			}
			f.tick(t)
			awaitStreamSignal(t, done, "静默输出流未因失效退出")
		})
	}
}

func TestSessionStreamAuthEndpointsRevokeOpenStreams(t *testing.T) {
	for _, action := range []struct{ name, path, body string }{
		{"logout", "/logout", ""},
		{"new-login", "/login", `{"username":"dev","password":"dev-elysian"}`},
		{"password", "/password", `{"currentPassword":"old-password","newPassword":"changed-password","confirmNewPassword":"changed-password"}`},
	} {
		t.Run(action.name, func(t *testing.T) {
			f := newStreamTestFixture(t)
			f.deps.DevAccount = true
			f.deps.Credentials = NewMemoryCredentialsStore(&PanelCredentials{Username: PanelUsername, PasswordHash: mustHash(t, "old-password"), PasswordChangedAt: "none"})
			_, first := f.start(t)
			_, second := f.start(t)
			client := wiringClient{handler: NewRouter(f.deps)}
			rec := client.postJSON(action.path, action.body, "elysian_session="+f.session.ID)
			if rec.Code != 200 {
				t.Fatalf("鉴权操作失败：%d %s", rec.Code, rec.Body.String())
			}
			awaitStreamSignal(t, first, "鉴权操作未关闭第一个输出流")
			awaitStreamSignal(t, second, "鉴权操作未关闭第二个输出流")
		})
	}
}

func TestSessionStreamConnectionAndReconnectDoNotSlideIdleExpiry(t *testing.T) {
	f := newStreamTestFixture(t)
	f.now.Add(int64(time.Hour / time.Millisecond))
	handler := f.handler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(204) }))
	for range 2 {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, f.request(context.Background()))
		if rec.Code != 204 {
			t.Fatalf("重连失败：%d", rec.Code)
		}
		f.now.Add(int64(time.Hour / time.Millisecond))
	}
	session, err := f.deps.Sessions.Check(f.session.ID, "none")
	if err != nil || session == nil || session.LastUsedAt != f.session.LastUsedAt {
		t.Fatalf("只读重连不应续空闲期：%+v %v", session, err)
	}
}

type streamFailingCredentials struct {
	CredentialsStore
	fail atomic.Bool
}

func (s *streamFailingCredentials) Current() (*PanelCredentials, error) {
	if s.fail.Load() {
		return nil, errors.New("读取凭据失败")
	}
	return s.CredentialsStore.Current()
}

func TestSessionStreamStopsOnCredentialReadFailure(t *testing.T) {
	f := newStreamTestFixture(t)
	credentials := &streamFailingCredentials{CredentialsStore: f.deps.Credentials}
	f.deps.Credentials = credentials
	_, done := f.start(t)
	credentials.fail.Store(true)
	f.tick(t)
	awaitStreamSignal(t, done, "凭据无法复核时应停止输出")
}

type streamBlockingWriter struct {
	http.ResponseWriter
	started     chan struct{}
	interrupted chan struct{}
	once        sync.Once
	mu          sync.Mutex
	deadline    time.Time
}

func (w *streamBlockingWriter) Write([]byte) (int, error) {
	close(w.started)
	<-w.interrupted
	return 0, context.DeadlineExceeded
}
func (w *streamBlockingWriter) SetWriteDeadline(deadline time.Time) error {
	w.mu.Lock()
	w.deadline = deadline
	w.mu.Unlock()
	if !deadline.IsZero() && !deadline.After(time.Now()) {
		w.once.Do(func() { close(w.interrupted) })
	}
	return nil
}

func TestSessionStreamRevocationInterruptsBlockedWriteAndResetsDeadline(t *testing.T) {
	f := newStreamTestFixture(t)
	w := &streamBlockingWriter{ResponseWriter: httptest.NewRecorder(), started: make(chan struct{}), interrupted: make(chan struct{})}
	done := make(chan struct{})
	handler := f.handler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { _, _ = w.Write([]byte("正在输出")) }))
	go func() { defer close(done); handler.ServeHTTP(w, f.request(context.Background())) }()
	awaitStreamSignal(t, w.started, "输出流未开始写入")
	f.connections.Revoke(f.session.ID)
	awaitStreamSignal(t, done, "撤销未打断阻塞写")
	w.mu.Lock()
	deadline := w.deadline
	w.mu.Unlock()
	if !deadline.IsZero() {
		t.Fatal("输出流结束后未恢复写入时限")
	}
}

func TestSessionStreamNormalCompletionDoesNotInterruptResponse(t *testing.T) {
	f := newStreamTestFixture(t)
	w := &streamBlockingWriter{ResponseWriter: httptest.NewRecorder(), started: make(chan struct{}), interrupted: make(chan struct{})}
	f.handler(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, f.request(context.Background()))
	select {
	case <-w.interrupted:
		t.Fatal("正常完成不应把响应标记成写超时")
	default:
	}
}

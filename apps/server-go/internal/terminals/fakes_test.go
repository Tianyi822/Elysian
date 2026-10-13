package terminals

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// ---------- 可控假钟（对齐 TS vitest fake timers 的确定性） ----------

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) NewTimer(d time.Duration) termTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, deadline: c.now.Add(d), ch: make(chan time.Time, 1)}
	c.timers = append(c.timers, t)
	return t
}

// advance 前进 d 并按到期次序触发定时器（到点信号送入通道，回调 goroutine 异步消费）。
func (c *fakeClock) advance(d time.Duration) {
	type firing struct {
		t  *fakeTimer
		at time.Time
	}
	var fires []firing
	c.mu.Lock()
	target := c.now.Add(d)
	for {
		var next *fakeTimer
		for _, t := range c.timers {
			if t.fired || t.stopped {
				continue
			}
			if next == nil || t.deadline.Before(next.deadline) {
				next = t
			}
		}
		if next == nil || next.deadline.After(target) {
			break
		}
		next.fired = true
		c.now = next.deadline
		fires = append(fires, firing{next, next.deadline})
	}
	c.now = target
	c.mu.Unlock()
	for _, f := range fires {
		f.t.ch <- f.at
	}
}

type fakeTimer struct {
	clock    *fakeClock
	deadline time.Time
	ch       chan time.Time
	fired    bool
	stopped  bool
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

// ---------- fake PTY：pushText 喂输出字节，emulateExit 结束 stdout 并给退出码 ----------

type fakePty struct {
	mu        sync.Mutex
	cond      *sync.Cond
	writes    []string
	chunks    [][]byte
	ended     bool
	killCount int
	exited    chan int
	exitOnce  sync.Once
}

func newFakePty() *fakePty {
	p := &fakePty{exited: make(chan int, 1)}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *fakePty) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, string(b))
	return len(b), nil
}

func (p *fakePty) Stdout() io.Reader { return p }

func (p *fakePty) Read(buf []byte) (int, error) {
	p.mu.Lock()
	for len(p.chunks) == 0 && !p.ended {
		p.cond.Wait()
	}
	if len(p.chunks) > 0 {
		chunk := p.chunks[0]
		n := copy(buf, chunk)
		if n < len(chunk) {
			// 读缓冲小于 chunk：保留剩余字节，下次 Read 续读（对齐真实管道语义）。
			p.chunks[0] = chunk[n:]
		} else {
			p.chunks = p.chunks[1:]
		}
		p.mu.Unlock()
		return n, nil
	}
	p.mu.Unlock()
	return 0, io.EOF
}

// Kill SIGKILL 语义：kill 恰计数一次，随后按 137 退出收口（幂等由会话层保证只调一次）。
func (p *fakePty) Kill() error {
	p.mu.Lock()
	p.killCount++
	p.mu.Unlock()
	p.emulateExit(137)
	return nil
}

func (p *fakePty) Exited() <-chan int { return p.exited }

func (p *fakePty) pushText(text string) {
	p.mu.Lock()
	p.chunks = append(p.chunks, []byte(text))
	p.mu.Unlock()
	p.cond.Broadcast()
}

func (p *fakePty) emulateExit(code int) {
	p.mu.Lock()
	p.ended = true
	p.mu.Unlock()
	p.cond.Broadcast()
	p.exitOnce.Do(func() {
		p.exited <- code
		close(p.exited)
	})
}

func (p *fakePty) writesSnapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, len(p.writes))
	copy(out, p.writes)
	return out
}

func (p *fakePty) killCountValue() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.killCount
}

// ---------- 会话事件记录器 ----------

type closeRecord struct {
	code   int
	reason string
}

type frameRecorder struct {
	mu     sync.Mutex
	frames []terminalFrame
	closes []closeRecord
}

func (r *frameRecorder) sendFrame(frame terminalFrame) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, frame)
}

func (r *frameRecorder) close(code int, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closes = append(r.closes, closeRecord{code, reason})
}

func (r *frameRecorder) snapshot() ([]terminalFrame, []closeRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	frames := make([]terminalFrame, len(r.frames))
	copy(frames, r.frames)
	closes := make([]closeRecord, len(r.closes))
	copy(closes, r.closes)
	return frames, closes
}

func frameTypes(frames []terminalFrame) []string {
	types := make([]string, len(frames))
	for i, f := range frames {
		switch f.(type) {
		case frameReady:
			types[i] = "ready"
		case frameOutput:
			types[i] = "output"
		case framePrompt:
			types[i] = "prompt"
		case frameTruncated:
			types[i] = "truncated"
		case frameExit:
			types[i] = "exit"
		case framePong:
			types[i] = "pong"
		}
	}
	return types
}

func outputLineCount(frames []terminalFrame) int {
	total := 0
	for _, f := range frames {
		if out, ok := f.(frameOutput); ok {
			total += len(out.Lines)
		}
	}
	return total
}

// waitFor 条件轮转直至成立（3 秒上限），超时以 Fatal 终止。
func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("waitFor 超时：%s", msg)
		}
		time.Sleep(time.Millisecond)
	}
}

// ---------- 会话服务 fixture（fake PTY + 假钟 + 可编排宿主依赖） ----------

type fixtureOpts struct {
	spawnErr     error
	spawnPtyFunc func() seam.PtyProcess
	listDir      func(dir string) ([]string, error)
	listDirGate  chan struct{}
	listCommands func(ctx context.Context) ([]string, error)
	commandsGate chan struct{}
	disposeShell func(pid string)
}

type serviceFixture struct {
	svc         *service
	session     sessionHandle
	pty         *fakePty
	frames      *frameRecorder
	clock       *fakeClock
	listDirMu   sync.Mutex
	listDirCall []string
	listCmdN    atomic.Int64
	spawnMu     sync.Mutex
	spawnSpec   seam.ShellSessionSpec
	spawnIdent  seam.TerminalIdentity
	disposeMu   sync.Mutex
	disposePids []string
}

func newServiceFixture(t *testing.T, opts fixtureOpts) *serviceFixture {
	t.Helper()
	pty := newFakePty()
	rec := &frameRecorder{}
	clk := newFakeClock()
	f := &serviceFixture{pty: pty, frames: rec, clock: clk}

	spawn := func() seam.PtyProcess {
		if opts.spawnPtyFunc != nil {
			return opts.spawnPtyFunc()
		}
		return pty
	}
	host := seam.TerminalHostDeps{
		SpawnPty: func(_ context.Context, spec seam.ShellSessionSpec, identity seam.TerminalIdentity) (seam.PtyProcess, error) {
			f.spawnMu.Lock()
			f.spawnSpec = spec
			f.spawnIdent = identity
			f.spawnMu.Unlock()
			if opts.spawnErr != nil {
				return nil, opts.spawnErr
			}
			return spawn(), nil
		},
		ListCommands: func(ctx context.Context) ([]string, error) {
			f.listCmdN.Add(1)
			if opts.commandsGate != nil {
				<-opts.commandsGate
			}
			if opts.listCommands != nil {
				return opts.listCommands(ctx)
			}
			return []string{"bash", "ls", "whoami"}, nil
		},
		ListDir: func(dir string) ([]string, error) {
			f.listDirMu.Lock()
			f.listDirCall = append(f.listDirCall, dir)
			f.listDirMu.Unlock()
			if opts.listDirGate != nil {
				<-opts.listDirGate
			}
			if opts.listDir != nil {
				return opts.listDir(dir)
			}
			return []string{"apps", "docs"}, nil
		},
	}
	if opts.disposeShell != nil {
		hook := opts.disposeShell
		host.DisposeShell = hook
	}
	identity := func() seam.TerminalIdentity {
		return seam.TerminalIdentity{User: "root", HostLabel: "elysian-web-1", HomeDir: "/root"}
	}
	f.svc = newService(host, identity, HostShellSessionSpec, TERMINAL_MAX_SESSIONS, clk)
	handle := f.svc.tryOpen(rec)
	if handle == nil {
		t.Fatal("fake 并发不应触顶")
	}
	f.session = handle
	return f
}

func (f *serviceFixture) spawnEnv() seam.ShellSessionSpec {
	f.spawnMu.Lock()
	defer f.spawnMu.Unlock()
	return f.spawnSpec
}

func (f *serviceFixture) spawnIdentity() seam.TerminalIdentity {
	f.spawnMu.Lock()
	defer f.spawnMu.Unlock()
	return f.spawnIdent
}

func (f *serviceFixture) listDirCalls() []string {
	f.listDirMu.Lock()
	defer f.listDirMu.Unlock()
	out := make([]string, len(f.listDirCall))
	copy(out, f.listDirCall)
	return out
}

const testReady = "\x01READY\x02"

// ---------- fake 连接（seam.WsConn） ----------

type fakeWsConn struct {
	mu       sync.Mutex
	sent     []string
	closes   []closeRecord
	open     atomic.Bool
	buffered atomic.Int64
}

func newFakeWsConn() *fakeWsConn {
	c := &fakeWsConn{}
	c.open.Store(true)
	return c
}

func (c *fakeWsConn) SendText(text string) bool {
	if !c.open.Load() {
		return false
	}
	c.mu.Lock()
	c.sent = append(c.sent, text)
	c.mu.Unlock()
	return true
}

func (c *fakeWsConn) BufferedAmount() int64 { return c.buffered.Load() }

func (c *fakeWsConn) Close(code int, reason string) {
	c.mu.Lock()
	c.closes = append(c.closes, closeRecord{code, reason})
	c.mu.Unlock()
	c.open.Store(false)
}

func (c *fakeWsConn) ReadMessage() (int, []byte, error) { return 0, nil, io.EOF }

func (c *fakeWsConn) sentSnapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.sent))
	copy(out, c.sent)
	return out
}

func (c *fakeWsConn) closesSnapshot() []closeRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]closeRecord, len(c.closes))
	copy(out, c.closes)
	return out
}

// ---------- fake 会话机（连接胶水直驱） ----------

type fakeConnService struct {
	mu           sync.Mutex
	opened       []sessionEvents
	handled      []clientFrame
	disposals    []disposeCause
	rejectOpen   bool
	throwOnOpen  bool
	throwOnFrame bool
}

func (s *fakeConnService) tryOpen(events sessionEvents) sessionHandle {
	if s.throwOnOpen {
		panic(errors.New("tryOpen 炸了"))
	}
	if s.rejectOpen {
		return nil
	}
	s.mu.Lock()
	s.opened = append(s.opened, events)
	s.mu.Unlock()
	return &fakeConnSession{svc: s}
}

func (s *fakeConnService) activeCount() int { return 1 }

type fakeConnSession struct {
	svc *fakeConnService
}

func (f *fakeConnSession) ID() string { return "session-1" }

func (f *fakeConnSession) handleClientFrame(frame clientFrame) {
	if f.svc.throwOnFrame {
		panic(errors.New("handleClientFrame 炸了"))
	}
	f.svc.mu.Lock()
	f.svc.handled = append(f.svc.handled, frame)
	f.svc.mu.Unlock()
}

func (f *fakeConnSession) dispose(cause disposeCause) {
	f.svc.mu.Lock()
	f.svc.disposals = append(f.svc.disposals, cause)
	f.svc.mu.Unlock()
}

func (s *fakeConnService) snapshot() (opened int, handled []clientFrame, disposals []disposeCause) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.opened), append([]clientFrame(nil), s.handled...), append([]disposeCause(nil), s.disposals...)
}

// ---------- 测试用撤销表（auth 域 SessionConnections 的等价行为件） ----------
// Go 函数值不可比较，无法做 map 键；测试形态下每会话至多一条连接，用切片 + 末位
// 注销等价表达「按 closer 注销」。

type testSessionConnections struct {
	mu      sync.Mutex
	closers map[string][]*func()
}

func newTestSessionConnections() *testSessionConnections {
	return &testSessionConnections{closers: map[string][]*func(){}}
}

func (c *testSessionConnections) Register(sessionID string, closer func()) func() {
	entry := &closer
	c.mu.Lock()
	c.closers[sessionID] = append(c.closers[sessionID], entry)
	c.mu.Unlock()
	return sync.OnceFunc(func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		list := c.closers[sessionID]
		for i, candidate := range list {
			if candidate == entry {
				c.closers[sessionID] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
		if len(c.closers[sessionID]) == 0 {
			delete(c.closers, sessionID)
		}
	})
}

func (c *testSessionConnections) Revoke(sessionID string) {
	c.mu.Lock()
	list := c.closers[sessionID]
	delete(c.closers, sessionID)
	c.mu.Unlock()
	for _, closer := range list {
		(*closer)()
	}
}

func (c *testSessionConnections) RevokeOthers(keepSessionID string) {
	c.mu.Lock()
	var toClose []*func()
	for id, list := range c.closers {
		if id == keepSessionID {
			continue
		}
		toClose = append(toClose, list...)
		delete(c.closers, id)
	}
	c.mu.Unlock()
	for _, closer := range toClose {
		(*closer)()
	}
}

func (c *testSessionConnections) RevokeAll() {
	c.mu.Lock()
	var toClose []*func()
	for id, list := range c.closers {
		toClose = append(toClose, list...)
		delete(c.closers, id)
	}
	c.mu.Unlock()
	for _, closer := range toClose {
		(*closer)()
	}
}

func (c *testSessionConnections) count(sessionID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.closers[sessionID])
}

// ---------- 其它小件 ----------

// fakeLogs 操作日志记录器。
type fakeLogs struct {
	mu      sync.Mutex
	records []seam.OperationRecord
}

func (l *fakeLogs) Runtime(string, string, string) {}

func (l *fakeLogs) RecordOperation(rec seam.OperationRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = append(l.records, rec)
}

func (l *fakeLogs) snapshot() []seam.OperationRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]seam.OperationRecord, len(l.records))
	copy(out, l.records)
	return out
}

// upgradableService 路由测试用：tryOpen 恒成功（最小会话形状，OnOpen 走登记分支）。
type upgradableService struct{}

func (upgradableService) tryOpen(sessionEvents) sessionHandle { return nopSession{} }

func (upgradableService) activeCount() int { return 1 }

type nopSession struct{}

func (nopSession) ID() string                    { return "t1" }
func (nopSession) handleClientFrame(clientFrame) {}
func (nopSession) dispose(disposeCause)          {}

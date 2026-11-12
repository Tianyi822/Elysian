package terminals

import (
	"io"
	"sync"
	"sync/atomic"
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
	sizes     [][2]int
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
func (p *fakePty) Resize(cols, rows int) error {
	p.mu.Lock()
	p.sizes = append(p.sizes, [2]int{cols, rows})
	p.mu.Unlock()
	return nil
}

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

// ---------- fake 连接（seam.WsConn） ----------

type fakeWsConn struct {
	mu       sync.Mutex
	sent     []string
	binary   [][]byte
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

func (c *fakeWsConn) SendBinary(data []byte) bool {
	if !c.open.Load() {
		return false
	}
	c.mu.Lock()
	c.binary = append(c.binary, append([]byte(nil), data...))
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
func (nopSession) handleInput([]byte)            {}
func (nopSession) dispose(disposeCause)          {}

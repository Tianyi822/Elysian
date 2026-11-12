package terminals

import (
	"bytes"
	"context"
	"elysian/server/internal/seam"
	"errors"
	"sync"
	"testing"
	"time"
)

type closeRecord struct {
	code   int
	reason string
}
type frameRecorder struct {
	mu     sync.Mutex
	frames []terminalFrame
	data   []byte
	chunks []int
	closes []closeRecord
}

func (r *frameRecorder) sendFrame(f terminalFrame) {
	r.mu.Lock()
	r.frames = append(r.frames, f)
	r.mu.Unlock()
}
func (r *frameRecorder) sendData(data []byte) bool {
	r.mu.Lock()
	r.data = append(r.data, data...)
	r.chunks = append(r.chunks, len(data))
	r.mu.Unlock()
	return true
}
func (r *frameRecorder) close(code int, reason string) {
	r.mu.Lock()
	r.closes = append(r.closes, closeRecord{code, reason})
	r.mu.Unlock()
}
func (r *frameRecorder) size() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.data) }
func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal(msg)
		}
		time.Sleep(time.Millisecond)
	}
}
func fixture(t *testing.T) (*service, *session, *fakePty, *frameRecorder, *fakeClock) {
	t.Helper()
	p := newFakePty()
	r := &frameRecorder{}
	clk := newFakeClock()
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return p, nil
	}}, func() seam.TerminalIdentity {
		return seam.TerminalIdentity{User: "root", HostLabel: "host", HomeDir: "/root"}
	}, seam.ShellSessionSpec{}, 5, clk)
	sess := svc.tryOpen(r).(*session)
	t.Cleanup(func() { sess.dispose(disposeClientClose) })
	waitFor(t, func() bool { r.mu.Lock(); defer r.mu.Unlock(); return len(r.frames) > 0 }, "ready missing")
	return svc, sess, p, r, clk
}
func TestRawReadyInputResizeAndPing(t *testing.T) {
	_, s, p, r, _ := fixture(t)
	r.mu.Lock()
	ready, ok := r.frames[0].(frameReady)
	r.mu.Unlock()
	if !ok || ready.Protocol != 2 || ready.Session.ID == "" || ready.Session.User != "root" {
		t.Fatalf("ready: %+v", ready)
	}
	data := []byte("echo 中文\r\x03\x1b[A\n")
	s.handleInput(data)
	waitFor(t, func() bool { return len(p.writesSnapshot()) > 0 }, "input missing")
	if !bytes.Equal([]byte(p.writesSnapshot()[0]), data) {
		t.Fatalf("input rewritten: %q", p.writesSnapshot())
	}
	s.handleClientFrame(clientFrame{typ: clientFrameResize, cols: 142, rows: 42})
	p.mu.Lock()
	last := p.sizes[len(p.sizes)-1]
	p.mu.Unlock()
	if last != [2]int{142, 42} {
		t.Fatalf("size: %v", last)
	}
	s.handleClientFrame(clientFrame{typ: clientFramePing})
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.frames[len(r.frames)-1].(framePong); !ok {
		t.Fatal("pong missing")
	}
}
func TestRawOutputPreservesBytesAndBackpressure(t *testing.T) {
	_, s, p, r, _ := fixture(t)
	payload := bytes.Repeat([]byte("\x1b[31m中文\r\x00\xff"), 40000)
	p.pushText(string(payload))
	waitFor(t, func() bool { return r.size() == TERMINAL_CREDIT_BYTES }, "credit window not filled")
	time.Sleep(15 * time.Millisecond)
	if r.size() != TERMINAL_CREDIT_BYTES {
		t.Fatal("credit exceeded")
	}
	for r.size() < len(payload) {
		s.mu.Lock()
		outstanding := s.outstanding
		s.mu.Unlock()
		if outstanding > 0 {
			s.handleClientFrame(clientFrame{typ: clientFrameAck, bytes: outstanding})
		}
		time.Sleep(time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !bytes.Equal(r.data, payload) {
		t.Fatal("PTY output altered or truncated")
	}
	for _, n := range r.chunks {
		if n > TERMINAL_DATA_MAX_BYTES {
			t.Fatal("oversize data frame")
		}
	}
}
func TestInvalidAckClosesAndKillsOnce(t *testing.T) {
	svc, s, p, r, _ := fixture(t)
	s.handleClientFrame(clientFrame{typ: clientFrameAck, bytes: 1})
	s.dispose(disposeClientClose)
	if p.killCountValue() != 1 || svc.ActiveCount() != 0 {
		t.Fatalf("cleanup: kills=%d active=%d", p.killCountValue(), svc.ActiveCount())
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.closes) != 1 || r.closes[0].code != 1008 {
		t.Fatalf("closes: %+v", r.closes)
	}
}
func TestIdleTimeoutAndInputRefresh(t *testing.T) {
	_, s, p, r, clk := fixture(t)
	clk.advance(TERMINAL_IDLE_TIMEOUT - time.Second)
	s.handleClientFrame(clientFrame{typ: clientFramePing})
	clk.advance(time.Second)
	if p.killCountValue() != 0 {
		t.Fatal("old timer ended active session")
	}
	clk.advance(TERMINAL_IDLE_TIMEOUT)
	waitFor(t, func() bool { return p.killCountValue() == 1 }, "idle did not kill")
	waitFor(t, func() bool { r.mu.Lock(); defer r.mu.Unlock(); return len(r.closes) == 1 && r.closes[0].code == 4000 }, "idle close missing")
}
func TestNaturalExitSendsTailBeforeExit(t *testing.T) {
	svc, _, p, r, _ := fixture(t)
	p.pushText("tail without newline\x1b[0m")
	p.emulateExit(7)
	waitFor(t, func() bool { return svc.ActiveCount() == 0 }, "natural exit slot not released")
	r.mu.Lock()
	defer r.mu.Unlock()
	if string(r.data) != "tail without newline\x1b[0m" {
		t.Fatalf("tail: %q", r.data)
	}
	last, ok := r.frames[len(r.frames)-1].(frameExit)
	if !ok || last.ExitCode != 7 {
		t.Fatalf("exit: %+v", r.frames)
	}
}
func TestSessionLimitAndRelease(t *testing.T) {
	host := seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return newFakePty(), nil
	}}
	svc := newService(host, func() seam.TerminalIdentity { return seam.TerminalIdentity{} }, seam.ShellSessionSpec{}, 5, realClock{})
	var handles []sessionHandle
	for i := 0; i < 5; i++ {
		h := svc.tryOpen(&frameRecorder{})
		if h == nil {
			t.Fatal("early refusal")
		}
		handles = append(handles, h)
	}
	if svc.tryOpen(&frameRecorder{}) != nil {
		t.Fatal("sixth session allowed")
	}
	handles[0].dispose(disposeClientClose)
	h := svc.tryOpen(&frameRecorder{})
	if h == nil {
		t.Fatal("released slot not reusable")
	}
	handles = append(handles, h)
	for _, h := range handles {
		h.dispose(disposeClientClose)
	}
}
func TestLateSpawnAfterCloseIsKilled(t *testing.T) {
	gate := make(chan struct{})
	entered := make(chan struct{})
	p := newFakePty()
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		close(entered)
		<-gate
		return p, nil
	}}, func() seam.TerminalIdentity { return seam.TerminalIdentity{} }, seam.ShellSessionSpec{}, 1, realClock{})
	h := svc.tryOpen(&frameRecorder{})
	<-entered
	h.dispose(disposeClientClose)
	close(gate)
	waitFor(t, func() bool { return p.killCountValue() == 1 }, "late process leaked")
}
func TestSpawnFailureReleasesSlot(t *testing.T) {
	r := &frameRecorder{}
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return nil, errors.New("private spawn detail")
	}}, func() seam.TerminalIdentity { return seam.TerminalIdentity{} }, seam.ShellSessionSpec{}, 1, realClock{})
	svc.tryOpen(r)
	waitFor(t, func() bool { return svc.ActiveCount() == 0 }, "failed spawn held slot")
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.closes) != 1 || r.closes[0].reason != "终端进程启动失败" {
		t.Fatalf("private error leaked: %+v", r.closes)
	}
}

type pendingPty struct {
	*fakePty
	entered chan struct{}
	ready   chan error
}

func (p *pendingPty) WaitReady(ctx context.Context) error {
	close(p.entered)
	select {
	case err := <-p.ready:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func TestReadyWaitsForActualProcessHandshake(t *testing.T) {
	p := &pendingPty{newFakePty(), make(chan struct{}), make(chan error, 1)}
	r := &frameRecorder{}
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return p, nil
	}}, resolveHostIdentity, seam.ShellSessionSpec{}, 1, realClock{})
	svc.tryOpen(r)
	<-p.entered
	r.mu.Lock()
	n := len(r.frames)
	r.mu.Unlock()
	if n != 0 {
		t.Fatal("ready before actual process handshake")
	}
	p.ready <- errors.New("private setup details")
	waitFor(t, func() bool { return svc.ActiveCount() == 0 }, "failed handshake leaked process")
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.frames) != 0 || len(r.closes) != 1 || r.closes[0].code != 1011 {
		t.Fatalf("bad handshake projected as ready: %+v %+v", r.frames, r.closes)
	}
	waitFor(t, func() bool { return p.killCountValue() == 1 }, "failed handshake was not cleaned")
}

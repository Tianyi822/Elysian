package terminals

import (
	"context"
	"elysian/server/internal/seam"
	"strings"
	"sync"
	"testing"
)

func connFixture(t *testing.T) (*connEvents, *fakeWsConn, *fakePty, *service) {
	t.Helper()
	p := newFakePty()
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return p, nil
	}}, func() seam.TerminalIdentity { return seam.TerminalIdentity{} }, seam.ShellSessionSpec{}, 1, realClock{})
	c := newFakeWsConn()
	events := newConnEvents(svc, nil, "")
	events.OnOpen(c)
	t.Cleanup(events.OnClose)
	waitFor(t, func() bool { return len(c.sentSnapshot()) > 0 }, "no ready")
	return events, c, p, svc
}
func TestBinaryInputAndOutputAreUnchanged(t *testing.T) {
	e, c, p, _ := connFixture(t)
	e.OnBinaryMessage(c, []byte("\x1b[A\x03中文\r"))
	waitFor(t, func() bool { return len(p.writesSnapshot()) == 1 }, "no input")
	if p.writesSnapshot()[0] != "\x1b[A\x03中文\r" {
		t.Fatal("input changed")
	}
	p.pushText("\x1b[32mhello\r\x00")
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return len(c.binary) > 0 }, "no binary output")
	c.mu.Lock()
	defer c.mu.Unlock()
	if string(c.binary[0]) != "\x1b[32mhello\r\x00" {
		t.Fatal("output changed")
	}
}
func TestLegacyInputAndOversizeBinaryCloseAndClean(t *testing.T) {
	for _, binary := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "oversize"}[binary], func(t *testing.T) {
			e, c, p, svc := connFixture(t)
			if binary {
				e.OnBinaryMessage(c, make([]byte, TERMINAL_INPUT_MAX_BYTES+1))
			} else {
				e.OnMessage(c, []byte(`{"type":"input","data":"ls"}`))
			}
			if len(c.closesSnapshot()) != 1 || c.closesSnapshot()[0].code != 1008 || p.killCountValue() != 1 || svc.ActiveCount() != 0 {
				t.Fatal("violation did not clean process")
			}
		})
	}
}
func TestRevocationClosesProcessAndUnregisters(t *testing.T) {
	p := newFakePty()
	registry := newTestSessionConnections()
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return p, nil
	}}, func() seam.TerminalIdentity { return seam.TerminalIdentity{} }, seam.ShellSessionSpec{}, 1, realClock{})
	e := newConnEvents(svc, registry, "auth-session")
	c := newFakeWsConn()
	e.OnOpen(c)
	waitFor(t, func() bool { return len(c.sentSnapshot()) > 0 }, "ready")
	registry.Revoke("auth-session")
	if p.killCountValue() != 1 || svc.ActiveCount() != 0 || registry.count("auth-session") != 0 {
		t.Fatal("revocation leaked")
	}
	if got := c.closesSnapshot(); len(got) != 1 || got[0].code != seam.SessionRevokedCloseCode {
		t.Fatalf("close %+v", got)
	}
	e.OnClose()
	if p.killCountValue() != 1 {
		t.Fatal("double kill")
	}
}
func TestSessionLimitRejectsBeforeRegistration(t *testing.T) {
	svc := newService(seam.TerminalHostDeps{}, resolveHostIdentity, seam.ShellSessionSpec{}, 0, realClock{})
	registry := newTestSessionConnections()
	c := newFakeWsConn()
	e := newConnEvents(svc, registry, "a")
	e.OnOpen(c)
	if registry.count("a") != 0 || len(c.closesSnapshot()) != 1 || !strings.Contains(c.closesSnapshot()[0].reason, "上限") {
		t.Fatal("cap refusal")
	}
}

type delayedRegistry struct {
	*testSessionConnections
	entered chan struct{}
	release chan struct{}
}

func (r *delayedRegistry) Register(id string, f func()) func() {
	unregister := r.testSessionConnections.Register(id, f)
	close(r.entered)
	<-r.release
	return unregister
}
func TestCloseDuringRegistrationReclaimsLateHandle(t *testing.T) {
	registry := &delayedRegistry{newTestSessionConnections(), make(chan struct{}), make(chan struct{})}
	svc := newService(seam.TerminalHostDeps{SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
		return newFakePty(), nil
	}}, resolveHostIdentity, seam.ShellSessionSpec{}, 1, realClock{})
	e := newConnEvents(svc, registry, "s")
	c := newFakeWsConn()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); e.OnOpen(c) }()
	<-registry.entered
	e.OnClose()
	close(registry.release)
	wg.Wait()
	if registry.count("s") != 0 || svc.ActiveCount() != 0 {
		t.Fatal("late registration leaked")
	}
}
func TestKitTotalLimit(t *testing.T) {
	svc := newService(seam.TerminalHostDeps{}, resolveHostIdentity, seam.ShellSessionSpec{}, 0, realClock{})
	wrapped := NewKit().NewTotalLimitedService(svc, func() int { return 5 }, 5)
	if h, ok := wrapped.TryOpen(); ok || h != nil {
		t.Fatal("global limit bypassed")
	}
}

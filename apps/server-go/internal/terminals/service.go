package terminals

import (
	"bytes"
	"context"
	"io"
	"sync"

	"elysian/server/internal/seam"
)

type disposeCause int

const (
	disposeClientClose disposeCause = iota
	disposeIdleTimeout
	disposeInternal
)

type sessionEvents interface {
	sendFrame(terminalFrame)
	sendData([]byte) bool
	close(int, string)
}

type sessionHandle interface {
	ID() string
	handleClientFrame(clientFrame)
	handleInput([]byte)
	dispose(disposeCause)
}

type serviceApi interface {
	tryOpen(sessionEvents) sessionHandle
	activeCount() int
}

type service struct {
	host        seam.TerminalHostDeps
	identityFn  func() seam.TerminalIdentity
	shell       seam.ShellSessionSpec
	maxSessions int
	clk         clock
	mu          sync.Mutex
	sessions    map[string]*session
}

func newService(host seam.TerminalHostDeps, identity func() seam.TerminalIdentity, shell seam.ShellSessionSpec, max int, clk clock) *service {
	return &service{host: host, identityFn: identity, shell: shell, maxSessions: max, clk: clk, sessions: map[string]*session{}}
}

type nullEvents struct{}

func (nullEvents) sendFrame(terminalFrame) {}
func (nullEvents) sendData([]byte) bool    { return true }
func (nullEvents) close(int, string)       {}
func (s *service) TryOpen() (seam.TerminalSession, bool) {
	h := s.tryOpen(nullEvents{})
	return h, h != nil
}
func (s *service) ActiveCount() int { return s.activeCount() }
func (s *service) activeCount() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.sessions) }
func (s *service) tryOpen(events sessionEvents) sessionHandle {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) >= s.maxSessions {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	sess := &session{id: newSessionUUID(), host: s.host, identityFn: s.identityFn, shell: s.shell, events: events, clk: s.clk, ctx: ctx, cancel: cancel, input: make(chan []byte, 256)}
	sess.credit = sync.NewCond(&sess.mu)
	sess.onEnded = func() { s.mu.Lock(); delete(s.sessions, sess.id); s.mu.Unlock() }
	s.sessions[sess.id] = sess
	go sess.start()
	return sess
}

type session struct {
	id          string
	host        seam.TerminalHostDeps
	identityFn  func() seam.TerminalIdentity
	shell       seam.ShellSessionSpec
	events      sessionEvents
	clk         clock
	ctx         context.Context
	cancel      context.CancelFunc
	onEnded     func()
	input       chan []byte
	mu          sync.Mutex
	credit      *sync.Cond
	proc        seam.PtyProcess
	disposed    bool
	outstanding int
	inputBytes  int
	idleTimer   termTimer
	idleWake    chan struct{}
}

func (s *session) ID() string { return s.id }
func (s *session) start() {
	defer func() {
		if recover() != nil {
			s.fail(1011, "终端进程异常")
		}
	}()
	identity := s.identityFn()
	proc, err := s.host.SpawnPty(s.ctx, seam.ShellSessionSpec{Env: buildPtyEnv(identity.HomeDir, s.shell.Env)}, identity)
	if err != nil {
		s.fail(1011, "终端进程启动失败")
		return
	}
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		_ = proc.Kill()
		return
	}
	s.proc = proc
	s.armIdleLocked()
	s.mu.Unlock()
	if err := proc.Resize(TERMINAL_COLS, TERMINAL_ROWS); err != nil {
		s.fail(1011, "终端窗口调整失败")
		return
	}
	if pending, ok := proc.(seam.TerminalReadyProcess); ok {
		if err := pending.WaitReady(s.ctx); err != nil {
			if s.ctx.Err() == nil {
				s.fail(1011, "终端进程启动失败")
			}
			return
		}
	}
	s.events.sendFrame(frameReady{Type: "ready", Protocol: 2, Session: frameSession{ID: s.id, User: identity.User, HostLabel: identity.HostLabel}})
	go s.writeInput(proc)
	s.pump(proc)
}

// Raw keystrokes go through a bounded writer, so a blocked process cannot stop
// the WebSocket reader from accepting output acknowledgements or cancellation.
func (s *session) handleInput(data []byte) {
	if len(data) == 0 {
		return
	}
	if len(data) > TERMINAL_INPUT_MAX_BYTES {
		s.fail(1008, "终端输入过大")
		return
	}
	chunk := append([]byte(nil), data...)
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return
	}
	if s.proc == nil {
		s.mu.Unlock()
		s.fail(1008, "终端尚未就绪")
		return
	}
	if s.inputBytes+len(chunk) > TERMINAL_CREDIT_BYTES {
		s.mu.Unlock()
		s.fail(1008, "终端输入缓冲超限")
		return
	}
	s.inputBytes += len(chunk)
	s.armIdleLocked()
	select {
	case s.input <- chunk:
		s.mu.Unlock()
	default:
		s.mu.Unlock()
		s.fail(1008, "终端输入缓冲超限")
	}
}

func (s *session) writeInput(proc seam.PtyProcess) {
	defer func() {
		if recover() != nil {
			s.fail(1011, "终端输入写入失败")
		}
	}()
	for {
		select {
		case <-s.ctx.Done():
			return
		case data := <-s.input:
			if s.ctx.Err() != nil {
				return
			}
			if _, err := io.Copy(proc, bytes.NewReader(data)); err != nil {
				s.fail(1011, "终端输入写入失败")
				return
			}
			s.mu.Lock()
			s.inputBytes -= len(data)
			s.mu.Unlock()
		}
	}
}

func (s *session) handleClientFrame(frame clientFrame) {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return
	}
	s.armIdleLocked()
	proc := s.proc
	switch frame.typ {
	case clientFrameAck:
		if frame.bytes > s.outstanding {
			s.mu.Unlock()
			s.fail(1008, "终端输出确认无效")
			return
		}
		s.outstanding -= frame.bytes
		s.credit.Broadcast()
		s.mu.Unlock()
	case clientFrameResize:
		s.mu.Unlock()
		if proc != nil {
			if err := proc.Resize(frame.cols, frame.rows); err != nil {
				s.fail(1011, "终端窗口调整失败")
			}
		}
	case clientFramePing:
		s.mu.Unlock()
		s.events.sendFrame(pongFrame)
	default:
		s.mu.Unlock()
		s.fail(1008, "终端消息类型不允许")
	}
}

// Reading stops when xterm has not acknowledged its credit window. No output,
// including escape sequences or split UTF-8 bytes, is discarded or rewritten.
func (s *session) pump(proc seam.PtyProcess) {
	reader := proc.Stdout()
	buf := make([]byte, TERMINAL_DATA_MAX_BYTES)
	for {
		s.mu.Lock()
		for !s.disposed && s.outstanding >= TERMINAL_CREDIT_BYTES {
			s.credit.Wait()
		}
		if s.disposed {
			s.mu.Unlock()
			return
		}
		size := min(len(buf), TERMINAL_CREDIT_BYTES-s.outstanding)
		s.mu.Unlock()
		n, err := reader.Read(buf[:size])
		if n > 0 {
			s.mu.Lock()
			if s.disposed {
				s.mu.Unlock()
				return
			}
			s.outstanding += n
			s.mu.Unlock()
			if !s.events.sendData(buf[:n]) {
				s.fail(1011, "终端连接中断")
				return
			}
		}
		if err != nil {
			break
		}
	}
	var code int
	select {
	case code = <-proc.Exited():
	case <-s.ctx.Done():
		return
	}
	s.mu.Lock()
	stopped := s.disposed
	s.mu.Unlock()
	if stopped {
		return
	}
	s.events.sendFrame(frameExit{Type: "exit", ExitCode: code})
	s.dispose(disposeClientClose)
	s.events.close(1000, "")
}

func (s *session) fail(code int, reason string) {
	// Close first interrupts network and input writers before waiting for process
	// teardown. Calling it without session locks also keeps revocation bounded.
	s.events.close(code, reason)
	s.dispose(disposeInternal)
}

func (s *session) dispose(cause disposeCause) {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return
	}
	s.disposed = true
	s.cancel()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		close(s.idleWake)
		s.idleTimer = nil
	}
	s.credit.Broadcast()
	proc := s.proc
	s.mu.Unlock()
	s.onEnded()
	if proc != nil {
		_ = proc.Kill()
	}
	if cause == disposeIdleTimeout {
		s.events.close(4000, "终端会话空闲超时")
	}
}

func (s *session) armIdleLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		close(s.idleWake)
	}
	timer := s.clk.NewTimer(TERMINAL_IDLE_TIMEOUT)
	wake := make(chan struct{})
	s.idleTimer = timer
	s.idleWake = wake
	go func() {
		select {
		case <-timer.C():
		case <-wake:
			return
		}
		s.mu.Lock()
		current := !s.disposed && s.idleTimer == timer
		s.mu.Unlock()
		if current {
			s.dispose(disposeIdleTimeout)
		}
	}()
}

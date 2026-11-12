package terminals

import (
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
	"errors"
	"sync"
)

// One connection owns one process, registered against the authenticated panel
// session. Text messages are protocol controls; binary messages are raw input.
type connEvents struct {
	svc        serviceApi
	revocation seam.SessionConnections
	sessionID  string
	mu         sync.Mutex
	conn       seam.WsConn
	session    sessionHandle
	unregister func()
	closed     bool
}

func newConnEvents(svc serviceApi, revocation seam.SessionConnections, sessionID string) *connEvents {
	return &connEvents{svc: svc, revocation: revocation, sessionID: sessionID}
}
func (e *connEvents) OnOpen(conn seam.WsConn) {
	e.mu.Lock()
	e.conn = conn
	e.mu.Unlock()
	defer func() {
		if recover() != nil {
			e.close(1011, "终端会话建立失败")
		}
	}()
	h := e.svc.tryOpen(connSessionEvents{e, conn})
	if h == nil {
		e.close(1008, TERMINAL_LIMIT_REASON)
		return
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		h.dispose(disposeClientClose)
		return
	}
	e.session = h
	e.mu.Unlock()
	if e.revocation != nil {
		unregister := e.revocation.Register(e.sessionID, func() { e.close(seam.SessionRevokedCloseCode, seam.SessionRevokedCloseReason) })
		e.mu.Lock()
		closed := e.closed
		if !closed {
			e.unregister = unregister
		}
		e.mu.Unlock()
		if closed {
			unregister()
		}
	}
}
func (e *connEvents) current() sessionHandle {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	return e.session
}
func (e *connEvents) OnMessage(_ seam.WsConn, text []byte) {
	h := e.current()
	if h == nil {
		return
	}
	frame, ok, reason := parseClientFrame(text)
	if !ok {
		e.close(1008, reason)
		return
	}
	defer func() {
		if recover() != nil {
			e.close(1011, "终端消息处理失败")
		}
	}()
	h.handleClientFrame(frame)
}
func (e *connEvents) OnBinaryMessage(_ seam.WsConn, data []byte) {
	defer func() {
		if recover() != nil {
			e.close(1011, "终端消息处理失败")
		}
	}()
	h := e.current()
	if h == nil {
		return
	}
	if len(data) > TERMINAL_INPUT_MAX_BYTES {
		e.close(1008, "终端输入过大")
		return
	}
	h.handleInput(data)
}
func (e *connEvents) OnClose()                      { e.finish(false, 0, "") }
func (e *connEvents) close(code int, reason string) { e.finish(true, code, reason) }
func (e *connEvents) finish(sendClose bool, code int, reason string) {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	h := e.session
	e.session = nil
	unregister := e.unregister
	e.unregister = nil
	conn := e.conn
	e.mu.Unlock()
	if sendClose && conn != nil {
		conn.Close(code, reason)
	}
	if unregister != nil {
		unregister()
	}
	if h != nil {
		h.dispose(disposeClientClose)
	}
}

type connSessionEvents struct {
	glue *connEvents
	conn seam.WsConn
}

func (e connSessionEvents) sendFrame(frame terminalFrame) {
	data, err := shared.MarshalJSON(frame)
	if err != nil || !e.conn.SendText(string(data)) {
		e.glue.close(1011, "终端连接中断")
	}
}
func (e connSessionEvents) sendData(data []byte) bool {
	conn, ok := e.conn.(seam.BinaryWsConn)
	return ok && conn.SendBinary(data)
}
func (e connSessionEvents) close(code int, reason string) { e.glue.close(code, reason) }

// kit 是 seam.TerminalKit 实现：docker 域容器 exec 终端复用同一套会话机与连接胶水。
type kit struct{}

var _ seam.TerminalKit = kit{}

// NewKit 产出终端会话机工具箱。
func NewKit() seam.TerminalKit { return kit{} }

// NewService shares the raw PTY transport with container exec terminals.
func (kit) NewService(deps seam.TerminalHostDeps, spec seam.ShellSessionSpec,
	identity func() seam.TerminalIdentity, maxSessions int) seam.TerminalsService {
	if identity == nil {
		identity = resolveHostIdentity
	}
	return newService(deps, identity, spec, maxSessions, realClock{})
}

// NewTotalLimitedService 合计上限包装器：getActive() 的跨服务活跃合计 ≥ max 时
// tryOpen 拒绝（连接层 1008 拒、不建 PTY）。包装器由本包产出，连接胶水的会话机
// 类型断言因此对包装后的服务依然成立；非本包产出的 inner 走 seam 兼容回退
// （帧丢弃，仅测试替身可达）。
func (kit) NewTotalLimitedService(inner seam.TerminalsService, getActive func() int, max int) seam.TerminalsService {
	api, ok := inner.(serviceApi)
	if !ok {
		return &totalLimitedCompat{inner: inner, getActive: getActive, max: max}
	}
	return &totalLimitedService{inner: api, getActive: getActive, max: max}
}

// totalLimitedService 合计上限包装器（本包会话机的装饰器）。
type totalLimitedService struct {
	inner     serviceApi
	getActive func() int
	max       int
}

var totalOpenMu sync.Mutex

func (s *totalLimitedService) tryOpen(events sessionEvents) sessionHandle {
	totalOpenMu.Lock()
	defer totalOpenMu.Unlock()
	if s.getActive() >= s.max {
		return nil
	}
	return s.inner.tryOpen(events)
}

func (s *totalLimitedService) activeCount() int { return s.inner.activeCount() }

// TryOpen 实现 seam.TerminalsService（seam 签名无事件出口，空出口兜底）。
func (s *totalLimitedService) TryOpen() (seam.TerminalSession, bool) {
	h := s.tryOpen(nullEvents{})
	if h == nil {
		return nil, false
	}
	return h, true
}

// ActiveCount 实现 seam.TerminalsService。
func (s *totalLimitedService) ActiveCount() int { return s.activeCount() }

// totalLimitedCompat 非本包会话机的 seam 兼容回退：走 seam TryOpen（帧被丢弃），
// 仅测试替身可达；生产装配的 inner 恒为本包产出。
type totalLimitedCompat struct {
	inner     seam.TerminalsService
	getActive func() int
	max       int
}

func (s *totalLimitedCompat) TryOpen() (seam.TerminalSession, bool) {
	if s.getActive() >= s.max {
		return nil, false
	}
	return s.inner.TryOpen()
}

func (s *totalLimitedCompat) ActiveCount() int { return s.inner.ActiveCount() }

// NewConnEvents binds a raw terminal to its authenticated panel session.
func (kit) NewConnEvents(svc seam.TerminalsService, revocation seam.SessionConnections, sessionID string) seam.TerminalConnEvents {
	api, ok := svc.(serviceApi)
	if !ok {
		return newConnEvents(incompatibleService{}, revocation, sessionID)
	}
	return newConnEvents(api, revocation, sessionID)
}

// incompatibleService 非 terminals 包产出的服务兜底：OnOpen 走 1011 建立失败路径。
type incompatibleService struct{}

func (incompatibleService) tryOpen(sessionEvents) sessionHandle {
	panic(errors.New("终端会话服务类型不兼容"))
}

func (incompatibleService) activeCount() int { return 0 }

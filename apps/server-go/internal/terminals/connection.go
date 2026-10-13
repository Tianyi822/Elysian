package terminals

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// WS 连接胶水：把 WebSocket 事件（open/message/close）接到会话服务上。一条升级
// 连接对应一个 connEvents（seam.TerminalConnEvents），一连接一会话。发送路径带水位
// 背压：seam.WsConn 的 BufferedAmount 超限即 1008 断开。全部处理器 recover 包裹：
// 畸形输入与服务层异常绝不外泄进事件回调。

// connEvents 一次 WS 升级连接的事件处理器（含会话撤销接线）。
type connEvents struct {
	svc        serviceApi
	revocation seam.SessionConnections // 可为 nil：不接线撤销表
	sessionID  string

	conn        seam.WsConn
	session     atomic.Pointer[sessBox] // OnOpen 建会话成功后填充；会话 goroutine 并发读
	lifecycleMu sync.Mutex
	unregister  func()
	closed      bool
	// violated 水位超限后的静默丢弃闸：连接已死（回落也救不回），后续帧静默丢弃、
	// 不重复关闭。
	violated atomic.Bool
}

// sessBox atomic.Pointer 的装箱（接口值不能直接进 atomic.Pointer）。
type sessBox struct{ h sessionHandle }

var _ seam.TerminalConnEvents = (*connEvents)(nil)

// newConnEvents 构造一次升级连接的事件处理器；revocation 可为 nil。
func newConnEvents(svc serviceApi, revocation seam.SessionConnections, sessionID string) *connEvents {
	return &connEvents{svc: svc, revocation: revocation, sessionID: sessionID}
}

// OnOpen 占用会话槽位；并发已达上限直接 1008 拒绝（不建 PTY、不登记撤销 closer）。
func (e *connEvents) OnOpen(conn seam.WsConn) {
	e.conn = conn
	defer func() {
		if r := recover(); r != nil {
			conn.Close(1011, "终端会话建立失败："+recoverText(r))
		}
	}()
	session := e.svc.tryOpen(connSessionEvents{glue: e, conn: conn})
	if session == nil {
		conn.Close(TERMINAL_VIOLATION_CLOSE_CODE, TERMINAL_LIMIT_REASON)
		return
	}
	e.lifecycleMu.Lock()
	if e.closed {
		e.lifecycleMu.Unlock()
		session.dispose(disposeClientClose)
		return
	}
	e.session.Store(&sessBox{h: session})
	e.lifecycleMu.Unlock()
	if e.revocation != nil {
		unregister := e.revocation.Register(e.sessionID, func() {
			conn.Close(seam.SessionRevokedCloseCode, seam.SessionRevokedCloseReason)
		})
		// 连接可能在 Register 返回前已关闭；迟到的登记句柄也必须回收。
		e.lifecycleMu.Lock()
		closed := e.closed
		if !closed {
			e.unregister = unregister
		}
		e.lifecycleMu.Unlock()
		if closed {
			unregister()
		}
	}
}

// OnMessage 处理一条客户端消息。text 为 nil 表示二进制帧（按「终端消息过大」违规）；
// 违规立即 1008 关闭并清理 PTY（不等 OnClose）。
func (e *connEvents) OnMessage(_ seam.WsConn, text []byte) {
	box := e.session.Load()
	if box == nil {
		// 被拒/无会话连接上的后续消息是 no-op。
		return
	}
	frame, ok, reason := parseClientFrame(text)
	if !ok {
		e.conn.Close(TERMINAL_VIOLATION_CLOSE_CODE, reason)
		box.h.dispose(disposeClientClose)
		return
	}
	defer func() { _ = recover() }() // 客户端帧处理异常：吞掉，会话由关闭路径收尾。
	box.h.handleClientFrame(frame)
}

// OnClose 客户端断开：撤销 closer 先于会话清理注销（连接已亡，后续 revoke 不再触碰）。
func (e *connEvents) OnClose() {
	e.lifecycleMu.Lock()
	e.closed = true
	unregister := e.unregister
	e.unregister = nil
	box := e.session.Swap(nil)
	e.lifecycleMu.Unlock()
	if unregister != nil {
		unregister()
	}
	if box == nil {
		return
	}
	box.h.dispose(disposeClientClose)
}

// recoverText 统一 panic 值转文本。
func recoverText(r any) string {
	if err, ok := r.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(r)
}

// connSessionEvents 会话事件出口绑到连接：帧序列化为 JSON 文本帧，发送前检查水位。
type connSessionEvents struct {
	glue *connEvents
	conn seam.WsConn
}

var _ sessionEvents = connSessionEvents{}

// sendFrame 序列化并发送；非 OPEN（SendText 返回 false）静默丢弃。发送前水位超限
// 即 1008 断开并清理会话；恰好等于上限不触发。
func (e connSessionEvents) sendFrame(frame terminalFrame) {
	if e.glue.violated.Load() {
		return
	}
	if e.conn.BufferedAmount() > TERMINAL_SEND_BUFFER_LIMIT_BYTES {
		// 慢消费连接：发送水位超限即断开——服务端发送缓冲不再无界增长。
		e.glue.violated.Store(true)
		e.conn.Close(TERMINAL_VIOLATION_CLOSE_CODE, TERMINAL_BACKPRESSURE_REASON)
		if box := e.glue.session.Load(); box != nil {
			box.h.dispose(disposeInternal)
		}
		return
	}
	data, err := shared.MarshalJSON(frame)
	if err != nil {
		return
	}
	e.conn.SendText(string(data))
}

// close 关闭底层连接（幂等由 seam.WsConn 实现保证）。
func (e connSessionEvents) close(code int, reason string) {
	e.conn.Close(code, reason)
}

// kit 是 seam.TerminalKit 实现：docker 域容器 exec 终端复用同一套会话机与连接胶水。
type kit struct{}

var _ seam.TerminalKit = kit{}

// NewKit 产出终端会话机工具箱。
func NewKit() seam.TerminalKit { return kit{} }

// NewService 建一个会话机：shell 驯化规格与会话身份解析由消费方注入（集成期 seam
// 修订）。本机终端由本包路由传入 HostShellSessionSpec 与 resolveHostIdentity；
// docker 容器 exec 终端传空启动行规格与按容器解析的身份。
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

func (s *totalLimitedService) tryOpen(events sessionEvents) sessionHandle {
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

// NewConnEvents 构造连接胶水；revocation 可为 nil（docker 容器终端不接线撤销表）。
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

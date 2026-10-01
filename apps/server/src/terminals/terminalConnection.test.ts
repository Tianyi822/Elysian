import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_BACKPRESSURE_REASON,
  TERMINAL_LIMIT_REASON,
  TERMINAL_SEND_BUFFER_LIMIT_BYTES,
  TERMINAL_VIOLATION_CLOSE_CODE,
  createTerminalWsEvents,
  type TerminalWsEvents,
  type WsConn,
} from './terminalConnection.ts'
import { SESSION_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_REASON, createSessionConnections, type SessionConnections } from '../auth/sessionConnections.ts'
import type {
  TerminalClientFrame,
} from './terminalFrames.ts'
import type {
  TerminalDisposeCause,
  TerminalServerFrame,
  TerminalSession,
  TerminalSessionEvents,
  TerminalsService,
} from './terminalsService.ts'

/*
 * 连接胶水的 fake 直驱测试：fake WsConn 记录发送与关闭、fake service 记录调用，
 * 锚定帧收发、并发拒绝与违规关闭码映射、发送水位背压、onClose 清理与异常不外泄。
 * 不依赖 Bun。
 */

/** fake 连接的可选注入：raw 模拟底层 socket（含/不含 bufferedAmount 的形状都可注入）。 */
type FakeRaw = object

function createFakeConn(options: { raw?: FakeRaw } = {}) {
  const sent: string[] = []
  const closes: { code: number; reason: string }[] = []
  let readyState = 1
  const conn: WsConn = {
    send: (text) => {
      sent.push(text)
    },
    close: (code, reason) => {
      readyState = 3
      closes.push({ code, reason })
    },
    get readyState() {
      return readyState
    },
    raw: options.raw,
  }
  const sentFrames = (): TerminalServerFrame[] => sent.map((text) => JSON.parse(text) as TerminalServerFrame)
  return { conn, sent, closes, sentFrames, setReadyState: (state: number) => (readyState = state) }
}

function createFakeService(options: { rejectOpen?: boolean; throwOnOpen?: boolean; throwOnFrame?: boolean } = {}) {
  const openedEvents: TerminalSessionEvents[] = []
  const handled: TerminalClientFrame[] = []
  const disposals: TerminalDisposeCause[] = []
  const service: TerminalsService = {
    tryOpen: (events) => {
      if (options.throwOnOpen) throw new Error('tryOpen 炸了')
      if (options.rejectOpen) return null
      openedEvents.push(events)
      const session: TerminalSession = {
        id: 'session-1',
        handleClientFrame: (frame) => {
          if (options.throwOnFrame) throw new Error('handleClientFrame 炸了')
          handled.push(frame)
        },
        dispose: async (cause) => {
          disposals.push(cause)
        },
      }
      return session
    },
    activeCount: () => openedEvents.length - disposals.length,
  }
  return { service, openedEvents, handled, disposals }
}

function openConnection(events: TerminalWsEvents, options: { raw?: FakeRaw } = {}): ReturnType<typeof createFakeConn> {
  const conn = createFakeConn(options)
  events.onOpen({ type: 'open' }, conn.conn)
  return conn
}

describe('createTerminalWsEvents', () => {
  it('onOpen 占用会话；服务层 sendFrame 序列化为 JSON 文本帧', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    expect(fake.openedEvents).toHaveLength(1)

    fake.openedEvents[0]?.sendFrame({ type: 'pong' })
    fake.openedEvents[0]?.sendFrame({ type: 'output', lines: ['hi'] })
    expect(conn.sent).toEqual(['{"type":"pong"}', '{"type":"output","lines":["hi"]}'])
    expect(conn.closes).toEqual([])
  })

  it('并发已达上限：1008 关闭且不建会话', () => {
    const fake = createFakeService({ rejectOpen: true })
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    expect(conn.closes).toEqual([{ code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_LIMIT_REASON }])
    expect(fake.openedEvents).toHaveLength(0)
    // 被拒连接上的后续消息与关闭是 no-op，不外泄。
    expect(() => events.onMessage({ data: '{"type":"ping"}' }, conn.conn)).not.toThrow()
    expect(() => events.onClose({ type: 'close' }, conn.conn)).not.toThrow()
  })

  it('合法帧透传给会话：input/interrupt/ping', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    events.onMessage({ data: '{"type":"input","data":"whoami"}' }, conn.conn)
    events.onMessage({ data: '{"type":"interrupt"}' }, conn.conn)
    events.onMessage({ data: '{"type":"ping"}' }, conn.conn)
    expect(fake.handled).toEqual([
      { type: 'input', data: 'whoami' },
      { type: 'interrupt' },
      { type: 'ping' },
    ])
    expect(fake.disposals).toEqual([])
  })

  it('违规帧矩阵：1008 配逐字中文 reason，并立即清理会话', () => {
    for (const [data, reason] of [
      ['not json', '终端消息不是有效 JSON'],
      ['{"type":"resize","cols":80}', '终端消息类型不允许'],
      ['{"type":"input","data":"a\\nb"}', '终端输入不合法'],
    ] as const) {
      const fake = createFakeService()
      const events = createTerminalWsEvents(fake.service)
      const conn = openConnection(events)
      events.onMessage({ data }, conn.conn)
      expect(conn.closes).toEqual([{ code: TERMINAL_VIOLATION_CLOSE_CODE, reason }])
      expect(fake.disposals).toEqual(['client-close'])
    }
  })

  it('二进制帧按「终端消息过大」关闭', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    events.onMessage({ data: new ArrayBuffer(8) }, conn.conn)
    expect(conn.closes).toEqual([{ code: TERMINAL_VIOLATION_CLOSE_CODE, reason: '终端消息过大' }])
    expect(fake.disposals).toEqual(['client-close'])
  })

  it('onClose 触发会话清理（客户端断开）', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    events.onClose({ type: 'close' }, conn.conn)
    expect(fake.disposals).toEqual(['client-close'])
  })

  it('服务层异常不外泄：tryOpen 抛错 → 1011 关闭；帧处理抛错被吞', () => {
    const throwing = createFakeService({ throwOnOpen: true })
    const events = createTerminalWsEvents(throwing.service)
    const conn = openConnection(events)
    expect(conn.closes[0]?.code).toBe(1011)
    expect(conn.closes[0]?.reason).toContain('终端会话建立失败')

    const frameThrowing = createFakeService({ throwOnFrame: true })
    const events2 = createTerminalWsEvents(frameThrowing.service)
    const conn2 = openConnection(events2)
    expect(() => events2.onMessage({ data: '{"type":"ping"}' }, conn2.conn)).not.toThrow()
  })

  it('同一连接的每个事件换 WSContext 包装（raw 相同）仍路由到同一会话', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const raw = { tag: 'socket-1' }
    // hono/bun 对每个事件新建 WSContext：同一 raw、不同包装实例。
    const openView = createFakeConn()
    const openConn = { ...openView.conn, raw }
    events.onOpen({ type: 'open' }, openConn)
    expect(fake.openedEvents).toHaveLength(1)

    const messageView = createFakeConn()
    const messageConn = { ...messageView.conn, raw }
    events.onMessage({ data: '{"type":"ping"}' }, messageConn)
    expect(fake.handled).toEqual([{ type: 'ping' }])

    const closeView = createFakeConn()
    const closeConn = { ...closeView.conn, raw }
    events.onClose({ type: 'close' }, closeConn)
    expect(fake.disposals).toEqual(['client-close'])
  })

  it('连接非 OPEN 时帧丢弃且不抛错', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events)
    conn.setReadyState(3)
    expect(() => fake.openedEvents[0]?.sendFrame({ type: 'pong' })).not.toThrow()
    expect(conn.sent).toEqual([])
  })

  it('发送水位超限（慢消费背压）：1008 断开、会话清理、帧不再发送', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const raw = { bufferedAmount: TERMINAL_SEND_BUFFER_LIMIT_BYTES + 1 }
    const conn = openConnection(events, { raw })
    expect(() => fake.openedEvents[0]?.sendFrame({ type: 'pong' })).not.toThrow()
    expect(conn.sent).toEqual([])
    expect(conn.closes).toEqual([{ code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_BACKPRESSURE_REASON }])
    expect(fake.disposals).toEqual(['internal'])
    // 连接已死（水位回落也改变不了 readyState）：后续帧静默丢弃，不重复关闭。
    raw.bufferedAmount = 0
    expect(() => fake.openedEvents[0]?.sendFrame({ type: 'pong' })).not.toThrow()
    expect(conn.sent).toEqual([])
    expect(conn.closes).toHaveLength(1)
  })

  it('发送水位在限内（含恰好等于上限）：帧正常发送', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events, { raw: { bufferedAmount: TERMINAL_SEND_BUFFER_LIMIT_BYTES } })
    fake.openedEvents[0]?.sendFrame({ type: 'pong' })
    expect(conn.sentFrames()).toEqual([{ type: 'pong' }])
    expect(conn.closes).toEqual([])
    expect(fake.disposals).toEqual([])
  })

  it('raw 不暴露 bufferedAmount 时（非 Bun 形状）不触发水位断开', () => {
    const fake = createFakeService()
    const events = createTerminalWsEvents(fake.service)
    const conn = openConnection(events, { raw: { tag: 'socket' } })
    fake.openedEvents[0]?.sendFrame({ type: 'pong' })
    expect(conn.sentFrames()).toEqual([{ type: 'pong' }])
    expect(conn.closes).toEqual([])
  })
})

/** spy 版撤销表：只看登记/注销调用；关闭行为用真撤销表测。 */
function spySessionConnections(): SessionConnections {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    revoke: vi.fn(),
    revokeOthers: vi.fn(),
    revokeAll: vi.fn(),
  }
}

describe('createTerminalWsEvents 的会话撤销接线', () => {
  it('带 revocation 时 onOpen 登记 closer；撤销触发后连接以 1008 与中文 reason 关闭', () => {
    const fake = createFakeService()
    const connections = createSessionConnections()
    const events = createTerminalWsEvents(fake.service, { sessionId: 'abc', connections })
    const conn = openConnection(events)

    // 登记进撤销表：revoke 触发 closer，连接以撤销口径关闭（closer 先把自己摘出
    // 撤销表再关闭，撤销是一次性的、不重复关闭）。
    connections.revoke('abc')
    expect(conn.closes).toEqual([{ code: SESSION_REVOKED_CLOSE_CODE, reason: SESSION_REVOKED_CLOSE_REASON }])
    // PTY 清理走 close 触发的 onClose 既有路径，不由 closer 代劳。
    expect(fake.disposals).toEqual([])
  })

  it('onClose 注销后 revoke 不重复关闭该连接（自然断开的连接退出撤销表）', () => {
    const fake = createFakeService()
    const connections = createSessionConnections()
    const events = createTerminalWsEvents(fake.service, { sessionId: 'abc', connections })
    const conn = openConnection(events)

    events.onClose({ type: 'close' }, conn.conn)
    expect(fake.disposals).toEqual(['client-close'])

    connections.revoke('abc')
    expect(conn.closes).toEqual([])
  })

  it('并发上限拒绝（不建会话）时不登记撤销 closer', () => {
    const fake = createFakeService({ rejectOpen: true })
    const connections = spySessionConnections()
    const events = createTerminalWsEvents(fake.service, { sessionId: 'abc', connections })
    const conn = openConnection(events)

    expect(conn.closes).toEqual([{ code: TERMINAL_VIOLATION_CLOSE_CODE, reason: TERMINAL_LIMIT_REASON }])
    expect(connections.register).not.toHaveBeenCalled()
  })
})

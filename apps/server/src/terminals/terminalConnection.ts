import { parseTerminalClientFrame } from './terminalFrames.ts'
import type { TerminalDisposeCause, TerminalSession, TerminalSessionEvents, TerminalsService } from './terminalsService.ts'

/*
 * WS 连接胶水：把 hono/Bun 的 WebSocket 事件（open/message/close）接到会话服务上。
 * 每条连接对应一个服务端会话（一连接一会话），连接对象只需满足最小 WsConn 接口
 * （send/close/readyState）——hono 的 WSContext 结构兼容，vitest 用 fake 连接直驱，
 * 不依赖 Bun 运行时。发送路径带水位背压：raw 上暴露的 bufferedAmount 超限即断开。
 * 全部处理器 try/catch 包裹：畸形输入与服务层异常绝不外泄进 WebSocket 事件回调。
 */

/**
 * 连接的最小形状：hono WSContext 结构兼容（send 接受字符串、close 带 code/reason）。
 * raw 除作会话账本键外，还按 duck-typing 读取 bufferedAmount（Bun ServerWebSocket
 * 的未发送字节数）作发送水位；不可得时按 0 处理。
 */
export type WsConn = {
  send(text: string): void
  close(code: number, reason: string): void
  readyState: number
  /**
   * 底层连接对象：hono/bun 的 websocket handler 对每个事件都新建 WSContext 包装，
   * 会话账本必须钉在原始 socket 上（同一连接的 open/message/close 各自带不同的
   * 包装实例）；fake 连接可不带，此时以连接对象自身为键。
   */
  readonly raw?: unknown
}

/** WebSocket 的 OPEN 状态值（readyState === 1）。 */
const WS_READY_STATE_OPEN = 1

/** 升级事件处理器：传给 bunWebSocket.upgradeWebSocket 的 onOpen/onMessage/onClose。 */
export type TerminalWsEvents = {
  onOpen(evt: unknown, conn: WsConn): void
  onMessage(evt: { data: unknown }, conn: WsConn): void
  onClose(evt: unknown, conn: WsConn): void
}

/** 协议违规的统一关闭口径：1008 + 中文 reason。 */
export const TERMINAL_VIOLATION_CLOSE_CODE = 1008

/** 并发上限拒绝文案（与方案「端点契约」逐字一致）。 */
export const TERMINAL_LIMIT_REASON = '并发终端会话已达上限（5）'

/** 单连接发送缓冲水位上限：底层 socket 未发送字节超过即 1008 断开（慢消费背压终态）。 */
export const TERMINAL_SEND_BUFFER_LIMIT_BYTES = 1024 * 1024

/** 发送水位超限的关闭 reason（中文口径）。 */
export const TERMINAL_BACKPRESSURE_REASON = '终端连接发送缓冲超限'

/** 底层 socket 的未发送字节数（Bun ServerWebSocket.bufferedAmount 的 duck-typing）。 */
function bufferedBytes(conn: WsConn): number {
  const buffered = (conn.raw as { bufferedAmount?: unknown } | undefined)?.bufferedAmount
  return typeof buffered === 'number' ? buffered : 0
}

export function createTerminalWsEvents(service: TerminalsService): TerminalWsEvents {
  const sessions = new WeakMap<object, TerminalSession>()

  /** 会话账本键：底层 socket（raw）优先——同一连接的每个事件都是新的 WSContext 包装。 */
  function keyOf(conn: WsConn): object {
    return (conn.raw as object | undefined) ?? (conn as WsConn & object)
  }

  function eventsFor(conn: WsConn): TerminalSessionEvents {
    return {
      sendFrame: (frame) => {
        try {
          if (conn.readyState !== WS_READY_STATE_OPEN) return
          if (bufferedBytes(conn) > TERMINAL_SEND_BUFFER_LIMIT_BYTES) {
            // 慢消费连接：发送水位超限即 1008 断开并清理会话——断开是终端场景下
            // 背压的合理终态，服务端发送缓冲不再无界增长。
            conn.close(TERMINAL_VIOLATION_CLOSE_CODE, TERMINAL_BACKPRESSURE_REASON)
            const session = sessions.get(keyOf(conn))
            if (session) disposeQuietly(session, 'internal')
            return
          }
          conn.send(JSON.stringify(frame))
        } catch {
          // 连接已死：帧丢弃，不外泄。
        }
      },
      close: (code, reason) => {
        try {
          conn.close(code, reason)
        } catch {
          // 已关闭的连接再次 close：忽略。
        }
      },
    }
  }

  function disposeQuietly(session: TerminalSession, cause: TerminalDisposeCause): void {
    session.dispose(cause).catch(() => undefined)
  }

  return {
    onOpen(_evt, conn) {
      try {
        const session = service.tryOpen(eventsFor(conn))
        if (!session) {
          // 并发已达上限：不建 PTY，直接 1008 拒绝。
          conn.close(TERMINAL_VIOLATION_CLOSE_CODE, TERMINAL_LIMIT_REASON)
          return
        }
        sessions.set(keyOf(conn), session)
      } catch (error) {
        conn.close(1011, `终端会话建立失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    onMessage(evt, conn) {
      const session = sessions.get(keyOf(conn))
      if (!session) return
      let result: ReturnType<typeof parseTerminalClientFrame>
      try {
        result = parseTerminalClientFrame(evt.data)
      } catch {
        // 解析器自身全 catch，这里双保险：绝不向事件回调外泄异常。
        conn.close(TERMINAL_VIOLATION_CLOSE_CODE, '终端消息不是有效 JSON')
        disposeQuietly(session, 'client-close')
        return
      }
      if (!result.ok) {
        conn.close(TERMINAL_VIOLATION_CLOSE_CODE, result.reason)
        // 违规即断开：立即清理 PTY，不等 onClose 事件。
        disposeQuietly(session, 'client-close')
        return
      }
      try {
        session.handleClientFrame(result.frame)
      } catch {
        // 客户端帧处理异常：吞掉，会话由关闭路径收尾。
      }
    },
    onClose(_evt, conn) {
      const session = sessions.get(keyOf(conn))
      if (!session) return
      sessions.delete(keyOf(conn))
      disposeQuietly(session, 'client-close')
    },
  }
}

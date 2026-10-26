import {
  completeWithPools,
  hostTerminalCloseMessage,
  type TerminalCompletion,
} from '../../components/terminal/terminalSession'
import type {
  HostTerminalCloseInfo,
  HostTerminalHandlers,
  HostTerminalSessionInfo,
  TerminalAdapter,
} from '../../contracts/adapters'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

/*
 * Docker 运行时的本机终端适配器：经同源 WebSocket 接容器内 PTY（协议权威见
 * docs/specs/2026-09-22-terminal-real-implementation.md「端点契约」）。
 * 一连接一会话；ready 帧后 connect 才 resolve，prompt 帧持续更新提示符与补全词表。
 * socketFactory 是唯一接缝：浏览器里缺省 new WebSocket(url)，测试注入假类。
 */

/** 终端 WS 端点与辅助状态端点（与 server 侧 TERMINAL_MOUNT 同值）。 */
const TERMINAL_WS_PATH = '/api/terminals/ws'
const TERMINAL_STATUS_URL = '/api/terminals/status'
/** status 端点也拿不到原因时的兜底文案（协议「客户端错误映射」）。 */
const CONNECT_FALLBACK_ERROR = '连接本机终端失败'

/** 浏览器 WebSocket readyState 取值（RFC 6455 侧常量的本地副本，测试不依赖 DOM 实现）。 */
const SOCKET_OPEN = 1

/** 适配器依赖的浏览器 WebSocket 最小结构；测试注入假类。 */
export type TerminalSocket = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
}

export type TerminalSocketFactory = (url: string) => TerminalSocket

function defaultSocketFactory(url: string): TerminalSocket {
  try { return new WebSocket(url) }
  catch { throw new Error('浏览器无法建立终端连接，请检查浏览器网络策略或更换浏览器重试') }
}

/** 已 ready 的会话：socket、回调与补全上下文缓存（commands 来自 ready 帧，files 来自 prompt 帧）。 */
type LiveSession = {
  id: string
  socket: TerminalSocket
  handlers: HostTerminalHandlers
  commands: readonly string[]
  files: readonly string[] | null
}

/** connect 未 resolve 前的连接记录：升级是否发生过决定失败时的错误映射路径。 */
type PendingConnect = {
  socket: TerminalSocket
  handlers: HostTerminalHandlers
  opened: boolean
  settled: boolean
  resolve: (info: HostTerminalSessionInfo) => void
  reject: (error: Error) => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

/** 解析 ready 帧：session 四字段齐全、commands 容错为数组外的空表；畸形返回 null（连接交给 onclose 收尾）。 */
function parseReadyFrame(
  frame: Record<string, unknown>,
): { session: HostTerminalSessionInfo; commands: readonly string[] } | null {
  const session = frame.session
  if (!isObject(session)) return null
  if (
    typeof session.id !== 'string' ||
    session.id.length === 0 ||
    typeof session.user !== 'string' ||
    typeof session.hostLabel !== 'string' ||
    typeof session.prompt !== 'string'
  ) {
    return null
  }
  const completion = isObject(frame.completion) ? frame.completion : {}
  const commands = asStringArray(completion.commands) ?? []
  return {
    session: {
      id: session.id,
      user: session.user,
      hostLabel: session.hostLabel,
      prompt: session.prompt,
    },
    commands,
  }
}

/** 连接建立前失败：按协议请求 status 端点取回中文原因，拿不到用兜底文案。 */
async function fetchConnectError(): Promise<string> {
  try {
    const response = await fetchWithSession(TERMINAL_STATUS_URL)
    // 会话过期的升级拒绝同样回 401：先上报（前端随后跳登录），再走中文原因路径。
    reportUnauthorized(response)
    const body: unknown = await response.json()
    if (isObject(body) && typeof body.error === 'string' && body.error.length > 0) {
      return body.error
    }
  } catch {
    // status 端点不可达或非 JSON：走兜底文案。
  }
  return CONNECT_FALLBACK_ERROR
}

export function createTerminalWsAdapter(
  socketFactory: TerminalSocketFactory = defaultSocketFactory,
): TerminalAdapter & { reset(): void } {
  const pendingBySocket = new Map<TerminalSocket, PendingConnect>()
  const sessionsById = new Map<string, LiveSession>()
  const sessionBySocket = new Map<TerminalSocket, LiveSession>()

  function wsUrl(): string {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${window.location.host}${TERMINAL_WS_PATH}`
  }

  function handlePayload(socket: TerminalSocket, data: unknown): void {
    if (typeof data !== 'string') return // 二进制帧不出现在该端点；防御性忽略
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return // 畸形帧不崩适配器；连接由服务端关闭路径收尾
    }
    if (!isObject(payload)) return

    const pending = pendingBySocket.get(socket)
    if (pending && payload.type === 'ready') {
      const parsed = parseReadyFrame(payload)
      if (!parsed) return
      pendingBySocket.delete(socket)
      const live: LiveSession = {
        id: parsed.session.id,
        socket,
        handlers: pending.handlers,
        commands: parsed.commands,
        files: null,
      }
      sessionsById.set(live.id, live)
      sessionBySocket.set(socket, live)
      pending.settled = true
      pending.resolve(parsed.session)
      return
    }

    const live = sessionBySocket.get(socket)
    if (!live) return
    switch (payload.type) {
      case 'output': {
        const lines = asStringArray(payload.lines)
        if (lines && lines.length > 0) {
          live.handlers.onFrame(live.id, { type: 'output', lines })
        }
        return
      }
      case 'prompt': {
        if (typeof payload.prompt !== 'string') return
        const completion = isObject(payload.completion) ? payload.completion : {}
        const files = asStringArray(completion.files)
        live.files = files
        live.handlers.onFrame(live.id, { type: 'prompt', prompt: payload.prompt })
        return
      }
      case 'truncated': {
        if (typeof payload.droppedBytes !== 'number') return
        live.handlers.onFrame(live.id, { type: 'truncated', droppedBytes: payload.droppedBytes })
        return
      }
      case 'exit': {
        if (typeof payload.exitCode !== 'number') return
        live.handlers.onFrame(live.id, { type: 'exit', exitCode: payload.exitCode })
        return
      }
      default:
        return // pong 等未知帧：无界面语义，忽略
    }
  }

  function handleSocketClose(socket: TerminalSocket, code: number, reason: string): void {
    const pending = pendingBySocket.get(socket)
    if (pending) {
      pendingBySocket.delete(socket)
      if (pending.settled) return
      pending.settled = true
      if (!pending.opened) {
        // 连接建立前失败（升级被拒/网络错误）：status 端点取中文原因后 reject。
        void fetchConnectError().then(
          (message) => pending.reject(new Error(message)),
          () => pending.reject(new Error(CONNECT_FALLBACK_ERROR)),
        )
        return
      }
      // 升级成功但 ready 前被服务端关闭（如并发上限 1008）：按关闭码映射 reject。
      pending.reject(new Error(hostTerminalCloseMessage(code, reason)))
      return
    }

    const live = sessionBySocket.get(socket)
    if (!live) return
    sessionBySocket.delete(socket)
    sessionsById.delete(live.id)
    const info: HostTerminalCloseInfo = { code, reason }
    live.handlers.onClose(live.id, info)
  }

  function requireLive(sessionId: string): LiveSession {
    const live = sessionsById.get(sessionId)
    if (!live) throw new Error(`终端会话不存在 ${sessionId}`)
    if (live.socket.readyState !== SOCKET_OPEN) throw new Error(`终端会话不存在 ${sessionId}`)
    return live
  }

  return {
    async connect(handlers: HostTerminalHandlers): Promise<HostTerminalSessionInfo> {
      const socket = socketFactory(wsUrl())
      let resolve!: (info: HostTerminalSessionInfo) => void
      let reject!: (error: Error) => void
      const ready = new Promise<HostTerminalSessionInfo>((res, rej) => {
        resolve = res
        reject = rej
      })
      const pending: PendingConnect = {
        socket,
        handlers,
        opened: false,
        settled: false,
        resolve,
        reject,
      }
      pendingBySocket.set(socket, pending)
      socket.addEventListener('open', () => {
        pending.opened = true
      })
      socket.addEventListener('message', (event) => handlePayload(socket, event.data))
      socket.addEventListener('close', (event) => handleSocketClose(socket, event.code, event.reason))
      return ready
    },

    async sendInput(sessionId: string, line: string): Promise<void> {
      const live = requireLive(sessionId)
      live.socket.send(JSON.stringify({ type: 'input', data: line }))
    },

    async interrupt(sessionId: string): Promise<void> {
      const live = requireLive(sessionId)
      live.socket.send(JSON.stringify({ type: 'interrupt' }))
    },

    complete(sessionId: string, draft: string, cursor: number): TerminalCompletion {
      const live = sessionsById.get(sessionId)
      if (!live) return { draft, cursor }
      return completeWithPools(draft, cursor, { commands: live.commands, words: live.files })
    },

    async disconnect(sessionId: string): Promise<void> {
      const live = sessionsById.get(sessionId)
      if (!live) throw new Error(`终端会话不存在 ${sessionId}`)
      sessionsById.delete(sessionId)
      sessionBySocket.delete(live.socket)
      live.socket.close(1000)
    },

    reset(): void {
      for (const pending of [...pendingBySocket.values()]) {
        pendingBySocket.delete(pending.socket)
        if (!pending.settled) {
          pending.settled = true
          pending.reject(new Error(CONNECT_FALLBACK_ERROR))
        }
        pending.socket.close(1000)
      }
      for (const live of [...sessionBySocket.values()]) {
        sessionBySocket.delete(live.socket)
        sessionsById.delete(live.id)
        live.socket.close(1000)
      }
    },
  }
}

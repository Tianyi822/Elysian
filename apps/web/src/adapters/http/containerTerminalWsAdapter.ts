import { completeWithPools, hostTerminalCloseMessage } from '../../components/terminal/terminalSession'
import type { TerminalCompletion } from '../../components/terminal/terminalSession'
import { CONTAINER_TERMINAL_CLOSE_FALLBACK } from '../../features/container/containerCopy'
import type {
  HostTerminalCloseInfo,
  HostTerminalHandlers,
  HostTerminalSessionInfo,
} from '../../contracts/adapters'
import type { TerminalSocket, TerminalSocketFactory } from './terminalWsAdapter'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

/*
 * Docker 运行时的容器终端：经同源 WebSocket 接指定容器的 exec PTY。
 * 协议帧与本机终端相同；端点为 /api/docker/containers/:id/terminal。
 */

const DOCKER_API_BASE = '/api/docker'
const DOCKER_STATUS_URL = `${DOCKER_API_BASE}/status`
const CONNECT_FALLBACK_ERROR = '连接容器终端失败'

const SOCKET_OPEN = 1

function defaultSocketFactory(url: string): TerminalSocket {
  return new WebSocket(url)
}

type LiveSession = {
  id: string
  socket: TerminalSocket
  handlers: HostTerminalHandlers
  commands: readonly string[]
  files: readonly string[] | null
}

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

async function fetchConnectError(): Promise<string> {
  try {
    const response = await fetchWithSession(DOCKER_STATUS_URL)
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

export function createContainerTerminalWsAdapter(
  socketFactory: TerminalSocketFactory = defaultSocketFactory,
) {
  const pendingBySocket = new Map<TerminalSocket, PendingConnect>()
  const sessionsById = new Map<string, LiveSession>()
  const sessionBySocket = new Map<TerminalSocket, LiveSession>()

  function wsUrl(containerId: string): string {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const path = `${DOCKER_API_BASE}/containers/${encodeURIComponent(containerId)}/terminal`
    return `${scheme}://${window.location.host}${path}`
  }

  function handlePayload(socket: TerminalSocket, data: unknown): void {
    if (typeof data !== 'string') return
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return
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
        return
    }
  }

  function handleSocketClose(socket: TerminalSocket, code: number, reason: string): void {
    const pending = pendingBySocket.get(socket)
    if (pending) {
      pendingBySocket.delete(socket)
      if (pending.settled) return
      pending.settled = true
      if (!pending.opened) {
        void fetchConnectError().then(
          (message) => pending.reject(new Error(message)),
          () => pending.reject(new Error(CONNECT_FALLBACK_ERROR)),
        )
        return
      }
      // 升级成功但 ready 前被服务端关闭（如并发上限 1008）：按关闭码映射 reject，
      // 兜底措辞用容器域文案。
      pending.reject(
        new Error(hostTerminalCloseMessage(code, reason, CONTAINER_TERMINAL_CLOSE_FALLBACK)),
      )
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
    async connectTerminal(
      containerId: string,
      handlers: HostTerminalHandlers,
    ): Promise<HostTerminalSessionInfo> {
      const socket = socketFactory(wsUrl(containerId))
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

    async sendTerminalInput(sessionId: string, line: string): Promise<void> {
      const live = requireLive(sessionId)
      live.socket.send(JSON.stringify({ type: 'input', data: line }))
    },

    async interruptTerminal(sessionId: string): Promise<void> {
      const live = requireLive(sessionId)
      live.socket.send(JSON.stringify({ type: 'interrupt' }))
    },

    completeTerminal(sessionId: string, draft: string, cursor: number): TerminalCompletion {
      const live = sessionsById.get(sessionId)
      if (!live) return { draft, cursor }
      return completeWithPools(draft, cursor, { commands: live.commands, words: live.files })
    },

    async disconnectTerminal(sessionId: string): Promise<void> {
      const live = sessionsById.get(sessionId)
      if (!live) throw new Error(`终端会话不存在 ${sessionId}`)
      sessionsById.delete(sessionId)
      sessionBySocket.delete(live.socket)
      live.socket.close(1000)
    },

    cancelTerminalConnect(): void {
      // 取消未决连接：先 settle（reject 兜底文案）再关 socket，与 reset() 同形态——
      // 只关 socket 不 reject 会让被取消的 connectTerminal promise 永不落定。
      // 只作用于未 ready 的 pending；已 ready 会话仍走 disconnectTerminal。
      for (const pending of [...pendingBySocket.values()]) {
        pendingBySocket.delete(pending.socket)
        if (!pending.settled) {
          pending.settled = true
          pending.reject(new Error(CONNECT_FALLBACK_ERROR))
        }
        pending.socket.close(1000)
      }
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

import type { HostTerminalHandlers, HostTerminalSessionInfo, TerminalAdapter } from '../../contracts/adapters'
import { hostTerminalCloseMessage } from '../../components/terminal/terminalCloseMessage'
import { captureAuthGeneration, fetchWithSession, reportUnauthorized } from './unauthorized'

export type TerminalSocket = {
  readonly readyState: number
  readonly bufferedAmount?: number
  binaryType?: string
  send(data: string | Uint8Array<ArrayBuffer>): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
}
export type TerminalSocketFactory = (url: string) => TerminalSocket

type Connection = {
  socket: TerminalSocket
  handlers: HostTerminalHandlers
  generation: number
  opened: boolean
  settled: boolean
  id?: string
  resolve(info: HostTerminalSessionInfo): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const MAX_CHUNK = 32 * 1024
const MAX_SEND_BUFFER = 1024 * 1024

export function createRawTerminalTransport(options: {
  path: string | ((target?: string) => string)
  statusPath: string
  fallback: string
  socketFactory?: TerminalSocketFactory
}) {
  const connections = new Set<Connection>()
  const sessions = new Map<string, Connection>()
  const factory: TerminalSocketFactory = options.socketFactory ?? ((url: string) => {
    try { return new WebSocket(url) }
    catch { throw new Error('浏览器无法建立终端连接，请检查浏览器网络策略或更换浏览器重试') }
  })
  const remove = (connection: Connection) => {
    clearTimeout(connection.timer)
    connections.delete(connection)
    if (connection.id) sessions.delete(connection.id)
  }
  async function connectError(): Promise<string> {
    try {
      const response = await fetchWithSession(options.statusPath)
      reportUnauthorized(response)
      const body: unknown = await response.json()
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
    } catch { /* 不可达时用固定中文错误。 */ }
    return options.fallback
  }
  function requireSession(id: string): Connection {
    const connection = sessions.get(id)
    if (!connection || connection.socket.readyState !== 1 || connection.generation !== captureAuthGeneration()) {
      throw new Error(`终端会话不存在 ${id}`)
    }
    return connection
  }
  function send(connection: Connection, data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
    if ((connection.socket.bufferedAmount ?? 0) + bytes > MAX_SEND_BUFFER) {
      connection.socket.close(1008, '终端输入发送缓冲区已满')
      throw new Error('终端输入发送缓冲区已满')
    }
    connection.socket.send(typeof data === 'string' ? data : new Uint8Array(data))
  }
  function cancel(connection: Connection) {
    remove(connection)
    if (!connection.settled) {
      connection.settled = true
      connection.reject(new Error(options.fallback))
    }
    connection.socket.close(1000)
  }
  return {
    connect(handlers: HostTerminalHandlers, target?: string): Promise<HostTerminalSessionInfo> {
      const path = typeof options.path === 'function' ? options.path(target) : options.path
      const url = new URL(path, window.location.href)
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('protocol', '2')
      const socket = factory(url.toString())
      socket.binaryType = 'arraybuffer'
      return new Promise((resolve, reject) => {
        const connection: Connection = {
          socket, handlers, generation: captureAuthGeneration(), opened: false, settled: false, resolve, reject,
          timer: setTimeout(() => cancel(connection), 15_000),
        }
        connections.add(connection)
        socket.addEventListener('open', () => { connection.opened = true })
        socket.addEventListener('message', ({ data }) => {
          if (!connections.has(connection) || connection.generation !== captureAuthGeneration()) { cancel(connection); return }
          if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            if (!connection.id) { socket.close(1008, '终端尚未就绪'); return }
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
            if (bytes.byteLength > MAX_CHUNK) { socket.close(1008, '终端输出帧超出上限'); return }
            if (bytes.byteLength) handlers.onFrame(connection.id, { type: 'output', data: bytes })
            return
          }
          if (typeof data !== 'string') { socket.close(1008, '终端消息格式无效'); return }
          let frame: Record<string, unknown>
          try { frame = JSON.parse(data) as Record<string, unknown> } catch { socket.close(1008, '终端消息格式无效'); return }
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { socket.close(1008, '终端消息格式无效'); return }
          if (!connection.id && frame.type === 'ready') {
            const identity = frame.session as Record<string, unknown> | undefined
            if (frame.protocol !== 2 || !identity || typeof identity.id !== 'string' || !identity.id || typeof identity.user !== 'string' || typeof identity.hostLabel !== 'string') {
              cancel(connection); return
            }
            clearTimeout(connection.timer)
            connection.id = identity.id
            connection.settled = true
            sessions.set(identity.id, connection)
            resolve({ id: identity.id, user: identity.user, hostLabel: identity.hostLabel })
          } else if (connection.id && frame.type === 'exit' && Number.isInteger(frame.exitCode)) {
            handlers.onFrame(connection.id, { type: 'exit', exitCode: frame.exitCode as number })
          }
        })
        socket.addEventListener('close', ({ code, reason }) => {
          if (!connections.has(connection)) return
          remove(connection)
          if (!connection.settled) {
            connection.settled = true
            if (!connection.opened) void connectError().then(message => reject(new Error(message)))
            else reject(new Error(hostTerminalCloseMessage(code, reason, options.fallback)))
          } else if (connection.id) handlers.onClose(connection.id, { code, reason })
        })
        socket.addEventListener('error', () => { /* close 或连接超时统一结算。 */ })
      })
    },
    async sendInput(id: string, data: Uint8Array) {
      const connection = requireSession(id)
      for (let offset = 0; offset < data.byteLength; offset += MAX_CHUNK) send(connection, new Uint8Array(data.subarray(offset, offset + MAX_CHUNK)))
    },
    async resize(id: string, cols: number, rows: number) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return
      send(requireSession(id), JSON.stringify({ type: 'resize', cols, rows }))
    },
    acknowledge(id: string, bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return
      const connection = sessions.get(id)
      if (connection?.socket.readyState === 1 && connection.generation === captureAuthGeneration()) send(connection, JSON.stringify({ type: 'ack', bytes }))
    },
    async disconnect(id: string) {
      const connection = sessions.get(id)
      if (!connection) throw new Error(`终端会话不存在 ${id}`)
      cancel(connection)
    },
    cancelConnect() { for (const connection of [...connections]) if (!connection.settled) cancel(connection) },
    reset() { for (const connection of [...connections]) cancel(connection) },
  }
}

export function createTerminalWsAdapter(socketFactory?: TerminalSocketFactory): TerminalAdapter & { reset(): void } {
  return { mode: 'pty', ...createRawTerminalTransport({ path: '/api/terminals/ws', statusPath: '/api/terminals/status', fallback: '连接本机终端失败', socketFactory }) }
}

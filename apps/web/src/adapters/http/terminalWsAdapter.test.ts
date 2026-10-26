import { describe, expect, it, vi } from 'vitest'
import type {
  HostTerminalCloseInfo,
  HostTerminalFrame,
  HostTerminalHandlers,
} from '../../contracts/adapters'
import { collectFrames, runTerminalAdapterContract } from '../terminalAdapterContract'
import type { TerminalSocket } from './terminalWsAdapter'
import { createTerminalWsAdapter } from './terminalWsAdapter'

/*
 * 终端 WS 适配器：注入假 WebSocket 类直驱，不依赖真实网络与 server 片。
 * 契约断言与 mock 实现共用同一套；其余用例锚定协议特有行为：
 * 连接失败取 status 端点中文原因、升级后被拒按关闭码映射、帧路由与补全缓存。
 */

/** never 参数使其能同时充当 open/error/message/close 四种 listener 的实现签名。 */
type FrameListener = (event: never) => void

/** 测试驱动的假浏览器 WebSocket：服务端行为经 server* 方法注入。 */
class FakeTerminalSocket implements TerminalSocket {
  readyState = 0
  readonly url: string
  readonly sent: string[] = []
  /** 可选钩子：客户端 send 后的自动应答（模拟服务端对 input 的输出）。 */
  onClientSend: ((data: string) => void) | undefined
  private readonly listeners = new Map<string, FrameListener[]>()

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
    this.onClientSend?.(data)
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code, reason: '' })
  }

  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: string, listener: FrameListener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (payload: unknown) => void)(event)
    }
  }

  // —— 测试侧的服务端驱动口 ——
  serverOpen(): void {
    this.readyState = 1
    this.dispatch('open', undefined)
  }

  serverSend(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }

  /** 原样投递非 JSON 或二进制载荷（协议外的畸形输入）。 */
  serverRaw(data: unknown): void {
    this.dispatch('message', { data })
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
}

const READY_PROMPT = 'root@elysian-web-1:~$ '

/** 第 n 条连接的 ready 帧：会话 id 唯一（一连接一会话）。 */
function readyFrame(seq: number): Record<string, unknown> {
  return {
    type: 'ready',
    session: { id: `uuid-${seq}`, user: 'root', hostLabel: 'elysian-web-1', prompt: READY_PROMPT },
    completion: { commands: ['whoami', 'hostname', 'ls'] },
  }
}

/**
 * 契约用工厂：连接后自动完成升级与 ready 帧（微任务里派发，等 addEventListener 挂好），
 * 收到 whoami 的 input 帧时回一行输出——契约断言只锁「有输出」，不锁取值。
 */
function autoReadyFactory(sockets: FakeTerminalSocket[] = []): (url: string) => FakeTerminalSocket {
  let seq = 0
  return (url) => {
    seq += 1
    const mine = seq
    const socket = new FakeTerminalSocket(url)
    sockets.push(socket)
    socket.onClientSend = (data) => {
      const payload = JSON.parse(data) as { type: string; data?: string }
      if (payload.type === 'input' && payload.data === 'whoami') {
        socket.serverSend({ type: 'output', lines: ['root'] })
        socket.serverSend({ type: 'prompt', prompt: READY_PROMPT, completion: { files: null } })
      }
    }
    queueMicrotask(() => {
      socket.serverOpen()
      socket.serverSend(readyFrame(mine))
    })
    return socket
  }
}

/** 手持全部 socket 引用的工厂：用例需要亲自编排服务端时序（不自动 open/ready）。 */
function heldFactory(): { factory: (url: string) => FakeTerminalSocket; sockets: FakeTerminalSocket[] } {
  const sockets: FakeTerminalSocket[] = []
  return {
    factory: (url) => {
      const socket = new FakeTerminalSocket(url)
      sockets.push(socket)
      return socket
    },
    sockets,
  }
}

runTerminalAdapterContract(() => createTerminalWsAdapter(autoReadyFactory()))

describe('terminalWsAdapter（协议特有行为）', () => {
  it.each(['missing', 'blocked'] as const)('WebSocket %s 时以中文拒绝连接', async failure => {
    vi.stubGlobal('WebSocket', failure === 'missing' ? undefined : class {
      constructor() { throw new DOMException('blocked', 'SecurityError') }
    })
    try {
      const adapter = createTerminalWsAdapter()
      await expect(adapter.connect(collectFrames([]))).rejects.toThrow('浏览器无法建立终端连接')
    } finally { vi.unstubAllGlobals() }
  })

  it('连接同源 /api/terminals/ws；input/interrupt 以白名单帧发出', async () => {
    const sockets: FakeTerminalSocket[] = []
    const adapter = createTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connect(collectFrames([]))
    expect(sockets[0]!.url).toBe('ws://localhost:3000/api/terminals/ws')
    await adapter.sendInput(session.id, 'whoami')
    await adapter.interrupt(session.id)
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'input', data: 'whoami' }),
      JSON.stringify({ type: 'interrupt' }),
    ])
  })

  it('prompt 帧更新提示符与文件词表，complete 用缓存收敛', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const adapter = createTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connect(collectFrames(frames))
    const socket = sockets[0]!

    socket.serverSend({
      type: 'prompt',
      prompt: 'root@elysian-web-1:/tmp$ ',
      completion: { files: ['sysrpm', 'srv'] },
    })
    expect(frames).toContainEqual({ type: 'prompt', prompt: 'root@elysian-web-1:/tmp$ ' })

    // 首词走命令表（ready 帧推送），行中词走文件表（prompt 帧推送）。
    expect(adapter.complete(session.id, 'who', 3)).toEqual({ draft: 'whoami ', cursor: 7 })
    expect(adapter.complete(session.id, 'cat sr', 6)).toEqual({ draft: 'cat srv ', cursor: 8 })

    // files 超限为 null 时行中词退回命令表（协议「补全退回命令表」）。
    socket.serverSend({ type: 'prompt', prompt: 'p$ ', completion: { files: null } })
    expect(adapter.complete(session.id, 'cat sr', 6)).toEqual({ draft: 'cat sr', cursor: 6 })
  })

  it('truncated 与 exit 帧原样转发，关闭事件带关闭码', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const closes: HostTerminalCloseInfo[] = []
    const handlers: HostTerminalHandlers = {
      onFrame: (_id, frame) => {
        frames.push(frame)
      },
      onClose: (_id, info) => {
        closes.push(info)
      },
    }
    const adapter = createTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connect(handlers)
    const socket = sockets[0]!

    socket.serverSend({ type: 'output', lines: ['ok'] })
    socket.serverSend({ type: 'truncated', droppedBytes: 65536 })
    socket.serverSend({ type: 'exit', exitCode: 0 })
    expect(frames).toEqual([
      { type: 'output', lines: ['ok'] },
      { type: 'truncated', droppedBytes: 65536 },
      { type: 'exit', exitCode: 0 },
    ])

    socket.serverClose(1000, '')
    expect(closes).toEqual([{ code: 1000, reason: '' }])
    // 关闭后的会话不再可用。
    await expect(adapter.sendInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
  })

  it('建立前失败（未升级即关）：status 端点的中文原因原样成为错误消息', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: '真实终端仅在 Docker 容器内可用' }), { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const held = heldFactory()
    const adapter = createTerminalWsAdapter(held.factory)
    const pending = adapter.connect(collectFrames([]))
    queueMicrotask(() => held.sockets[0]!.serverClose(1006, ''))
    await expect(pending).rejects.toThrow('真实终端仅在 Docker 容器内可用')
    expect(fetchMock).toHaveBeenCalledWith('/api/terminals/status')
    vi.unstubAllGlobals()
  })

  it('status 端点拿不到原因时用兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })))
    const held = heldFactory()
    const adapter = createTerminalWsAdapter(held.factory)
    const pending = adapter.connect(collectFrames([]))
    queueMicrotask(() => held.sockets[0]!.serverClose(1006, ''))
    await expect(pending).rejects.toThrow('连接本机终端失败')
    vi.unstubAllGlobals()
  })

  it('升级成功但 ready 前被 1008 拒绝（并发上限）：reason 原样成为错误消息', async () => {
    const held = heldFactory()
    const adapter = createTerminalWsAdapter(held.factory)
    const pending = adapter.connect(collectFrames([]))
    queueMicrotask(() => {
      held.sockets[0]!.serverOpen()
      queueMicrotask(() => held.sockets[0]!.serverClose(1008, '并发终端会话已达上限（5）'))
    })
    await expect(pending).rejects.toThrow('并发终端会话已达上限（5）')
  })

  it('disconnect 关闭连接（1000），之后 sendInput/interrupt 抛「终端会话不存在」', async () => {
    const sockets: FakeTerminalSocket[] = []
    const adapter = createTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connect(collectFrames([]))
    await adapter.disconnect(session.id)
    expect(sockets[0]!.readyState).toBe(3)
    await expect(adapter.sendInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
    await expect(adapter.interrupt(session.id)).rejects.toThrow('终端会话不存在')
  })

  it('reset 关闭已连接会话并让进行中的 connect 失败', async () => {
    const held = heldFactory()
    const adapter = createTerminalWsAdapter(held.factory)
    const first = adapter.connect(collectFrames([]))
    queueMicrotask(() => {
      held.sockets[0]!.serverOpen()
      held.sockets[0]!.serverSend(readyFrame(1))
    })
    const session = await first
    const pending = adapter.connect(collectFrames([])) // 第二条：停在 CONNECTING
    adapter.reset()
    expect(held.sockets[0]!.readyState).toBe(3)
    await expect(adapter.sendInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
    await expect(pending).rejects.toThrow('连接本机终端失败')
  })

  it('畸形帧与二进制帧不崩适配器、不产生界面帧', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const adapter = createTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connect(collectFrames(frames))
    const socket = sockets[0]!

    socket.serverRaw('not json')
    socket.serverSend({ type: 'ready' }) // 畸形 ready（缺 session）被忽略，不覆盖已 ready 的会话
    socket.serverSend({ type: 'output', lines: 'nope' }) // lines 非数组
    socket.serverSend({ type: 'pong' }) // 无界面语义
    socket.serverRaw(new ArrayBuffer(4)) // 二进制载荷
    expect(frames).toEqual([])
    // 连接仍在：input 照常可发、应答照常路由。
    await adapter.sendInput(session.id, 'whoami')
    expect(frames).toEqual([
      { type: 'output', lines: ['root'] },
      { type: 'prompt', prompt: READY_PROMPT },
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import type {
  HostTerminalCloseInfo,
  HostTerminalFrame,
  HostTerminalHandlers,
} from '../../contracts/adapters'
import type { TerminalSocket } from './terminalWsAdapter'
import { createContainerTerminalWsAdapter } from './containerTerminalWsAdapter'

/*
 * 容器终端 WS 适配器：注入假 WebSocket 类直驱，不依赖真实网络与 server 片。
 * 断言集与本机版 terminalWsAdapter.test.ts 对齐（同一条协议链路，端点与寻径不同）；
 * 其余用例锚定容器侧特有行为：按 containerId 寻径、status 端点取中文原因（只覆盖
 * 503 形态——200 {ok:true} 无 error 字段落兜底文案，与真实行为一致）、
 * cancelTerminalConnect 先 settle 再关 socket 的结算次序。
 * fixture 用真实帧 JSON 形态（ready/output/prompt/truncated/exit）。
 */

/** never 参数使其能同时充当 open/error/message/close 四种 listener 的实现签名。 */
type FrameListener = (event: never) => void

/** 测试驱动的假浏览器 WebSocket：服务端行为经 server* 方法注入（与本机版同构）。 */
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

const READY_PROMPT = 'root@elysian-e2e-web:~$ '

/** 第 n 条连接的 ready 帧：会话 id 唯一（一连接一会话）。 */
function readyFrame(seq: number): Record<string, unknown> {
  return {
    type: 'ready',
    session: { id: `uuid-${seq}`, user: 'root', hostLabel: 'elysian-e2e-web', prompt: READY_PROMPT },
    completion: { commands: ['whoami', 'hostname', 'ls'] },
  }
}

/**
 * 契约用工厂：连接后自动完成升级与 ready 帧（微任务里派发，等 addEventListener 挂好），
 * 收到 whoami 的 input 帧时回一行输出——断言只锁「有输出」，不锁取值。
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

function collectFrames(frames: HostTerminalFrame[]): HostTerminalHandlers {
  return {
    onFrame: (_sessionId, frame) => {
      frames.push(frame)
    },
    onClose: () => {},
  }
}

describe('containerTerminalWsAdapter', () => {
  it('连接 /api/docker/containers/:id/terminal，containerId 经 encodeURIComponent 寻径', async () => {
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr web/1', collectFrames([]))
    queueMicrotask(() => {
      held.sockets[0]!.serverOpen()
      held.sockets[0]!.serverSend(readyFrame(1))
    })
    const session = await pending
    expect(held.sockets[0]!.url).toBe(
      'ws://localhost:3000/api/docker/containers/ctr%20web%2F1/terminal',
    )
    expect(session).toEqual({
      id: 'uuid-1',
      user: 'root',
      hostLabel: 'elysian-e2e-web',
      prompt: READY_PROMPT,
    })
  })

  it('ready 帧解析会话并缓存命令表；input/interrupt 以白名单帧发出', async () => {
    const sockets: FakeTerminalSocket[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', collectFrames([]))
    await adapter.sendTerminalInput(session.id, 'whoami')
    await adapter.interruptTerminal(session.id)
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'input', data: 'whoami' }),
      JSON.stringify({ type: 'interrupt' }),
    ])
  })

  it('prompt 帧更新提示符与文件词表，completeTerminal 用缓存收敛', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', collectFrames(frames))
    const socket = sockets[0]!

    socket.serverSend({
      type: 'prompt',
      prompt: 'root@elysian-e2e-web:/tmp$ ',
      completion: { files: ['sysrpm', 'srv'] },
    })
    expect(frames).toContainEqual({ type: 'prompt', prompt: 'root@elysian-e2e-web:/tmp$ ' })

    // 首词走命令表（ready 帧推送），行中词走文件表（prompt 帧推送）。
    expect(adapter.completeTerminal(session.id, 'who', 3)).toEqual({ draft: 'whoami ', cursor: 7 })
    expect(adapter.completeTerminal(session.id, 'cat sr', 6)).toEqual({ draft: 'cat srv ', cursor: 8 })

    // files 超限为 null 时行中词退回命令表（协议「补全退回命令表」）。
    socket.serverSend({ type: 'prompt', prompt: 'p$ ', completion: { files: null } })
    expect(adapter.completeTerminal(session.id, 'cat sr', 6)).toEqual({ draft: 'cat sr', cursor: 6 })
  })

  it('output/truncated/exit 帧原样转发，关闭事件带关闭码', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const closes: HostTerminalCloseInfo[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', {
      onFrame: (_id, frame) => {
        frames.push(frame)
      },
      onClose: (_id, info) => {
        closes.push(info)
      },
    })
    const socket = sockets[0]!

    socket.serverSend({ type: 'output', lines: ['total 0'] })
    socket.serverSend({ type: 'truncated', droppedBytes: 65536 })
    socket.serverSend({ type: 'exit', exitCode: 0 })
    expect(frames).toEqual([
      { type: 'output', lines: ['total 0'] },
      { type: 'truncated', droppedBytes: 65536 },
      { type: 'exit', exitCode: 0 },
    ])

    socket.serverClose(1000, '')
    expect(closes).toEqual([{ code: 1000, reason: '' }])
    // 关闭后的会话不再可用。
    await expect(adapter.sendTerminalInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
    await expect(adapter.interruptTerminal(session.id)).rejects.toThrow('终端会话不存在')
  })

  it('disconnectTerminal 关闭连接（1000），之后 sendTerminalInput 抛「终端会话不存在」', async () => {
    const sockets: FakeTerminalSocket[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', collectFrames([]))
    await adapter.disconnectTerminal(session.id)
    expect(sockets[0]!.readyState).toBe(3)
    await expect(adapter.sendTerminalInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
  })

  it('建立前失败（未升级即关）：/api/docker/status 的 503 error 字段原样成为错误消息', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Docker 服务未就绪' }), { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr-web', collectFrames([]))
    queueMicrotask(() => held.sockets[0]!.serverClose(1006, ''))
    await expect(pending).rejects.toThrow('Docker 服务未就绪')
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/status')
    vi.unstubAllGlobals()
  })

  it('status 端点健康（200 {ok:true} 无 error 字段）时用兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr-web', collectFrames([]))
    queueMicrotask(() => held.sockets[0]!.serverClose(1006, ''))
    await expect(pending).rejects.toThrow('连接容器终端失败')
    vi.unstubAllGlobals()
  })

  it('status 端点拿不到 JSON 时用兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })))
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr-web', collectFrames([]))
    queueMicrotask(() => held.sockets[0]!.serverClose(1006, ''))
    await expect(pending).rejects.toThrow('连接容器终端失败')
    vi.unstubAllGlobals()
  })

  it('升级成功但 ready 前被 1008 拒绝（并发上限）：reason 原样成为错误消息', async () => {
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr-web', collectFrames([]))
    queueMicrotask(() => {
      held.sockets[0]!.serverOpen()
      queueMicrotask(() => held.sockets[0]!.serverClose(1008, '并发容器终端会话已达上限（5）'))
    })
    await expect(pending).rejects.toThrow('并发容器终端会话已达上限（5）')
  })

  it('cancelTerminalConnect 先 settle 再关 socket：pending 以兜底文案落定、socket 以 1000 关闭', async () => {
    const held = heldFactory()
    const adapter = createContainerTerminalWsAdapter(held.factory)
    const pending = adapter.connectTerminal('ctr-web', collectFrames([]))
    const socket = held.sockets[0]!
    const closeCodes: number[] = []
    const originalClose = socket.close.bind(socket)
    socket.close = (code?: number) => {
      closeCodes.push(code ?? 1000)
      originalClose(code)
    }

    adapter.cancelTerminalConnect()
    await expect(pending).rejects.toThrow('连接容器终端失败')
    expect(closeCodes).toEqual([1000])
    // 兜底文案即「先 settle」的锚：若次序颠倒（先关 socket），
    // close 派发的关闭事件会把 pending 以关闭码映射的措辞落定，而非连接兜底文案。
  })

  it('cancelTerminalConnect 只作用于未 ready 的 pending，已 ready 会话不受影响', async () => {
    const sockets: FakeTerminalSocket[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', collectFrames([]))
    adapter.cancelTerminalConnect()
    expect(sockets[0]!.readyState).toBe(1)
    await adapter.sendTerminalInput(session.id, 'whoami')
  })

  it('无未决连接时 cancelTerminalConnect 是安全 no-op', () => {
    const adapter = createContainerTerminalWsAdapter(heldFactory().factory)
    expect(() => adapter.cancelTerminalConnect()).not.toThrow()
  })

  it('畸形帧与二进制帧不崩适配器、不产生界面帧', async () => {
    const sockets: FakeTerminalSocket[] = []
    const frames: HostTerminalFrame[] = []
    const adapter = createContainerTerminalWsAdapter(autoReadyFactory(sockets))
    const session = await adapter.connectTerminal('ctr-web', collectFrames(frames))
    const socket = sockets[0]!

    socket.serverRaw('not json')
    socket.serverSend({ type: 'ready' }) // 畸形 ready（缺 session）被忽略，不覆盖已 ready 的会话
    socket.serverSend({ type: 'output', lines: 'nope' }) // lines 非数组
    socket.serverSend({ type: 'pong' }) // 无界面语义
    socket.serverRaw(new ArrayBuffer(4)) // 二进制载荷
    expect(frames).toEqual([])
    // 连接仍在：input 照常可发、应答照常路由。
    await adapter.sendTerminalInput(session.id, 'whoami')
    expect(frames).toEqual([
      { type: 'output', lines: ['root'] },
      { type: 'prompt', prompt: READY_PROMPT },
    ])
  })
})

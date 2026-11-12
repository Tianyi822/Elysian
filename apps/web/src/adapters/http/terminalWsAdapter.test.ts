import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalWsAdapter } from './terminalWsAdapter'
import { TestTerminalSocket } from './terminalTestSocket'
import { captureAuthGeneration, advanceAuthGeneration } from './unauthorized'

let sockets: TestTerminalSocket[]
const make = () => createTerminalWsAdapter(url => { const socket = new TestTerminalSocket(url); sockets.push(socket); return socket })
beforeEach(() => { sockets = [] })
describe('终端协议 v2', () => {
  it('同源协商版本，输入输出保留二进制及控制字节，显式 resize 和消费确认', async () => {
    const adapter = make()
    const onFrame = vi.fn()
    const connecting = adapter.connect({ onFrame, onClose: vi.fn() })
    const socket = sockets[0]!
    expect(socket.url).toContain('/api/terminals/ws?protocol=2')
    expect(socket.binaryType).toBe('arraybuffer')
    socket.ready()
    const session = await connecting
    const bytes = new TextEncoder().encode('中文\x1b[31m\r\n\x03')
    await adapter.sendInput(session.id, bytes)
    expect([...(socket.sent[0] as Uint8Array)]).toEqual([...bytes])
    socket.emit('message', { data: new Uint8Array(bytes).buffer })
    expect(onFrame).toHaveBeenCalledWith(session.id, { type: 'output', data: expect.any(Uint8Array) })
    expect([...onFrame.mock.calls[0]![1].data]).toEqual([...bytes])
    await adapter.resize(session.id, 120, 40)
    adapter.acknowledge(session.id, bytes.length)
    expect(socket.sent.slice(1)).toEqual([JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), JSON.stringify({ type: 'ack', bytes: bytes.length })])
    await adapter.disconnect(session.id)
    await expect(adapter.sendInput(session.id, bytes)).rejects.toThrow('终端会话不存在')
  })
  it('大粘贴按 32KiB 分帧，所有字节保持顺序', async () => {
    const adapter = make()
    const connect = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
    sockets[0]!.ready()
    const session = await connect
    const data = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256)
    await adapter.sendInput(session.id, data)
    const chunks = sockets[0]!.sent as Uint8Array[]
    expect(chunks.map(chunk => chunk.length)).toEqual([32768, 32768, 4464])
    expect(Uint8Array.from(chunks.flatMap(chunk => [...chunk]))).toEqual(data)
    adapter.reset()
  })
  it('取消连接立即结算，迟到 ready 不恢复；退出和关闭只投递到自己的会话', async () => {
    const adapter = make()
    const pending = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
    const rejected = expect(pending).rejects.toThrow('连接本机终端失败')
    adapter.cancelConnect?.()
    await rejected
    sockets[0]!.ready('stale')
    const onFrame = vi.fn(), onClose = vi.fn()
    const next = adapter.connect({ onFrame, onClose })
    sockets[1]!.ready('fresh')
    await next
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'exit', exitCode: 7 }) })
    sockets[1]!.close(4000, '')
    expect(onFrame).toHaveBeenCalledWith('fresh', { type: 'exit', exitCode: 7 })
    expect(onClose).toHaveBeenCalledWith('fresh', { code: 4000, reason: '' })
  })
  it('拒绝旧协议、ready 前数据、超大输出和旧登录代次', async () => {
    const adapter = make()
    const pending = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
    const rejected = expect(pending).rejects.toThrow()
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'ready', session: { id: 'old', user: 'root', hostLabel: 'host' } }) })
    await rejected
    const next = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
    sockets[1]!.ready()
    const session = await next
    const before = captureAuthGeneration()
    advanceAuthGeneration()
    expect(captureAuthGeneration()).toBe(before + 1)
    await expect(adapter.sendInput(session.id, Uint8Array.of(3))).rejects.toThrow('终端会话不存在')
    adapter.reset()
  })
  it('ready 前字节、无效 JSON、超大输出与积压输入均关闭连接', async () => {
    const adapter = make()
    for (const frame of [new Uint8Array([3]).buffer, '[]', '{']) {
      const pending = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
      const socket = sockets.at(-1)!
      const rejected = expect(pending).rejects.toThrow()
      socket.open()
      socket.emit('message', { data: frame })
      await rejected
      expect(socket.closed?.code).toBe(1008)
    }
    const onFrame = vi.fn()
    const connected = adapter.connect({ onFrame, onClose: vi.fn() })
    sockets.at(-1)!.ready('large-output')
    await connected
    sockets.at(-1)!.emit('message', { data: new Uint8Array(32769).buffer })
    expect(onFrame).not.toHaveBeenCalled()
    expect(sockets.at(-1)!.closed?.code).toBe(1008)
    const next = adapter.connect({ onFrame, onClose: vi.fn() })
    const socket = sockets.at(-1)!
    socket.ready('full-input')
    const session = await next
    socket.bufferedAmount = 1024 * 1024
    await expect(adapter.sendInput(session.id, Uint8Array.of(3))).rejects.toThrow('终端输入发送缓冲区已满')
    expect(socket.closed?.code).toBe(1008)
    expect(socket.sent).toEqual([])
  })
  it('升级失败读取已鉴权 status 的中文原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '终端不可用' }), { status: 503 })))
    const adapter = make()
    const pending = adapter.connect({ onFrame: vi.fn(), onClose: vi.fn() })
    const rejected = expect(pending).rejects.toThrow('终端不可用')
    sockets[0]!.close(1006)
    await rejected
    vi.unstubAllGlobals()
  })
})

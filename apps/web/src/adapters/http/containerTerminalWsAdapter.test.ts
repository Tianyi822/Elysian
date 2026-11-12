import { describe, expect, it, vi } from 'vitest'
import { createContainerTerminalWsAdapter } from './containerTerminalWsAdapter'
import { TestTerminalSocket } from './terminalTestSocket'
describe('容器终端协议 v2 接线', () => {
  it('对容器 ID 编码，复用原始字节、resize 与 ack 协议', async () => {
    let socket!: TestTerminalSocket
    const adapter = createContainerTerminalWsAdapter(url => socket = new TestTerminalSocket(url))
    const onFrame = vi.fn()
    const pending = adapter.connectTerminal('container/one', { onFrame, onClose: vi.fn() })
    expect(socket.url).toContain('/containers/container%2Fone/terminal?protocol=2')
    socket.ready()
    const session = await pending
    await adapter.sendTerminalInput(session.id, Uint8Array.of(27, 91, 65))
    await adapter.resizeTerminal(session.id, 80, 24)
    adapter.acknowledgeTerminal(session.id, 3)
    expect(socket.sent).toEqual([Uint8Array.of(27, 91, 65), JSON.stringify({ type: 'resize', cols: 80, rows: 24 }), JSON.stringify({ type: 'ack', bytes: 3 })])
    adapter.reset()
  })
  it('取消 connecting 会话立即拒绝 pending Promise', async () => {
    let socket!: TestTerminalSocket
    const adapter = createContainerTerminalWsAdapter(url => socket = new TestTerminalSocket(url))
    const pending = adapter.connectTerminal('one', { onFrame: vi.fn(), onClose: vi.fn() })
    const rejected = expect(pending).rejects.toThrow('连接容器终端失败')
    adapter.cancelTerminalConnect()
    await rejected
    expect(socket.closed?.code).toBe(1000)
  })
})

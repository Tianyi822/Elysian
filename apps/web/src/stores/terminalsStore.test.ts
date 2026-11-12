import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostTerminalHandlers, TerminalAdapter } from '../contracts/adapters'
import { createMockGateway } from '../adapters/mock/gateway'
import { useTerminalsStore, tabLabel } from './terminalsStore'
import { useSessionStore } from './sessionStore'
const runtime = vi.hoisted(() => ({ configure: vi.fn(), write: vi.fn(), setInteractive: vi.fn() }))
vi.mock('../components/terminal/rawTerminalRuntime', () => ({ rawTerminalRuntime: vi.fn(() => runtime), disposeRawTerminal: vi.fn(), deactivateRawTerminal: vi.fn() }))
beforeEach(() => { useTerminalsStore.getState().resetLocal(); vi.clearAllMocks() })
describe('终端会话元数据', () => {
  it('打开、选择和确认关闭独立会话，最后关闭后保持空态', async () => {
    const gateway = createMockGateway()
    await useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().openSession(gateway)
    const [first, second] = useTerminalsStore.getState().sessions
    expect(first!.id).not.toBe(second!.id)
    expect(tabLabel(first!, [first!, second!])).toContain('1')
    useTerminalsStore.getState().selectSession(first!.id)
    expect(useTerminalsStore.getState().activeId).toBe(first!.id)
    await useTerminalsStore.getState().closeSession(gateway, first!.id)
    await useTerminalsStore.getState().closeSession(gateway, second!.id)
    expect(useTerminalsStore.getState().hasUserDismissed).toBe(true)
  })
  it('字节送入对应运行实例，不在 zustand 保存输出或历史', async () => {
    const base = createMockGateway()
    let handlers!: HostTerminalHandlers
    const terminal: TerminalAdapter = { mode: 'pty', connect: async h => { handlers = h; return { id: 'raw', user: 'root', hostLabel: 'linux' } }, sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), acknowledge: vi.fn(), disconnect: vi.fn(async () => {}) }
    await useTerminalsStore.getState().openSession({ ...base, terminals: terminal })
    const bytes = Uint8Array.of(27, 91, 72)
    handlers.onFrame('raw', { type: 'output', data: bytes })
    expect(runtime.write).toHaveBeenCalledWith(bytes)
    expect(useTerminalsStore.getState().sessions[0]).not.toHaveProperty('lines')
    expect(useTerminalsStore.getState().sessions[0]).not.toHaveProperty('history')
    handlers.onFrame('raw', { type: 'exit', exitCode: 0 })
    expect(useTerminalsStore.getState().sessions[0]).toMatchObject({ status: 'error', errorMessage: '会话已退出（退出码 0）' })
  })
  it('取消 connecting 后迟到 ready 不会复活已关闭会话', async () => {
    const base = createMockGateway()
    let ready!: (info: { id: string; user: string; hostLabel: string }) => void
    const disconnect = vi.fn(async () => {})
    const gateway = { ...base, terminals: { ...base.terminals, mode: 'pty' as const, connect: () => new Promise<{ id: string; user: string; hostLabel: string }>(resolve => { ready = resolve }), disconnect, sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), acknowledge: vi.fn() } }
    const opening = useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().closeSession(gateway, useTerminalsStore.getState().activeId!)
    ready({ id: 'stale', user: 'root', hostLabel: 'linux' })
    await opening
    expect(useTerminalsStore.getState().sessions).toEqual([])
    expect(disconnect).toHaveBeenCalledWith('stale')
  })
  it('关闭旧标签不解除新连接的互斥，取消后的旧 rejection 不污染下一条连接', async () => {
    const base = createMockGateway()
    type Info = { id: string; user: string; hostLabel: string }
    let rejectOld!: (error: Error) => void
    let ready!: (info: Info) => void
    const connect = vi.fn<(_: HostTerminalHandlers) => Promise<Info>>()
      .mockResolvedValueOnce({ id: 'first', user: 'root', hostLabel: 'linux' })
      .mockImplementationOnce(() => new Promise<Info>((_resolve, reject) => { rejectOld = reject }))
      .mockImplementationOnce(() => new Promise<Info>(resolve => { ready = resolve }))
    const gateway = { ...base, terminals: { ...base.terminals, connect, cancelConnect: vi.fn(), disconnect: vi.fn(async () => {}) } }
    await useTerminalsStore.getState().openSession(gateway)
    const old = useTerminalsStore.getState().openSession(gateway)
    const oldPendingId = useTerminalsStore.getState().activeId!
    await useTerminalsStore.getState().closeSession(gateway, 'first')
    expect(useTerminalsStore.getState().opening).toBe(true)
    await useTerminalsStore.getState().openSession(gateway)
    expect(connect).toHaveBeenCalledTimes(2)
    await useTerminalsStore.getState().closeSession(gateway, oldPendingId)
    const next = useTerminalsStore.getState().openSession(gateway)
    rejectOld(new Error('迟到的旧连接错误'))
    await old
    expect(useTerminalsStore.getState().opening).toBe(true)
    expect(useTerminalsStore.getState().sessions[0]?.status).toBe('connecting')
    ready({ id: 'fresh', user: 'root', hostLabel: 'linux' })
    await next
    expect(useTerminalsStore.getState().sessions).toMatchObject([{ id: 'fresh', status: 'connected' }])
  })
  it('ready Promise 结算前收到的输出和断开按同一会话顺序应用', async () => {
    const base = createMockGateway()
    const bytes = Uint8Array.of(27, 91, 72)
    const terminal: TerminalAdapter = { mode: 'pty', connect: async handlers => {
      handlers.onFrame('early', { type: 'output', data: bytes })
      handlers.onClose('early', { code: 4000, reason: '' })
      return { id: 'early', user: 'root', hostLabel: 'linux' }
    }, sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), acknowledge: vi.fn(), disconnect: vi.fn(async () => {}) }
    await useTerminalsStore.getState().openSession({ ...base, terminals: terminal })
    expect(runtime.configure).toHaveBeenCalledOnce()
    expect(runtime.write).toHaveBeenCalledWith(bytes)
    expect(useTerminalsStore.getState().sessions[0]).toMatchObject({ id: 'early', status: 'error', errorMessage: '终端会话空闲超时，已断开' })
  })
  it('登出清理客户端所有会话', async () => {
    useSessionStore.setState({ phase: 'authed' })
    const gateway = createMockGateway()
    await useTerminalsStore.getState().openSession(gateway)
    await useSessionStore.getState().logout(gateway)
    expect(useTerminalsStore.getState().sessions).toEqual([])
  })
})

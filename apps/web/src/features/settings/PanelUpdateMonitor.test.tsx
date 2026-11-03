import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelInfo, PanelTask } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { PanelNetworkError } from '../../adapters/http/panelHttpAdapter'
import { usePanelStore } from '../../stores/panelStore'
import { useSessionStore } from '../../stores/sessionStore'
import { renderApp } from '../../test/renderApp'
import { PanelUpdateMonitor } from './PanelUpdateMonitor'
import { PANEL_PENDING_KEY, savePanelPending } from './panelPending'
import { readPanelReload, savePanelReload } from './panelReload'
import { reloadPanelPage } from './panelNavigation'

vi.mock('./panelNavigation', () => ({ openPanelAddress: vi.fn(), reloadPanelPage: vi.fn() }))
const ports = { frontendPort: 48100, backendPort: 48101 }
const info: PanelInfo = { ports, commit: 'a'.repeat(40), buildTime: '', repository: '', available: true, reason: '', activeTask: null, lastTask: null }
const task: PanelTask = { id: 'update-global', kind: 'update', state: 'running', phase: 'checking', oldPorts: ports, newPorts: ports, targetCommit: 'b'.repeat(40), createdAt: '', updatedAt: '', error: '' }
const finished: PanelTask = { ...task, state: 'succeeded', phase: 'finished' }
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function gateway(initial: PanelTask | null = null) {
  const g = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
  g.panel.info = vi.fn(async () => ({ ...info, activeTask: initial?.state === 'running' ? initial : null, lastTask: initial?.state === 'succeeded' ? initial : null }))
  g.panel.task = vi.fn(async () => ({ task: initial ?? task, logs: '', nextOffset: 0 }))
  g.panel.update = vi.fn(); g.panel.restart = vi.fn(); g.panel.ports = vi.fn()
  return g
}
function mount(g: ReturnType<typeof gateway>) { return render(<GatewayProvider gateway={g}><PanelUpdateMonitor /></GatewayProvider>) }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); vi.clearAllMocks()
  usePanelStore.getState().clearDisplay(); sessionStorage.removeItem(PANEL_PENDING_KEY)
  useSessionStore.setState({ phase: 'authed' })
  vi.stubEnv('ELYSIAN_BUILD_COMMIT', '')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, commit: task.targetCommit }))))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('常驻维护监控', () => {
  it.each(['CLI', '其他标签页'])('空闲每 15 秒发现 %s 的更新，后台仍启动倒计时', async () => {
    const g = gateway()
    mount(g); await advance(0)
    expect(g.panel.info).toHaveBeenCalledTimes(1)
    g.panel.info = vi.fn(async () => ({ ...info, lastTask: finished }))
    g.panel.task = vi.fn(async () => ({ task: finished, logs: '', nextOffset: 0 }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await advance(14_999)
    expect(g.panel.info).not.toHaveBeenCalled()
    await advance(1)
    expect(g.panel.info).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
    expect(g.panel.update).not.toHaveBeenCalled()
    await advance(30_000)
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  it('活动任务每两秒回读；CLI 注册失败不阻止倒计时', async () => {
    const g = gateway(task)
    mount(g); await advance(0)
    const reads = vi.mocked(g.panel.task).mock.calls.length
    await advance(1999)
    expect(g.panel.task).toHaveBeenCalledTimes(reads)
    g.panel.task = vi.fn(async () => ({ task: { ...finished, cliRegistration: { status: 'failed' as const, error: '外部命令占用' } }, logs: '', nextOffset: 0 }))
    await advance(1)
    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
    expect(usePanelStore.getState().task?.cliRegistration?.error).toBe('外部命令占用')
  })
  it('未确认提交按精确编号回读，不重新派发；离开设置页也可完成', async () => {
    const g = gateway()
    const pending = { version: 1 as const, kind: 'update' as const, requestId: 'original-request', input: { source: 'github' as const, channel: 'commit' as const, targetCommit: task.targetCommit, releaseTag: '' } }
    savePanelPending(pending)
    g.panel.taskByRequest = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(finished)
    g.panel.task = vi.fn(async () => ({ task: finished, logs: '', nextOffset: 0 }))
    mount(g); await advance(0)
    expect(g.panel.taskByRequest).toHaveBeenCalledWith(pending.requestId, expect.any(AbortSignal))
    await advance(2000)
    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
    expect(g.panel.update).not.toHaveBeenCalled()
    expect(g.panel.restart).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PANEL_PENDING_KEY)).toBeNull()
  })
  it.each(['unknown', 'current'] as const)('历史成功任务不反复弹窗：前端构建 %s', async (build) => {
    if (build === 'current') vi.stubEnv('ELYSIAN_BUILD_COMMIT', task.targetCommit)
    const g = gateway(finished)
    mount(g); await advance(30_000)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(reloadPanelPage).not.toHaveBeenCalled()
  })
  it('旧构建加载到外部已完成的新版时，仍核对实际提交', async () => {
    vi.stubEnv('ELYSIAN_BUILD_COMMIT', info.commit)
    mount(gateway(finished)); await advance(0)
    expect(fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
  })
  it('版本不一致保留错误和手动入口状态；五秒后重新核对', async () => {
    const g = gateway(task)
    g.panel.task = vi.fn(async () => ({ task: finished, logs: '', nextOffset: 0 }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, commit: info.commit })))
    mount(g); await advance(0)
    expect(usePanelStore.getState().verificationError).toContain('与目标提交不一致')
    expect(usePanelStore.getState().needsManualReload).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await advance(5000)
    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
    expect(usePanelStore.getState().verificationError).toBeNull()
  })
  it('恢复已有截止时间，不再等待 30 秒；已执行任务不会重载两次', async () => {
    savePanelReload({ version: 1, taskId: task.id, targetCommit: task.targetCommit, deadline: Date.now() + 7000, executed: false })
    const g = gateway(finished)
    const first = mount(g); await advance(0)
    expect(screen.getByText('7')).toBeInTheDocument()
    await advance(7000)
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    expect(readPanelReload()?.executed).toBe(true)
    first.unmount()
    usePanelStore.setState({ reload: null, verifiedUpdate: null })
    mount(g); await advance(30_000)
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('身份失效中止读取，迟到信息不恢复任务或倒计时', async () => {
    const g = gateway(); let resolve!: (value: PanelInfo) => void
    g.panel.info = vi.fn(() => new Promise<PanelInfo>(done => { resolve = done }))
    mount(g); await advance(0)
    const signal = vi.mocked(g.panel.info).mock.calls[0]![0]!
    act(() => useSessionStore.getState().expire())
    expect(signal.aborted).toBe(true)
    await act(async () => resolve({ ...info, lastTask: finished }))
    expect(usePanelStore.getState().task).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await advance(60_000)
    expect(g.panel.info).toHaveBeenCalledTimes(1)
  })
  it('积压日志读取断连时仍按两秒重试，避免零延时请求循环', async () => {
    const g = gateway(task)
    g.panel.task = vi.fn().mockResolvedValueOnce({ task, logs: '第一页', nextOffset: 9, hasMore: true }).mockRejectedValue(new PanelNetworkError('连接中断'))
    mount(g); await advance(10_000)
    expect(vi.mocked(g.panel.task).mock.calls.length).toBeLessThan(10)
    expect(usePanelStore.getState().logs).toBe('第一页')
    expect(reloadPanelPage).not.toHaveBeenCalled()
  })
})

it('设置页提交后进入 Agent，再进入文件页，监控及截止时间持续保留', async () => {
  vi.useRealTimers()
  const g = gateway()
  g.panel.update = vi.fn(async () => task)
  g.panel.checkUpdate = vi.fn(async () => ({ channel: 'commit' as const, source: 'github' as const, releaseTag: '', branch: 'main', repository: '', currentCommit: info.commit, targetCommit: task.targetCommit, available: true, message: '' }))
  const view = renderApp('/settings?tab=maintenance', { gateway: g })
  const { default: userEvent } = await import('@testing-library/user-event')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '检查更新' }))
  await user.click(screen.getByRole('button', { name: '更新并重启' }))
  await act(async () => { await view.router.navigate('/agent') })
  g.panel.task = vi.fn(async () => ({ task: finished, logs: '', nextOffset: 0 }))
  expect(await screen.findByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
  const deadline = readPanelReload()!.deadline
  await act(async () => { await view.router.navigate('/files') })
  expect(readPanelReload()!.deadline).toBe(deadline)
  expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '立刻重启' }))
  expect(reloadPanelPage).toHaveBeenCalledTimes(1)
})

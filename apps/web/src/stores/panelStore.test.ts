import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelInfo, PanelTask, PanelTaskReport } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { advanceAuthGeneration } from '../utils/authGeneration'
import { usePanelStore } from './panelStore'

const ports = { frontendPort: 48100, backendPort: 48101 }
const task: PanelTask = { id: 'a'.repeat(32), kind: 'restart', state: 'running', phase: 'checking', createdAt: '', updatedAt: '', oldPorts: ports, newPorts: ports, targetCommit: '', error: '' }
const info: PanelInfo = { ports, commit: '', buildTime: '', available: true, reason: '', repository: '', activeTask: null, lastTask: null }
beforeEach(() => usePanelStore.getState().clearDisplay())
describe('面板配置读取', () => {
  it('首读失败和刷新失败分别处理，重试成功清除读取错误', async () => {
    const g = createMockGateway()
    let resolve!: (value: PanelInfo) => void
    g.panel.info = vi.fn()
      .mockRejectedValueOnce(new Error('首读失败'))
      .mockResolvedValueOnce(info)
      .mockRejectedValueOnce(new Error('刷新失败'))
      .mockImplementationOnce(() => new Promise<PanelInfo>((done) => { resolve = done }))
    const state = usePanelStore.getState
    await state().load(g)
    expect(state()).toMatchObject({ status: 'error', info: null, errorMessage: '首读失败' })
    await state().load(g)
    await state().load(g)
    expect(state()).toMatchObject({ status: 'ready', info, errorMessage: '刷新失败' })
    const reading = state().load(g)
    expect(state().info).toBe(info)
    expect(state().status).toBe('ready')
    resolve({ ...info, commit: 'updated' })
    await reading
    expect(state().info?.commit).toBe('updated')
    expect(state().errorMessage).toBeUndefined()
  })

  it('维护任务接收和日志轮询成功不能清除配置读取错误', async () => {
    const g = createMockGateway()
    g.panel.info = vi.fn().mockRejectedValue(new Error('读取配置失败'))
    g.panel.task = vi.fn().mockResolvedValue({ task, logs: '维护中', nextOffset: 9 })
    const state = usePanelStore.getState
    await state().load(g)
    state().put(task)
    await state().poll(g)
    expect(state()).toMatchObject({ status: 'error', errorMessage: '读取配置失败', task, logs: '维护中' })
  })

  it('取消首读后不写入错误，也不保留加载态', async () => {
    const g = createMockGateway()
    const abort = new AbortController()
    const read = vi.spyOn(g.panel, 'info').mockImplementation((signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const reading = usePanelStore.getState().load(g, { signal: abort.signal })
    expect(read).toHaveBeenCalledWith(abort.signal)
    abort.abort()
    await reading
    expect(usePanelStore.getState()).toMatchObject({ status: 'idle', info: null, errorMessage: undefined })
  })
})

describe('维护展示生命周期', () => {
  it('合并同一任务的并发日志读取，只推进一次', async () => {
    const g = createMockGateway(); let resolve!: (value: PanelTaskReport) => void
    g.panel.task = vi.fn(() => new Promise<PanelTaskReport>((done) => { resolve = done }))
    usePanelStore.getState().put(task)
    const first = usePanelStore.getState().poll(g), second = usePanelStore.getState().poll(g)
    expect(g.panel.task).toHaveBeenCalledTimes(1)
    const report = { task: { ...task, state: 'succeeded' as const }, logs: '完成', nextOffset: 6 }
    resolve(report)
    expect(await first).toEqual(report); expect(await second).toEqual(report)
    expect(usePanelStore.getState()).toMatchObject({ logs: '完成', offset: 6, task: report.task })
  })
  it.each(['clear', 'auth', 'replace'] as const)('%s 后旧读取不回灌也不返回可执行终态', async (change) => {
    const g = createMockGateway(); let resolve!: (value: PanelTaskReport) => void
    g.panel.task = () => new Promise((done) => { resolve = done })
    usePanelStore.getState().put(task)
    const pending = usePanelStore.getState().poll(g)
    if (change === 'clear') usePanelStore.getState().clearDisplay()
    if (change === 'auth') advanceAuthGeneration()
    if (change === 'replace') usePanelStore.getState().put({ ...task, id: 'b'.repeat(32) })
    resolve({ task: { ...task, state: 'succeeded' }, logs: '旧日志', nextOffset: 9 })
    expect(await pending).toBeNull()
    expect(usePanelStore.getState().logs).toBe('')
  })
  it('迟到的配置读取不覆盖新接受任务', async () => {
    const g = createMockGateway(); let resolve!: (value: PanelInfo) => void
    g.panel.info = () => new Promise((done) => { resolve = done })
    const reading = usePanelStore.getState().load(g)
    expect(usePanelStore.getState().status).toBe('loading')
    usePanelStore.getState().put(task)
    resolve(info)
    await reading
    expect(usePanelStore.getState()).toMatchObject({ task, info: null, status: 'idle' })
  })
  it('信息回读及重新进入设置页均保留全局任务追踪', async () => {
    const g = createMockGateway(); const finished = { ...task, state: 'succeeded' as const }
    g.panel.info = vi.fn().mockResolvedValueOnce(info).mockResolvedValue({ ...info, lastTask: finished })
    g.panel.task = async () => ({ task: finished, logs: '', nextOffset: 0 })
    usePanelStore.getState().put(finished)
    await usePanelStore.getState().load(g, { preserveTask: true })
    expect(usePanelStore.getState().trackedTaskId).toBe(task.id)
    await usePanelStore.getState().load(g)
    expect(usePanelStore.getState().trackedTaskId).toBe(task.id)
  })
})

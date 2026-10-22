import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelTask, PanelTaskReport } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'
import { usePanelStore } from './panelStore'

const ports = { frontendPort: 48100, backendPort: 48101 }
const task: PanelTask = { id: 'a'.repeat(32), kind: 'restart', state: 'running', phase: 'checking', createdAt: '', updatedAt: '', oldPorts: ports, newPorts: ports, targetCommit: '', error: '' }
beforeEach(() => usePanelStore.getState().clearDisplay())
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
    const g = createMockGateway(); let resolve!: (value: Awaited<ReturnType<typeof g.panel.info>>) => void
    g.panel.info = () => new Promise((done) => { resolve = done })
    const reading = usePanelStore.getState().load(g)
    usePanelStore.getState().put(task)
    resolve({ ports, commit: '', buildTime: '', available: true, reason: '', repository: '', activeTask: null, lastTask: null })
    await reading
    expect(usePanelStore.getState().task).toEqual(task)
  })
  it('重新进入设置页清除历史终态追踪，收尾刷新可保留当前追踪', async () => {
    const g = createMockGateway(); const finished = { ...task, state: 'succeeded' as const }
    g.panel.info = async () => ({ ports, commit: '', buildTime: '', available: true, reason: '', repository: '', activeTask: null, lastTask: finished })
    g.panel.task = async () => ({ task: finished, logs: '', nextOffset: 0 })
    usePanelStore.getState().put(finished)
    await usePanelStore.getState().load(g, true)
    expect(usePanelStore.getState().trackedTaskId).toBe(task.id)
    await usePanelStore.getState().load(g)
    expect(usePanelStore.getState().trackedTaskId).toBeNull()
  })
})

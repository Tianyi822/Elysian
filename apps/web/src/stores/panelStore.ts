import { create } from 'zustand'
import { panelTaskIsActive } from '@elysian/contracts'
import type { PanelInfo, PanelTask, PanelTaskReport } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { savePanelPending, type PanelPending } from '../features/settings/panelPending'
import { frontendCommit, PANEL_RELOAD_DELAY_MS, readPanelReload, savePanelReload, type PanelReload } from '../features/settings/panelReload'

type PanelState = {
  info: PanelInfo | null; task: PanelTask | null; logs: string; offset: number; hasMore: boolean; error: string | null
  trackedTaskId: string | null
  pending: PanelPending | null
  progressError: string | null
  connectionError: string | null
  verificationError: string | null
  needsManualReload: boolean
  verifiedUpdate: string | null
  reload: PanelReload | null
  put(task: PanelTask): void
  setPending(value: PanelPending | null): void
  acceptPending(task: PanelTask, requestId: string): boolean
  requestReload(task: PanelTask, now?: number): void
  consumeReload(taskId: string, auth: number): boolean
  load(gateway: ElysianGateway, preserveTask?: boolean, signal?: AbortSignal): Promise<void>
  poll(gateway: ElysianGateway, signal?: AbortSignal): Promise<PanelTaskReport | null>
  clearDisplay(): void
}
let epoch = 0, readVersion = 0
let owner: ElysianGateway | undefined
let polling: { gateway: ElysianGateway; id: string; revision: number; auth: number; signal?: AbortSignal; promise: Promise<PanelTaskReport | null> } | undefined
const monitorBlank = { pending: null, progressError: null, connectionError: null, verificationError: null, needsManualReload: false, verifiedUpdate: null, reload: null }
export const usePanelStore = create<PanelState>((set, get) => ({
  info: null, task: null, logs: '', offset: 0, hasMore: false, error: null, trackedTaskId: null, ...monitorBlank,
  clearDisplay() {
    epoch++; readVersion++; owner = undefined; polling = undefined
    savePanelReload(null)
    set({ info: null, task: null, logs: '', offset: 0, hasMore: false, error: null, trackedTaskId: null, ...monitorBlank })
  },
  put(task) {
    epoch++
    const changed = task.id !== get().task?.id
    set({ task, trackedTaskId: task.id, error: null, progressError: null, connectionError: null,
      ...(changed ? { logs: '', offset: 0, hasMore: false, verificationError: null, needsManualReload: false, verifiedUpdate: null } : {}) })
  },
  setPending(pending) { savePanelPending(pending); set({ pending }) },
  acceptPending(task, requestId) {
    if (get().pending?.requestId !== requestId) return false
    get().setPending(null)
    get().put(task)
    return true
  },
  requestReload(task, now = Date.now()) {
    set({ verifiedUpdate: task.id, verificationError: null, needsManualReload: false })
    if (frontendCommit() === task.targetCommit) { set({ reload: null }); return }
    const previous = get().reload ?? readPanelReload()
    if (previous?.taskId === task.id && previous.targetCommit === task.targetCommit) {
      if (!previous.executed) set({ reload: previous })
      return
    }
    const reload: PanelReload = { version: 1, taskId: task.id, targetCommit: task.targetCommit, deadline: now + PANEL_RELOAD_DELAY_MS, executed: false }
    savePanelReload(reload)
    set({ reload })
  },
  consumeReload(taskId, auth) {
    const reload = get().reload
    if (!reload || reload.taskId !== taskId || reload.executed || auth !== captureAuthGeneration()) return false
    const executed = { ...reload, executed: true }
    savePanelReload(executed)
    set({ reload: executed })
    return true
  },
  async load(gateway, preserveTask = false, signal) {
    if (owner && owner !== gateway) get().clearDisplay()
    owner = gateway
    const version = ++readVersion, revision = epoch, auth = captureAuthGeneration()
    const current = () => version === readVersion && revision === epoch && auth === captureAuthGeneration() && owner === gateway && !signal?.aborted
    try {
      const info = await gateway.panel.info(signal)
      if (!current()) return
      const previous = get().info
      const task = preserveTask && get().task ? get().task : info.activeTask ?? info.lastTask
      const previousId = (previous?.activeTask ?? previous?.lastTask)?.id
      const tracked = task && (panelTaskIsActive(task) || task.id === get().trackedTaskId || (previous !== null && task.id !== previousId))
      set({ info, task, error: null, trackedTaskId: tracked ? task.id : null,
        ...(task?.id !== get().task?.id ? { logs: '', offset: 0, hasMore: false, verifiedUpdate: null, verificationError: null, needsManualReload: false } : {}) })
      if (task) { try { await get().poll(gateway, signal) } catch { /* 全局监控继续恢复任务连接。 */ } }
    } catch (cause) { if (current()) set({ error: cause instanceof Error ? cause.message : '面板信息加载失败' }) }
  },
  async poll(gateway, signal) {
    const task = get().task; if (!task) return null
    const revision = epoch, auth = captureAuthGeneration(), offset = get().offset
    if (polling?.gateway === gateway && polling.id === task.id && polling.revision === revision && polling.auth === auth && !polling.signal?.aborted) return polling.promise
    const promise = (async () => {
      const report = await gateway.panel.task(task.id, offset, signal)
      if (signal?.aborted || revision !== epoch || auth !== captureAuthGeneration() || (owner && owner !== gateway) || get().task?.id !== task.id || get().offset !== offset) return null
      set({ task: report.task, logs: (get().logs + report.logs).slice(-128000), offset: report.nextOffset, hasMore: report.hasMore === true, error: null })
      return report
    })()
    polling = { gateway, id: task.id, revision, auth, signal, promise }
    try { return await promise } finally { if (polling?.promise === promise) polling = undefined }
  },
}))

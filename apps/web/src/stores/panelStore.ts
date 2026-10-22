import { create } from 'zustand'
import { panelTaskIsActive } from '@elysian/contracts'
import type { PanelInfo, PanelTask, PanelTaskReport } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { captureAuthGeneration } from '../adapters/http/unauthorized'

type PanelState = {
  info: PanelInfo | null; task: PanelTask | null; logs: string; offset: number; hasMore: boolean; error: string | null
  put(task: PanelTask): void
  trackedTaskId: string | null
  load(gateway: ElysianGateway, preserveTask?: boolean): Promise<void>
  poll(gateway: ElysianGateway): Promise<PanelTaskReport | null>
  clearDisplay(): void
}
let epoch = 0, readVersion = 0
let owner: ElysianGateway | undefined
let polling: { gateway: ElysianGateway; id: string; revision: number; auth: number; promise: Promise<PanelTaskReport | null> } | undefined
export const usePanelStore = create<PanelState>((set, get) => ({
  info: null, task: null, logs: '', offset: 0, hasMore: false, error: null, trackedTaskId: null,
  clearDisplay() { epoch++; readVersion++; owner = undefined; set({ info: null, task: null, logs: '', offset: 0, hasMore: false, error: null, trackedTaskId: null }) },
  put(task) { epoch++; set({ task, trackedTaskId: task.id, logs: '', offset: 0, hasMore: false, error: null }) },
  async load(gateway, preserveTask = false) {
    if (owner && owner !== gateway) get().clearDisplay()
    owner = gateway
    if (!preserveTask) {
      const selected = get().task
      set({ trackedTaskId: selected && panelTaskIsActive(selected) ? selected.id : null })
    }
    const version = ++readVersion, revision = epoch, auth = captureAuthGeneration()
    const current = () => version === readVersion && revision === epoch && auth === captureAuthGeneration() && owner === gateway
    try {
      const info = await gateway.panel.info()
      if (!current()) return
      const task = preserveTask && get().task ? get().task : info.activeTask ?? info.lastTask
      set({ info, task, error: null, trackedTaskId: task && panelTaskIsActive(task) ? task.id : get().trackedTaskId,
        ...(task?.id !== get().task?.id ? { logs: '', offset: 0, hasMore: false } : {}) })
      if (task) { try { await get().poll(gateway) } catch { /* 配置已读到；任务连接在轮询中继续恢复。 */ } }
    } catch (cause) { if (current()) set({ error: cause instanceof Error ? cause.message : '面板信息加载失败' }) }
  },
  async poll(gateway) {
    const task = get().task; if (!task) return null
    const revision = epoch, auth = captureAuthGeneration(), offset = get().offset
    if (polling?.gateway === gateway && polling.id === task.id && polling.revision === revision && polling.auth === auth) return polling.promise
    const promise = (async () => {
      const report = await gateway.panel.task(task.id, offset)
      if (revision !== epoch || auth !== captureAuthGeneration() || (owner && owner !== gateway) || get().task?.id !== task.id || get().offset !== offset) return null
      set({ task: report.task, logs: (get().logs + report.logs).slice(-128000), offset: report.nextOffset, hasMore: report.hasMore === true, error: null })
      return report
    })()
    polling = { gateway, id: task.id, revision, auth, promise }
    try { return await promise } finally { if (polling?.promise === promise) polling = undefined }
  },
}))

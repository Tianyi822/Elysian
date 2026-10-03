import { create } from 'zustand'
import type { PanelInfo, PanelTask, PanelTaskReport } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

type PanelState = {
  info: PanelInfo | null; task: PanelTask | null; logs: string; offset: number; hasMore: boolean; error: string | null
  put(task: PanelTask): void
  load(gateway: ElysianGateway): Promise<void>
  poll(gateway: ElysianGateway): Promise<PanelTaskReport | null>
}
export const usePanelStore = create<PanelState>((set, get) => ({
  info: null, task: null, logs: '', offset: 0, hasMore: false, error: null,
  put(task) { set({ task, logs: '', offset: 0, hasMore: false, error: null }) },
  async load(gateway) {
    try {
      const info = await gateway.panel.info()
      const task = info.activeTask ?? info.lastTask
      set({ info, task, error: null, ...(task?.id !== get().task?.id ? { logs: '', offset: 0 } : {}) })
      if (task) { try { await get().poll(gateway) } catch { /* 配置已读到；任务连接在轮询中继续恢复。 */ } }
    } catch (cause) { set({ error: cause instanceof Error ? cause.message : '面板信息加载失败' }) }
  },
  async poll(gateway) {
    const task = get().task; if (!task) return null
    const report = await gateway.panel.task(task.id, get().offset)
    if (get().task?.id === task.id) set({ task: report.task, logs: (get().logs + report.logs).slice(-128000), offset: report.nextOffset, hasMore: report.hasMore === true })
    return report
  },
}))

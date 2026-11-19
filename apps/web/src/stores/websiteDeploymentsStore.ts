import { create } from 'zustand'
import { websiteDeploymentIsActive } from '@elysian/contracts'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { messageOf } from '../utils/errorMessage'
import { createRequestGuard } from './requestGuard'

function notifyTransition(previous: WebsiteDeploymentTask | undefined, task: WebsiteDeploymentTask) {
  if (!previous || (!websiteDeploymentIsActive(previous.state) && previous.state !== 'awaiting-config') || previous.state === task.state || websiteDeploymentIsActive(task.state)) return
  const tone = task.state === 'succeeded' ? 'success' : task.state === 'failed' ? 'danger' : task.state === 'cancelled' ? 'info' : 'warning'
  const result = task.state === 'succeeded' ? '部署已完成' : task.state === 'failed' ? '部署失败' : task.state === 'cancelled' ? '部署已取消' : task.state === 'awaiting-config' ? '部署需要补充配置' : '部署已中断'
  useMessageStore.getState().notify({ tone, message: `项目 ${task.name}：${result}${task.error ? `，${task.error}` : ''}` })
}

type DeploymentState = {
  tasks: readonly WebsiteDeploymentTask[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage?: string
  clearDisplay(): void
  load(gateway: ElysianGateway): Promise<void>
  put(task: WebsiteDeploymentTask): void
}

const initialDisplay = { tasks: [], status: 'idle', errorMessage: undefined } as const
const reads = createRequestGuard()

export const useWebsiteDeploymentsStore = create<DeploymentState>((set, get) => ({
  ...initialDisplay,
  clearDisplay() {
    reads.invalidate()
    set(initialDisplay)
  },
  put(task) {
    notifyTransition(get().tasks.find((row) => row.id === task.id), task)
    set((s) => ({ tasks: [task, ...s.tasks.filter((row) => row.id !== task.id)] }))
  },
  async load(gateway) {
    const api = gateway.websites.deployment
    if (get().status === 'loading' || !api) return
    const current = reads.capture()
    set({ status: 'loading' })
    try {
      const rows = await api.list()
      if (!current()) return
      const active = rows.filter((row) => websiteDeploymentIsActive(row.state))
      const updates = await Promise.all(active.map((row) => api.task(row.id)))
      if (!current()) return
      const byId = new Map(updates.map((row) => [row.id, row]))
      const tasks = rows.map((row) => byId.get(row.id) ?? row).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      for (const task of tasks) notifyTransition(get().tasks.find((row) => row.id === task.id), task)
      set({ tasks, status: 'ready', errorMessage: undefined })
    } catch (error) {
      if (current()) set({ status: 'error', errorMessage: messageOf(error, '部署任务加载失败') })
    }
  },
}))

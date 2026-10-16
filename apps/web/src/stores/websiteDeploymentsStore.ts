import { create } from 'zustand'
import { websiteDeploymentIsActive } from '@elysian/contracts'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

function notifyTransition(previous: WebsiteDeploymentTask | undefined, task: WebsiteDeploymentTask) {
  if (!previous || (!websiteDeploymentIsActive(previous.state) && previous.state !== 'awaiting-config') || previous.state === task.state || websiteDeploymentIsActive(task.state)) return
  const tone = task.state === 'succeeded' ? 'success' : task.state === 'failed' ? 'danger' : task.state === 'cancelled' ? 'info' : 'warning'
  const result = task.state === 'succeeded' ? '部署已完成' : task.state === 'failed' ? '部署失败' : task.state === 'cancelled' ? '部署已取消' : task.state === 'awaiting-config' ? '部署需要补充配置' : '部署已中断'
  useNotificationStore.getState().notify({ tone, message: `项目 ${task.name}：${result}${task.error ? `，${task.error}` : ''}` })
}

type DeploymentState = {
  tasks: readonly WebsiteDeploymentTask[]; loading: boolean; error?: string
  refresh(gateway: ElysianGateway): Promise<void>
  put(task: WebsiteDeploymentTask): void
}
export const useWebsiteDeploymentsStore = create<DeploymentState>((set, get) => ({
  tasks: [], loading: false,
  put(task) {
    notifyTransition(get().tasks.find((row) => row.id === task.id), task)
    set((s) => ({ tasks: [task, ...s.tasks.filter((row) => row.id !== task.id)] }))
  },
  async refresh(gateway) {
    if (get().loading || !gateway.websites.deployment) return
    set({ loading: true })
    try {
      const rows = await gateway.websites.deployment.list()
      const active = rows.filter((row) => websiteDeploymentIsActive(row.state))
      const updates = await Promise.all(active.map((row) => gateway.websites.deployment!.task(row.id)))
      const byId = new Map(updates.map((row) => [row.id, row]))
      const tasks = rows.map((row) => byId.get(row.id) ?? row).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      for (const task of tasks) notifyTransition(get().tasks.find((row) => row.id === task.id), task)
      set({ tasks, loading: false, error: undefined })
    } catch (error) { set({ loading: false, error: error instanceof Error ? error.message : '部署任务加载失败' }) }
  },
}))

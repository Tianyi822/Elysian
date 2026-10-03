import { create } from 'zustand'
import { websiteDeploymentIsActive } from '@elysian/contracts'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

type DeploymentState = {
  tasks: readonly WebsiteDeploymentTask[]; loading: boolean; error?: string
  refresh(gateway: ElysianGateway): Promise<void>
  put(task: WebsiteDeploymentTask): void
}
export const useWebsiteDeploymentsStore = create<DeploymentState>((set, get) => ({
  tasks: [], loading: false,
  put(task) { set((s) => ({ tasks: [task, ...s.tasks.filter((row) => row.id !== task.id)] })) },
  async refresh(gateway) {
    if (get().loading || !gateway.websites.deployment) return
    set({ loading: true })
    try {
      const rows = await gateway.websites.deployment.list()
      const active = rows.filter((row) => websiteDeploymentIsActive(row.state))
      const updates = await Promise.all(active.map((row) => gateway.websites.deployment!.task(row.id)))
      const byId = new Map(updates.map((row) => [row.id, row]))
      set({ tasks: rows.map((row) => byId.get(row.id) ?? row).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), loading: false, error: undefined })
    } catch (error) { set({ loading: false, error: error instanceof Error ? error.message : '部署任务加载失败' }) }
  },
}))

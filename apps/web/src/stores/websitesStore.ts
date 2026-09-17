import type {
  WebsiteCategory,
  WebsiteProject,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
} from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/** 批量操作取值：启停即逐项调用启停，删除逐项删除。 */
export type WebsiteBatchAction = 'start' | 'stop' | 'remove'

type WebsitesStatus = 'idle' | 'loading' | 'ready' | 'error'

type WebsitesState = {
  status: WebsitesStatus
  errorMessage: string | undefined
  projects: readonly WebsiteProject[]
  /** 搜索按项目名称与备注匹配，单列表卡片直接消费。 */
  search: string
  /** 「全部分类」筛选：all 表示不过滤。 */
  category: WebsiteCategory | 'all'
  selectedIds: readonly string[]
  batchAction: WebsiteBatchAction | undefined
  batchRunning: boolean
  /** 刷新走静默重载：不闪整页加载态，只锁刷新按钮一拍。 */
  refreshing: boolean
  saving: boolean
  createDialogOpen: boolean
  settingsTarget: WebsiteProject | undefined
  removeTarget: WebsiteProject | undefined
  /** 详情抽屉的当前项目；运行日志懒加载，打开抽屉才拉取。 */
  detailTarget: WebsiteProject | undefined
  detailLogs: readonly string[] | undefined
  detailLogsLoading: boolean
  busyProjectIds: readonly string[]
  load: (gateway: ElysianGateway) => Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  setCategory: (category: WebsiteCategory | 'all') => void
  toggleSelected: (projectId: string) => void
  /** 全选只作用于当前筛选下的可见行，由面板传入可见标识集合。 */
  toggleSelectAllVisible: (visibleIds: readonly string[]) => void
  setBatchAction: (action: WebsiteBatchAction | undefined) => void
  openCreate: () => void
  closeCreate: () => void
  /** 类型由表单选择后传进来：单列表不再按页签隐含类型。 */
  createProject: (
    gateway: ElysianGateway,
    kind: WebsiteProjectKind,
    input: WebsiteProjectCreateInput,
  ) => Promise<boolean>
  openSettings: (project: WebsiteProject) => void
  closeSettings: () => void
  saveSettings: (
    gateway: ElysianGateway,
    projectId: string,
    input: { note: string | null; expiryAt: string | null },
  ) => Promise<boolean>
  openRemove: (project: WebsiteProject) => void
  closeRemove: () => void
  removeProject: (gateway: ElysianGateway, project: WebsiteProject) => Promise<void>
  setRunning: (gateway: ElysianGateway, project: WebsiteProject, running: boolean) => Promise<void>
  runBatch: (gateway: ElysianGateway) => Promise<void>
  openDetail: (gateway: ElysianGateway, project: WebsiteProject) => Promise<void>
  closeDetail: () => void
  /** 详情抽屉的刷新按钮：目标项目仍在屏上时重新拉取日志。 */
  reloadDetailLogs: (gateway: ElysianGateway) => Promise<void>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const useWebsitesStore = create<WebsitesState>((set, get) => {
  /**
   * 拉取一个项目的运行日志。响应回来时抽屉可能已关闭或换了项目：
   * 只有本项目仍是当前详情时才落状态，避免慢响应串台。
   */
  async function pullDetailLogs(gateway: ElysianGateway, projectId: string): Promise<void> {
    try {
      const logs = await gateway.websites.logs(projectId)
      if (get().detailTarget?.id !== projectId) return
      set({ detailLogs: logs, detailLogsLoading: false })
    } catch (error) {
      if (get().detailTarget?.id !== projectId) return
      set({ detailLogsLoading: false })
      notify(errorMessageOf(error, '日志加载失败'), 'danger')
    }
  }

  return {
    status: 'idle',
    errorMessage: undefined,
    projects: [],
    search: '',
    category: 'all',
    selectedIds: [],
    batchAction: undefined,
    batchRunning: false,
    refreshing: false,
    saving: false,
    createDialogOpen: false,
    settingsTarget: undefined,
    removeTarget: undefined,
    detailTarget: undefined,
    detailLogs: undefined,
    detailLogsLoading: false,
    busyProjectIds: [],

    async load(gateway) {
      if (get().status === 'loading') return
      set({ status: 'loading', errorMessage: undefined })
      try {
        const projects = await gateway.websites.list()
        set({ status: 'ready', projects })
      } catch (error) {
        set({ status: 'error', errorMessage: errorMessageOf(error, '网站数据加载失败') })
      }
    },

    // 刷新是静默重载：列表已在屏上，只把拉取过程反映在刷新按钮的忙碌态上。
    async refresh(gateway) {
      if (get().refreshing) return
      set({ refreshing: true })
      try {
        const projects = await gateway.websites.list()
        set({ status: 'ready', projects, errorMessage: undefined })
      } catch (error) {
        notify(errorMessageOf(error, '刷新失败'), 'danger')
      } finally {
        set({ refreshing: false })
      }
    },

    setSearch(search) {
      set({ search })
    },

    setCategory(category) {
      set({ category })
    },

    toggleSelected(projectId) {
      const selected = get().selectedIds
      set({
        selectedIds: selected.includes(projectId)
          ? selected.filter((id) => id !== projectId)
          : [...selected, projectId],
      })
    },

    toggleSelectAllVisible(visibleIds) {
      const selected = get().selectedIds
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
      set({
        selectedIds: allSelected
          ? selected.filter((id) => !visibleIds.includes(id))
          : [...new Set([...selected, ...visibleIds])],
      })
    },

    setBatchAction(batchAction) {
      set({ batchAction })
    },

    openCreate() {
      set({ createDialogOpen: true })
    },

    closeCreate() {
      set({ createDialogOpen: false, saving: false })
    },

    async createProject(gateway, kind, input) {
      if (get().saving) return false
      set({ saving: true })
      try {
        const created = await gateway.websites.create(kind, input)
        set((state) => ({ projects: [...state.projects, created], createDialogOpen: false, saving: false }))
        notify(`项目 ${created.name} 已添加（mock，待接入真实执行）`)
        return true
      } catch (error) {
        set({ saving: false })
        notify(errorMessageOf(error, '添加失败'), 'danger')
        return false
      }
    },

    openSettings(project) {
      set({ settingsTarget: project })
    },

    closeSettings() {
      set({ settingsTarget: undefined, saving: false })
    },

    async saveSettings(gateway, projectId, input) {
      if (get().saving) return false
      set({ saving: true })
      try {
        const updated = await gateway.websites.update(projectId, input)
        set((state) => ({
          projects: state.projects.map((project) => (project.id === updated.id ? updated : project)),
          settingsTarget: undefined,
          saving: false,
        }))
        notify(`项目 ${updated.name} 已修改（mock，待接入真实执行）`)
        return true
      } catch (error) {
        set({ saving: false })
        notify(errorMessageOf(error, '保存失败'), 'danger')
        return false
      }
    },

    openRemove(project) {
      set({ removeTarget: project })
    },

    closeRemove() {
      set({ removeTarget: undefined })
    },

    async removeProject(gateway, project) {
      if (get().busyProjectIds.includes(project.id)) return
      set((state) => ({ busyProjectIds: [...state.busyProjectIds, project.id] }))
      try {
        await gateway.websites.remove(project.id)
        set((state) => ({
          projects: state.projects.filter((item) => item.id !== project.id),
          selectedIds: state.selectedIds.filter((id) => id !== project.id),
          removeTarget: undefined,
          busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id),
        }))
        notify(`项目 ${project.name} 已删除（mock，待接入真实执行）`)
      } catch (error) {
        set((state) => ({ busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id) }))
        notify(errorMessageOf(error, '删除失败'), 'danger')
      }
    },

    // 乐观更新：状态先翻再等 adapter 确认，失败回滚并报危险通知。
    async setRunning(gateway, project, running) {
      if (get().busyProjectIds.includes(project.id)) return
      const previous = project
      const optimistic: WebsiteProject = {
        ...project,
        runState: running ? 'running' : 'stopped',
        pid: running ? project.pid : null,
      }
      set((state) => ({
        busyProjectIds: [...state.busyProjectIds, project.id],
        projects: state.projects.map((item) => (item.id === project.id ? optimistic : item)),
      }))
      try {
        const confirmed = await gateway.websites.setRunning(project.id, running)
        set((state) => ({
          projects: state.projects.map((item) => (item.id === confirmed.id ? confirmed : item)),
          busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id),
        }))
        notify(`项目 ${project.name} 已${running ? '启动' : '停止'}（mock，待接入真实执行）`)
      } catch (error) {
        set((state) => ({
          projects: state.projects.map((item) => (item.id === previous.id ? previous : item)),
          busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id),
        }))
        notify(errorMessageOf(error, '操作失败'), 'danger')
      }
    },

    async runBatch(gateway) {
      const { batchAction, selectedIds, projects, batchRunning } = get()
      if (!batchAction || selectedIds.length === 0 || batchRunning) return
      set({ batchRunning: true })
      const targets = projects.filter((project) => selectedIds.includes(project.id))
      const verb = batchAction === 'start' ? '启动' : batchAction === 'stop' ? '停止' : '删除'
      try {
        for (const project of targets) {
          if (batchAction === 'remove') {
            await gateway.websites.remove(project.id)
          } else {
            await gateway.websites.setRunning(project.id, batchAction === 'start')
          }
        }
        const refreshed = await gateway.websites.list()
        set({
          projects: refreshed,
          selectedIds: [],
          batchAction: undefined,
        })
        notify(`批量${verb}完成：${targets.length} 个项目（mock，待接入真实执行）`)
      } catch (error) {
        // 中途失败时前半批可能已生效：重拉列表让界面与数据集保持一致，不留下半真半假的视图。
        try {
          set({ projects: await gateway.websites.list() })
        } catch {
          // 重拉也失败就只报原始错误，界面保持批量前状态。
        }
        notify(errorMessageOf(error, `批量${verb}失败`), 'danger')
      } finally {
        set({ batchRunning: false })
      }
    },

    async openDetail(gateway, project) {
      // 换详情换一批日志：旧日志与旧 loading 都是上一个抽屉的上下文，一并清空。
      set({ detailTarget: project, detailLogs: undefined, detailLogsLoading: true })
      await pullDetailLogs(gateway, project.id)
    },

    closeDetail() {
      set({ detailTarget: undefined, detailLogs: undefined, detailLogsLoading: false })
    },

    async reloadDetailLogs(gateway) {
      const target = get().detailTarget
      if (!target) return
      // 刷新不清旧日志：旧内容留在屏上，只有 loading 在转。
      set({ detailLogsLoading: true })
      await pullDetailLogs(gateway, target.id)
    },
  }
})

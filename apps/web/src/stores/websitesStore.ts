import type {
  WebsiteCategory,
  WebsiteAccessInput,
  WebsiteProject,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProxyStatus,
} from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useMessageStore } from './messageStore'
import { notifyFirewallPortSync } from './firewallPortNotice'

/**
 * 动作完成提示的运行模式标注：Docker 运行时动作已真实执行（容器、站点目录与
 * 反向代理配置），直接呈现结果；宿主机本地开发（内存演示数据集）标注演示语义，
 * 括号形态追加在句子末尾，只用这一个来源。
 */
export function websiteNoticeSuffix(dockerRuntime: boolean): string {
  return dockerRuntime ? '' : '（演示数据，刷新后还原）'
}

const NOTICE_SUFFIX = websiteNoticeSuffix(isDockerRuntime())

type WebsitesStatus = 'idle' | 'loading' | 'ready' | 'error'

type WebsitesState = {
  status: WebsitesStatus
  errorMessage: string | undefined
  projects: readonly WebsiteProject[]
  /** 反向代理通道状态：unavailable 或 active 且 detail 非空时面板渲染横幅。 */
  proxyStatus: WebsiteProxyStatus
  /** 搜索按项目名称与备注匹配，单列表卡片直接消费。 */
  search: string
  /** 「全部分类」筛选：all 表示不过滤。 */
  category: WebsiteCategory | 'all'
  /** 刷新走静默重载：不闪整页加载态，只锁刷新按钮一拍。 */
  refreshing: boolean
  /** 「重新下发反向代理配置」按钮的忙碌态：动作进行中禁用并转圈。 */
  reconciling: boolean
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
  /** 域级对账：从登记全量重新下发反向代理配置，成功后刷新列表与通道状态。 */
  reconcileProxy: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  setCategory: (category: WebsiteCategory | 'all') => void
  openCreate: () => void
  closeCreate: () => void
  /** 类型由表单选择后传进来：单列表不再按页签隐含类型。 */
  createProject: (
    gateway: ElysianGateway,
    kind: WebsiteProjectKind,
    input: WebsiteProjectCreateInput,
  ) => Promise<boolean>
  saveAccess: (gateway: ElysianGateway, projectId: string, access: WebsiteAccessInput) => Promise<WebsiteProject>
  settingsError?: string
  openSettings: (project: WebsiteProject) => void
  closeSettings: () => void
  saveSettings: (
    gateway: ElysianGateway,
    projectId: string,
    input: { note: string | null; expiryAt: string | null; command?: string | null },
  ) => Promise<boolean>
  openRemove: (project: WebsiteProject) => void
  closeRemove: () => void
  removeProject: (gateway: ElysianGateway, project: WebsiteProject) => Promise<void>
  setRunning: (gateway: ElysianGateway, project: WebsiteProject, running: boolean) => Promise<void>
  openDetail: (gateway: ElysianGateway, project: WebsiteProject) => Promise<void>
  closeDetail: () => void
  /** 详情抽屉的刷新按钮：目标项目仍在屏上时重新拉取日志。 */
  reloadDetailLogs: (gateway: ElysianGateway) => Promise<void>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useMessageStore.getState().notify({ message, tone })
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
    // 初始值等同「通道正常且无漂移」：首次 load 之前不渲染横幅。
    proxyStatus: { state: 'active', detail: null },
    search: '',
    category: 'all',
    refreshing: false,
    reconciling: false,
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
        const { projects, proxy } = await gateway.websites.list()
        set({ status: 'ready', projects, proxyStatus: proxy })
      } catch (error) {
        set({ status: 'error', errorMessage: errorMessageOf(error, '网站数据加载失败') })
      }
    },

    // 刷新是静默重载：列表已在屏上，只把拉取过程反映在刷新按钮的忙碌态上。
    async refresh(gateway) {
      if (get().refreshing) return
      set({ refreshing: true })
      try {
        const { projects, proxy } = await gateway.websites.list()
        set({ status: 'ready', projects, proxyStatus: proxy, errorMessage: undefined })
      } catch (error) {
        notify(errorMessageOf(error, '刷新失败'), 'danger')
      } finally {
        set({ refreshing: false })
      }
    },

    async reconcileProxy(gateway) {
      if (get().reconciling) return
      set({ reconciling: true })
      try {
        const proxy = await gateway.websites.reconcileProxy()
        set({ proxyStatus: proxy })
        notify('反向代理配置已重新下发')
        // 路由事实要等下一次列表读取：成功后静默刷新一次，横幅随之下线。
        await get().refresh(gateway)
      } catch (error) {
        notify(errorMessageOf(error, '反向代理配置下发失败'), 'danger')
      } finally {
        set({ reconciling: false })
      }
    },

    setSearch(search) {
      set({ search })
    },

    setCategory(category) {
      set({ category })
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
        const { project: created, firewallPort } = await gateway.websites.create(kind, input)
        set((state) => ({ projects: [...state.projects, created], createDialogOpen: false, saving: false }))
        notify(`项目 ${created.name} 已添加${NOTICE_SUFFIX}`)
        notifyFirewallPortSync(firewallPort)
        return true
      } catch (error) {
        set({ saving: false })
        notify(errorMessageOf(error, '添加失败'), 'danger')
        return false
      }
    },

    async saveAccess(gateway, projectId, access) {
      if (get().busyProjectIds.includes(projectId)) throw new Error('项目正在执行其他操作')
      set((state) => ({ busyProjectIds: [...state.busyProjectIds, projectId] }))
      try {
        const { project: updated, firewallPort } = await gateway.websites.setAccess(projectId, access)
        set((state) => ({
          projects: state.projects.map((project) => project.id === projectId ? updated : project),
          detailTarget: state.detailTarget?.id === projectId ? updated : state.detailTarget,
        }))
        notify(`项目 ${updated.name} 的访问配置已保存${NOTICE_SUFFIX}`)
        notifyFirewallPortSync(firewallPort)
        await get().refresh(gateway)
        return get().projects.find((project) => project.id === projectId) ?? updated
      } finally {
        set((state) => ({ busyProjectIds: state.busyProjectIds.filter((id) => id !== projectId) }))
      }
    },

    openSettings(project) {
      set({ settingsTarget: project, settingsError: undefined })
    },

    closeSettings() {
      set({ settingsTarget: undefined, saving: false })
    },

    async saveSettings(gateway, projectId, input) {
      if (get().saving) return false
      set({ saving: true, settingsError: undefined })
      try {
        const updated = await gateway.websites.update(projectId, input)
        set((state) => ({
          projects: state.projects.map((project) => (project.id === updated.id ? updated : project)),
          settingsTarget: undefined,
          saving: false,
        }))
        notify(`项目 ${updated.name} 已修改${NOTICE_SUFFIX}`)
        return true
      } catch (error) {
        set({ saving: false, settingsError: errorMessageOf(error, '保存失败') })
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
          removeTarget: undefined,
          busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id),
        }))
        notify(`项目 ${project.name} 已删除${NOTICE_SUFFIX}`)
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
        notify(`项目 ${project.name} 已${running ? '启动' : '停止'}${NOTICE_SUFFIX}`)
      } catch (error) {
        set((state) => ({
          projects: state.projects.map((item) => (item.id === previous.id ? previous : item)),
          busyProjectIds: state.busyProjectIds.filter((id) => id !== project.id),
        }))
        notify(errorMessageOf(error, '操作失败'), 'danger')
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

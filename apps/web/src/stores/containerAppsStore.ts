import { create } from 'zustand'
import type {
  ComposeCheckResult,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildPlan,
  ContainerBuildPreviewInput,
  ContainerBuildSubmitInput,
  ContainerBuildTask,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/**
 * 容器工作区的界面状态。数据一律经 gateway.containers 的 adapter 取，
 * 组件不碰数据来源；演示模式落在内存 mock，真实运行时落 /api/container-apps。
 */

/** 自检结果按「工作区 + 文件」记一份，换文件重跑不串台。 */
export type ComposeCheckState = {
  slug: string
  path: string
  result: ComposeCheckResult | null
  loading: boolean
  error: string | null
}

/** 构建预览状态：构建弹窗专用，含预览与提交两条动作的在途与错误。 */
export type ContainerBuildPreviewState = {
  slug: string
  loading: boolean
  error: string | null
  plan: ContainerBuildPlan | null
  submitting: boolean
  submitError: string | null
}

/** 构建日志的增量读取状态：next 是已读字节，轮询按它续读。 */
export type ContainerBuildLogsState = {
  slug: string
  taskId: string
  lines: readonly string[]
  next: number
  total: number
  loading: boolean
  error: string | null
}

export type ContainerAppsState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  apps: readonly ContainerApp[]
  errorMessage?: string
  /** 列表刷新在途：旧清单留在屏上，只由卡片自身盖遮罩。 */
  refreshing: boolean
  creating: boolean
  createError: string | null
  /** 正在上传或保存的「工作区/文件」键；同一时刻只允许一个写动作。 */
  writing: string | null
  check: ComposeCheckState | null
  /** 每个工作区一份构建任务清单，按创建时间倒序。 */
  buildsBySlug: Record<string, readonly ContainerBuildTask[]>
  /** 任务区首次加载（还没有任何数据）才落加载态，之后的刷新走遮罩。 */
  buildsLoading: Record<string, boolean>
  /** 任务区手动刷新在途：只盖任务区自己，静默轮询不置位。 */
  buildsRefreshing: Record<string, boolean>
  buildsError: Record<string, string | null>
  buildPreview: ContainerBuildPreviewState | null
  buildLogs: Record<string, ContainerBuildLogsState>
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  create(gateway: ElysianGateway, input: { slug: string; displayName: string }): Promise<boolean>
  remove(gateway: ElysianGateway, slug: string): Promise<void>
  upload(gateway: ElysianGateway, slug: string, files: readonly File[]): Promise<void>
  save(gateway: ElysianGateway, slug: string, path: string, content: string): Promise<boolean>
  removeFile(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  runCheck(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  clearCheck(): void
  /** 任务区首次打开时加载；已有清单时等价于手动刷新。 */
  ensureBuilds(gateway: ElysianGateway, slug: string): Promise<void>
  /** 刷新任务清单；silent 供 2s 轮询用，不驱动遮罩与错误态。 */
  refreshBuilds(gateway: ElysianGateway, slug: string, options?: { silent?: boolean }): Promise<void>
  previewBuild(gateway: ElysianGateway, slug: string, input: ContainerBuildPreviewInput): Promise<ContainerBuildPlan | null>
  /** 提交构建：成功通知「已提交构建任务」并入列；notifyOnError 供弹窗外的「重新构建」走通知。 */
  submitBuild(gateway: ElysianGateway, slug: string, input: ContainerBuildSubmitInput, options?: { notifyOnError?: boolean }): Promise<boolean>
  cancelBuild(gateway: ElysianGateway, slug: string, taskId: string): Promise<void>
  clearBuildPreview(): void
  /** 打开日志：重置后从 0 拉全量。 */
  openBuildLogs(gateway: ElysianGateway, slug: string, taskId: string): Promise<void>
  /** 活跃任务的增量续读：从已读字节接着拉。 */
  loadBuildLogs(gateway: ElysianGateway, slug: string, taskId: string): Promise<void>
  closeBuildLogs(taskId: string): void
}

/** 构建任务的 requestId：uuid 形状（小写），与服务端 safeDeploymentID 同一正则口径。 */
export function newBuildRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const detail = (cause: unknown) => (cause instanceof Error ? cause.message : '操作失败，请重试')
/** 写动作在途的键；`*` 表示整工作区（批量上传），界面据此决定遮罩挂在哪。 */
export const appWritingKey = (slug: string, path: string) => `${slug}/${path}`
export const WORKSPACE_WRITING_PATH = '*'

export const useContainerAppsStore = create<ContainerAppsState>((set, get) => ({
  status: 'idle',
  apps: [],
  refreshing: false,
  creating: false,
  createError: null,
  writing: null,
  check: null,
  buildsBySlug: {},
  buildsLoading: {},
  buildsRefreshing: {},
  buildsError: {},
  buildPreview: null,
  buildLogs: {},

  async load(gateway) {
    // 首次加载才换整块加载态；已有清单时的再取走 refresh，不闪白屏。
    if (get().status === 'ready' || get().apps.length > 0) {
      await get().refresh(gateway)
      return
    }
    set({ status: 'loading', errorMessage: undefined })
    try {
      set({ status: 'ready', apps: await gateway.containers.listApps() })
    } catch (cause) {
      set({ status: 'error', errorMessage: detail(cause) })
    }
  },

  async refresh(gateway, options) {
    if (!options?.silent) set({ refreshing: true })
    try {
      set({ apps: await gateway.containers.listApps(), status: 'ready', errorMessage: undefined })
    } catch (cause) {
      set({ errorMessage: detail(cause) })
      useNotificationStore.getState().notify({ tone: 'danger', message: `读取工作区失败：${detail(cause)}` })
    } finally {
      if (!options?.silent) set({ refreshing: false })
    }
  },

  async create(gateway, input) {
    set({ creating: true, createError: null })
    try {
      const created = await gateway.containers.createApp(input)
      set((state) => ({ creating: false, apps: [...state.apps, created].sort((a, b) => a.slug.localeCompare(b.slug)) }))
      useNotificationStore.getState().notify({ tone: 'success', message: `已创建工作区 ${created.slug}` })
      return true
    } catch (cause) {
      set({ creating: false, createError: detail(cause) })
      return false
    }
  },

  async remove(gateway, slug) {
    try {
      await gateway.containers.removeApp(slug)
      set((state) => {
        // 工作区没了，它的任务清单、预览与日志状态一并让位，不留悬挂键。
        const buildsBySlug = { ...state.buildsBySlug }
        const buildsLoading = { ...state.buildsLoading }
        const buildsRefreshing = { ...state.buildsRefreshing }
        const buildsError = { ...state.buildsError }
        delete buildsBySlug[slug]
        delete buildsLoading[slug]
        delete buildsRefreshing[slug]
        delete buildsError[slug]
        return {
          apps: state.apps.filter((app) => app.slug !== slug),
          check: state.check?.slug === slug ? null : state.check,
          buildsBySlug,
          buildsLoading,
          buildsRefreshing,
          buildsError,
          buildPreview: state.buildPreview?.slug === slug ? null : state.buildPreview,
        }
      })
      useNotificationStore.getState().notify({ tone: 'success', message: `已删除工作区 ${slug} 及其目录` })
    } catch (cause) {
      // 409（活跃构建任务拦截）等服务端错误原文在这里原样透出。
      useNotificationStore.getState().notify({ tone: 'danger', message: `删除工作区失败：${detail(cause)}` })
    }
  },

  /**
   * 上传按所选顺序逐个落盘：一次只让一个文件在途，行内忙碌态才有意义。
   * 清单只在整批结束后重取一次，目录上传不会打出 N 次列表请求。
   */
  async upload(gateway, slug, files) {
    if (files.length === 0) return
    set({ writing: appWritingKey(slug, WORKSPACE_WRITING_PATH) })
    const uploaded: string[] = []
    try {
      for (const file of files) {
        // 目录上传时 webkitRelativePath 带子路径，单文件时回落到文件名。
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        set({ writing: appWritingKey(slug, relative) })
        const saved = await gateway.containers.uploadAppFile(slug, relative, file)
        uploaded.push(saved.path)
      }
      useNotificationStore.getState().notify({
        tone: 'success',
        message: uploaded.length === 1 ? `已上传 ${uploaded[0]}` : `已上传 ${uploaded.length} 个文件`,
      })
    } catch (cause) {
      useNotificationStore.getState().notify({
        tone: 'danger',
        message: `上传文件失败：${detail(cause)}${uploaded.length > 0 ? `（已有 ${uploaded.length} 个文件上传成功）` : ''}`,
      })
    } finally {
      // 中途失败或写超时也回读事实；已落盘的文件不能因为后一项失败而藏在旧清单之外。
      await get().refresh(gateway, { silent: true })
      set({ writing: null })
    }
    const compose = uploaded.filter(isComposeFile).pop()
    if (compose) void get().runCheck(gateway, slug, compose)
  },

  async save(gateway, slug, path, content) {
    set({ writing: appWritingKey(slug, path) })
    try {
      await gateway.containers.writeAppContent(slug, path, content)
      await get().refresh(gateway, { silent: true })
      useNotificationStore.getState().notify({ tone: 'success', message: `已保存 ${path}` })
      if (isComposeFile(path)) void get().runCheck(gateway, slug, path)
      return true
    } catch (cause) {
      useNotificationStore.getState().notify({ tone: 'danger', message: `保存失败：${detail(cause)}` })
      return false
    } finally {
      set({ writing: null })
    }
  },

  async removeFile(gateway, slug, path) {
    set({ writing: appWritingKey(slug, path) })
    try {
      await gateway.containers.removeAppFile(slug, path)
      set((state) => ({
        apps: state.apps.map((app) =>
          app.slug === slug
            ? { ...app, files: app.files.filter((file) => file.path !== path) }
            : app,
        ),
        check: state.check?.slug === slug && state.check.path === path ? null : state.check,
      }))
    } catch (cause) {
      useNotificationStore.getState().notify({ tone: 'danger', message: `删除文件失败：${detail(cause)}` })
    } finally {
      set({ writing: null })
    }
  },

  async runCheck(gateway, slug, path) {
    set({ check: { slug, path, result: null, loading: true, error: null } })
    try {
      const result = await gateway.containers.checkCompose(slug, path)
      set({ check: { slug, path, result, loading: false, error: null } })
    } catch (cause) {
      set({ check: { slug, path, result: null, loading: false, error: detail(cause) } })
    }
  },

  clearCheck() {
    set({ check: null })
  },

  async ensureBuilds(gateway, slug) {
    // 首次（键还不存在）才换加载态；已有清单时的再取走刷新遮罩，不白屏。
    if (get().buildsBySlug[slug] !== undefined) {
      await get().refreshBuilds(gateway, slug)
      return
    }
    set((state) => ({ buildsLoading: { ...state.buildsLoading, [slug]: true }, buildsError: { ...state.buildsError, [slug]: null } }))
    try {
      const builds = await gateway.containers.listAppBuilds(slug)
      set((state) => ({
        buildsBySlug: { ...state.buildsBySlug, [slug]: builds },
        buildsLoading: { ...state.buildsLoading, [slug]: false },
      }))
    } catch (cause) {
      set((state) => ({
        buildsLoading: { ...state.buildsLoading, [slug]: false },
        buildsError: { ...state.buildsError, [slug]: detail(cause) },
      }))
    }
  },

  async refreshBuilds(gateway, slug, options) {
    const silent = options?.silent === true
    if (!silent) set((state) => ({ buildsRefreshing: { ...state.buildsRefreshing, [slug]: true } }))
    try {
      const builds = await gateway.containers.listAppBuilds(slug)
      set((state) => ({
        buildsBySlug: { ...state.buildsBySlug, [slug]: builds },
        buildsRefreshing: { ...state.buildsRefreshing, [slug]: false },
        ...(silent ? {} : { buildsError: { ...state.buildsError, [slug]: null } }),
      }))
    } catch (cause) {
      // 静默轮询失败不打扰：旧任务清单留在屏上，也不清错误重试入口之外的状态。
      if (silent) return
      set((state) => ({
        buildsRefreshing: { ...state.buildsRefreshing, [slug]: false },
        buildsError: { ...state.buildsError, [slug]: detail(cause) },
      }))
    }
  },

  async previewBuild(gateway, slug, input) {
    set({ buildPreview: { slug, loading: true, error: null, plan: null, submitting: false, submitError: null } })
    try {
      const plan = await gateway.containers.previewAppBuild(slug, input)
      set({ buildPreview: { slug, loading: false, error: null, plan, submitting: false, submitError: null } })
      return plan
    } catch (cause) {
      set({ buildPreview: { slug, loading: false, error: detail(cause), plan: null, submitting: false, submitError: null } })
      return null
    }
  },

  async submitBuild(gateway, slug, input, options) {
    set((state) => ({
      buildPreview: state.buildPreview?.slug === slug
        ? { ...state.buildPreview, submitting: true, submitError: null }
        : state.buildPreview,
    }))
    try {
      const task = await gateway.containers.submitAppBuild(slug, input)
      set((state) => ({
        buildsBySlug: { ...state.buildsBySlug, [slug]: [task, ...(state.buildsBySlug[slug] ?? [])] },
        buildPreview: state.buildPreview?.slug === slug
          ? { ...state.buildPreview, submitting: false }
          : state.buildPreview,
      }))
      useNotificationStore.getState().notify({ tone: 'success', message: '已提交构建任务' })
      return true
    } catch (cause) {
      const message = detail(cause)
      set((state) => ({
        buildPreview: state.buildPreview?.slug === slug
          ? { ...state.buildPreview, submitting: false, submitError: message }
          : state.buildPreview,
      }))
      if (options?.notifyOnError) {
        useNotificationStore.getState().notify({ tone: 'danger', message: `提交构建任务失败：${message}` })
      }
      return false
    }
  },

  async cancelBuild(gateway, slug, taskId) {
    try {
      await gateway.containers.cancelAppBuild(slug, taskId)
      await get().refreshBuilds(gateway, slug, { silent: true })
      useNotificationStore.getState().notify({ tone: 'success', message: '已取消构建任务' })
    } catch (cause) {
      useNotificationStore.getState().notify({ tone: 'danger', message: `取消构建任务失败：${detail(cause)}` })
    }
  },

  clearBuildPreview() {
    set({ buildPreview: null })
  },

  async openBuildLogs(gateway, slug, taskId) {
    set((state) => ({
      buildLogs: { ...state.buildLogs, [taskId]: { slug, taskId, lines: [], next: 0, total: 0, loading: true, error: null } },
    }))
    try {
      const report = await gateway.containers.getAppBuildLogs(slug, taskId, 0)
      set((state) => ({
        buildLogs: { ...state.buildLogs, [taskId]: { slug, taskId, lines: report.lines, next: report.next, total: report.total, loading: false, error: null } },
      }))
    } catch (cause) {
      set((state) => ({
        buildLogs: { ...state.buildLogs, [taskId]: { slug, taskId, lines: [], next: 0, total: 0, loading: false, error: detail(cause) } },
      }))
    }
  },

  async loadBuildLogs(gateway, slug, taskId) {
    const current = get().buildLogs[taskId]
    if (!current || current.loading) return
    set((state) => ({ buildLogs: { ...state.buildLogs, [taskId]: { ...current, loading: true } } }))
    try {
      const report = await gateway.containers.getAppBuildLogs(slug, taskId, current.next)
      set((state) => ({
        buildLogs: {
          ...state.buildLogs,
          [taskId]: report.lines.length > 0
            ? { slug, taskId, lines: [...current.lines, ...report.lines], next: report.next, total: report.total, loading: false, error: null }
            : { ...current, next: report.next, total: report.total, loading: false, error: null },
        },
      }))
    } catch (cause) {
      set((state) => {
        const row = state.buildLogs[taskId]
        if (!row) return {}
        return { buildLogs: { ...state.buildLogs, [taskId]: { ...row, loading: false, error: detail(cause) } } }
      })
    }
  },

  closeBuildLogs(taskId) {
    set((state) => {
      const buildLogs = { ...state.buildLogs }
      delete buildLogs[taskId]
      return { buildLogs }
    })
  },
}))

/** compose 文件名判定：自检只对它有意义。 */
export function isComposeFile(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return /^docker-compose\.(ya?ml)$|^compose\.(ya?ml)$/.test(base)
}

/** 取某工作区下的文件条目。 */
export function findAppFile(apps: readonly ContainerApp[], slug: string, path: string): ContainerAppFile | undefined {
  return apps.find((app) => app.slug === slug)?.files.find((file) => file.path === path)
}

import { captureAuthGeneration } from '../utils/authGeneration'
import { create } from 'zustand'
import { randomId } from '../utils/randomId'
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
import { useMessageStore } from './messageStore'
import { isContainerBuildActive } from '@elysian/contracts'
import { messageOf } from '../utils/errorMessage'
import { createRequestGuard } from './requestGuard'

/**
 * 容器工作区的界面状态。数据一律经 gateway.containers 的 adapter 取，
 * 组件不碰数据来源；演示模式落在内存 mock，真实运行时落 /api/container-apps。
 */

/** 自检结果按「工作区 + 文件」记一份，换文件重跑不串台。 */
export type ComposeCheckState = {
  slug: string
  path: string
  status: 'loading' | 'ready' | 'error'
  result: ComposeCheckResult | null
  errorMessage?: string
}

/** 构建预览状态：构建弹窗专用，含预览与提交两条动作的在途与错误。 */
type ContainerBuildPreviewState = {
  slug: string
  status: 'loading' | 'ready' | 'error'
  errorMessage?: string
  plan: ContainerBuildPlan | null
  submitting: boolean
  submitError: string | null
}

/** 构建日志的增量读取状态：next 是已读字节，轮询按它续读。 */
type ContainerBuildLogsState = {
  slug: string
  taskId: string
  status: 'loading' | 'ready' | 'error'
  lines: readonly string[]
  next: number
  total: number
  errorMessage?: string
}

type ContainerBuildListState = {
  status: 'loading' | 'ready' | 'error'
  /** 未读到任务清单与读到空清单是两个状态。 */
  tasks?: readonly ContainerBuildTask[]
  errorMessage?: string
  /** 只驱动手动刷新按钮，静默读取不置位。 */
  refreshing: boolean
}

export type ContainerAppsState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  apps: readonly ContainerApp[]
  errorMessage?: string
  /** 列表手动刷新在途：旧清单保留，仅驱动刷新按钮。 */
  refreshing: boolean
  creating: boolean
  createError: string | null
  /** 正在上传或保存的「工作区/文件」键；同一时刻只允许一个写动作。 */
  writing: string | null
  check: ComposeCheckState | null
  /** 每个工作区一份构建任务清单，按创建时间倒序。 */
  buildsBySlug: Partial<Record<string, ContainerBuildListState>>
  buildPreview: ContainerBuildPreviewState | null
  buildLogs: Record<string, ContainerBuildLogsState>
  clearDisplay(): void
  load(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  create(gateway: ElysianGateway, input: { slug: string; displayName: string }): Promise<boolean>
  remove(gateway: ElysianGateway, slug: string): Promise<void>
  upload(gateway: ElysianGateway, slug: string, files: readonly File[]): Promise<void>
  save(gateway: ElysianGateway, slug: string, path: string, content: string): Promise<boolean>
  removeFile(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  runCheck(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  clearCheck(): void
  /** 首载和刷新共用入口；打开面板、轮询和操作后回读保持静默。 */
  loadBuilds(gateway: ElysianGateway, slug: string, options?: { silent?: boolean }): Promise<void>
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
export function newBuildRequestId(): string { return randomId() }

const detail = (cause: unknown) => messageOf(cause, '操作失败，请重试')

function notifyBuildTransitions(previous: readonly ContainerBuildTask[], tasks: readonly ContainerBuildTask[], slug: string) {
  for (const task of tasks) {
    const old = previous.find((row) => row.id === task.id)
    if (!old || !isContainerBuildActive(old.state) || isContainerBuildActive(task.state)) continue
    const tone = task.state === 'succeeded' ? 'success' : task.state === 'failed' ? 'danger' : task.state === 'cancelled' ? 'info' : 'warning'
    const result = task.state === 'succeeded' ? '镜像构建已完成' : task.state === 'failed' ? '镜像构建失败' : task.state === 'cancelled' ? '镜像构建已取消' : '镜像构建已中断'
    useMessageStore.getState().notify({ tone, message: `${slug}：${result}${task.error ? `，${task.error}` : ''}` })
  }
}
/** 写动作在途的键；`*` 表示整工作区（批量上传），界面据此禁用对应写操作。 */
export const appWritingKey = (slug: string, path: string) => `${slug}/${path}`
export const WORKSPACE_WRITING_PATH = '*'

let pendingApps: { gateway: ElysianGateway; auth: number; snapshot: readonly ContainerApp[]; promise: Promise<void> } | undefined
const pendingBuilds = new Map<string, { gateway: ElysianGateway; auth: number; snapshot: readonly ContainerBuildTask[] | undefined; promise: Promise<void> }>()
const workspaceRequests = createRequestGuard()

const initialDisplay = {
  status: 'idle',
  apps: [],
  errorMessage: undefined,
  refreshing: false,
  creating: false,
  createError: null,
  writing: null,
  check: null,
  buildsBySlug: {},
  buildPreview: null,
  buildLogs: {},
} as const

export const useContainerAppsStore = create<ContainerAppsState>((set, get) => ({
  ...initialDisplay,

  clearDisplay() {
    workspaceRequests.invalidate()
    pendingApps = undefined
    pendingBuilds.clear()
    set(initialDisplay)
  },

  load(gateway, options) {
    const auth = captureAuthGeneration()
    if (pendingApps?.gateway === gateway && pendingApps.auth === auth && pendingApps.snapshot === get().apps) {
      if (!options?.silent) set({ refreshing: true })
      return pendingApps.promise
    }
    const hadData = get().status === 'ready'
    const operation = { gateway, auth, snapshot: get().apps, promise: Promise.resolve() }
    pendingApps = operation
    const current = () => pendingApps === operation && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', refreshing: !options?.silent, errorMessage: undefined })
    operation.promise = (async () => {
      try {
        const apps = await gateway.containers.listApps()
        if (current() && operation.snapshot === get().apps) set({ apps, status: 'ready', errorMessage: undefined })
      } catch (cause) {
        if (!current()) return
        set({ status: hadData ? 'ready' : 'error', errorMessage: detail(cause) })
        if (hadData) useMessageStore.getState().notify({ tone: 'danger', message: `读取工作区失败：${detail(cause)}` })
      } finally {
        if (pendingApps === operation) {
          pendingApps = undefined
          if (auth === captureAuthGeneration()) set({ refreshing: false })
        }
      }
    })()
    return operation.promise
  },

  async create(gateway, input) {
    const current = workspaceRequests.capture()
    set({ creating: true, createError: null })
    try {
      const created = await gateway.containers.createApp(input)
      if (!current()) return false
      set((state) => ({ creating: false, apps: [...state.apps, created].sort((a, b) => a.slug.localeCompare(b.slug)) }))
      useMessageStore.getState().notify({ tone: 'success', message: `已创建工作区 ${created.slug}` })
      return true
    } catch (cause) {
      if (!current()) return false
      set({ creating: false, createError: detail(cause) })
      useMessageStore.getState().notify({ tone: 'danger', message: `创建工作区失败：${detail(cause)}` })
      return false
    }
  },

  async remove(gateway, slug) {
    const current = workspaceRequests.capture()
    try {
      await gateway.containers.removeApp(slug)
      if (!current()) return
      pendingBuilds.delete(slug)
      set((state) => {
        const buildsBySlug = { ...state.buildsBySlug }
        delete buildsBySlug[slug]
        return {
          apps: state.apps.filter((app) => app.slug !== slug),
          check: state.check?.slug === slug ? null : state.check,
          buildsBySlug,
          buildPreview: state.buildPreview?.slug === slug ? null : state.buildPreview,
        }
      })
      useMessageStore.getState().notify({ tone: 'success', message: `已删除工作区 ${slug} 及其目录` })
    } catch (cause) {
      if (!current()) return
      // 409（活跃构建任务拦截）等服务端错误原文在这里原样透出。
      useMessageStore.getState().notify({ tone: 'danger', message: `删除工作区失败：${detail(cause)}` })
    }
  },

  /**
   * 上传按所选顺序逐个落盘：一次只让一个文件在途，行内忙碌态才有意义。
   * 清单只在整批结束后重取一次，目录上传不会打出 N 次列表请求。
   */
  async upload(gateway, slug, files) {
    if (files.length === 0) return
    const current = workspaceRequests.capture()
    set({ writing: appWritingKey(slug, WORKSPACE_WRITING_PATH) })
    const uploaded: string[] = []
    try {
      for (const file of files) {
        // 目录上传时 webkitRelativePath 带子路径，单文件时回落到文件名。
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        set({ writing: appWritingKey(slug, relative) })
        const saved = await gateway.containers.uploadAppFile(slug, relative, file)
        if (!current()) return
        uploaded.push(saved.path)
      }
      useMessageStore.getState().notify({
        tone: 'success',
        message: uploaded.length === 1 ? `已上传 ${uploaded[0]}` : `已上传 ${uploaded.length} 个文件`,
      })
    } catch (cause) {
      if (!current()) return
      useMessageStore.getState().notify({
        tone: 'danger',
        message: `上传文件失败：${detail(cause)}${uploaded.length > 0 ? `（已有 ${uploaded.length} 个文件上传成功）` : ''}`,
      })
    } finally {
      // 中途失败或写超时也回读事实；已落盘的文件不能因为后一项失败而藏在旧清单之外。
      if (current()) {
        await get().load(gateway, { silent: true })
        if (current()) set({ writing: null })
      }
    }
    const compose = uploaded.filter(isComposeFile).pop()
    if (compose && current()) void get().runCheck(gateway, slug, compose)
  },

  async save(gateway, slug, path, content) {
    const current = workspaceRequests.capture()
    set({ writing: appWritingKey(slug, path) })
    try {
      await gateway.containers.writeAppContent(slug, path, content)
      if (!current()) return false
      await get().load(gateway, { silent: true })
      if (!current()) return false
      useMessageStore.getState().notify({ tone: 'success', message: `已保存 ${path}` })
      if (isComposeFile(path)) void get().runCheck(gateway, slug, path)
      return true
    } catch (cause) {
      if (current()) useMessageStore.getState().notify({ tone: 'danger', message: `保存失败：${detail(cause)}` })
      return false
    } finally {
      if (current()) set({ writing: null })
    }
  },

  async removeFile(gateway, slug, path) {
    const current = workspaceRequests.capture()
    set({ writing: appWritingKey(slug, path) })
    try {
      await gateway.containers.removeAppFile(slug, path)
      if (!current()) return
      set((state) => ({
        apps: state.apps.map((app) =>
          app.slug === slug
            ? { ...app, files: app.files.filter((file) => file.path !== path) }
            : app,
        ),
        check: state.check?.slug === slug && state.check.path === path ? null : state.check,
      }))
      useMessageStore.getState().notify({ tone: 'success', message: `已删除 ${path}` })
    } catch (cause) {
      if (current()) useMessageStore.getState().notify({ tone: 'danger', message: `删除文件失败：${detail(cause)}` })
    } finally {
      if (current()) set({ writing: null })
    }
  },

  async runCheck(gateway, slug, path) {
    const current = workspaceRequests.capture()
    set({ check: { slug, path, result: null, status: 'loading' } })
    try {
      const result = await gateway.containers.checkCompose(slug, path)
      if (current()) set({ check: { slug, path, result, status: 'ready' } })
    } catch (cause) {
      if (current()) set({ check: { slug, path, result: null, status: 'error', errorMessage: detail(cause) } })
    }
  },

  clearCheck() {
    set({ check: null })
  },

  loadBuilds(gateway, slug, options) {
    const auth = captureAuthGeneration()
    const snapshot = get().buildsBySlug[slug]?.tasks
    const update = (patch: Partial<ContainerBuildListState>) => set(state => {
      const entry = state.buildsBySlug[slug]
      return entry ? { buildsBySlug: { ...state.buildsBySlug, [slug]: { ...entry, ...patch } } } : state
    })
    const previous = pendingBuilds.get(slug)
    if (previous?.gateway === gateway && previous.auth === auth && previous.snapshot === snapshot) {
      if (!options?.silent) update({ refreshing: true })
      return previous.promise
    }
    const operation = { gateway, auth, snapshot, promise: Promise.resolve() }
    pendingBuilds.set(slug, operation)
    const current = () => pendingBuilds.get(slug) === operation && auth === captureAuthGeneration()
    set(state => ({
      buildsBySlug: {
        ...state.buildsBySlug,
        [slug]: { status: snapshot === undefined ? 'loading' : 'ready', tasks: snapshot, refreshing: !options?.silent },
      },
    }))
    operation.promise = (async () => {
      try {
        const builds = await gateway.containers.listAppBuilds(slug)
        if (!current() || snapshot !== get().buildsBySlug[slug]?.tasks) return
        notifyBuildTransitions(snapshot ?? [], builds, slug)
        update({ tasks: builds, status: 'ready' })
      } catch (cause) {
        if (current()) update({ status: 'error', errorMessage: detail(cause) })
      } finally {
        if (pendingBuilds.get(slug) === operation) {
          pendingBuilds.delete(slug)
          if (auth === captureAuthGeneration()) update({ refreshing: false })
        }
      }
    })()
    return operation.promise
  },

  async previewBuild(gateway, slug, input) {
    const current = workspaceRequests.capture()
    set({ buildPreview: { slug, status: 'loading', plan: null, submitting: false, submitError: null } })
    try {
      const plan = await gateway.containers.previewAppBuild(slug, input)
      if (!current()) return null
      set({ buildPreview: { slug, status: 'ready', plan, submitting: false, submitError: null } })
      return plan
    } catch (cause) {
      if (current()) set({ buildPreview: { slug, status: 'error', errorMessage: detail(cause), plan: null, submitting: false, submitError: null } })
      return null
    }
  },

  async submitBuild(gateway, slug, input, options) {
    const current = workspaceRequests.capture()
    set((state) => ({
      buildPreview: state.buildPreview?.slug === slug
        ? { ...state.buildPreview, submitting: true, submitError: null }
        : state.buildPreview,
    }))
    try {
      const task = await gateway.containers.submitAppBuild(slug, input)
      if (!current()) return false
      set((state) => {
        const entry = state.buildsBySlug[slug]
        return {
          buildsBySlug: {
            ...state.buildsBySlug,
            [slug]: {
              ...entry,
              status: entry?.status === 'error' ? 'error' : 'ready',
              tasks: [task, ...(entry?.tasks ?? [])],
              refreshing: entry?.refreshing ?? false,
            },
          },
          buildPreview: state.buildPreview?.slug === slug
            ? { ...state.buildPreview, submitting: false }
            : state.buildPreview,
        }
      })
      useMessageStore.getState().notify({ tone: 'success', message: '已提交构建任务' })
      return true
    } catch (cause) {
      if (!current()) return false
      const message = detail(cause)
      set((state) => ({
        buildPreview: state.buildPreview?.slug === slug
          ? { ...state.buildPreview, submitting: false, submitError: message }
          : state.buildPreview,
      }))
      if (options?.notifyOnError) {
        useMessageStore.getState().notify({ tone: 'danger', message: `提交构建任务失败：${message}` })
      }
      return false
    }
  },

  async cancelBuild(gateway, slug, taskId) {
    const current = workspaceRequests.capture()
    try {
      await gateway.containers.cancelAppBuild(slug, taskId)
      if (!current()) return
      const previous = get().buildsBySlug[slug]?.tasks?.find((task) => task.id === taskId)
      await get().loadBuilds(gateway, slug, { silent: true })
      if (!current()) return
      const task = get().buildsBySlug[slug]?.tasks?.find((task) => task.id === taskId)
      if (!previous || !isContainerBuildActive(previous.state) || task?.state !== 'cancelled') {
        useMessageStore.getState().notify({ tone: 'info', message: '已提交取消构建请求' })
      }
    } catch (cause) {
      if (current()) useMessageStore.getState().notify({ tone: 'danger', message: `取消构建任务失败：${detail(cause)}` })
    }
  },

  clearBuildPreview() {
    set({ buildPreview: null })
  },

  async openBuildLogs(gateway, slug, taskId) {
    const auth = captureAuthGeneration()
    const loading: ContainerBuildLogsState = { slug, taskId, lines: [], next: 0, total: 0, status: 'loading' }
    const current = () => auth === captureAuthGeneration() && get().buildLogs[taskId] === loading
    set((state) => ({
      buildLogs: { ...state.buildLogs, [taskId]: loading },
    }))
    try {
      const report = await gateway.containers.getAppBuildLogs(slug, taskId, 0)
      if (!current()) return
      set((state) => ({
        buildLogs: { ...state.buildLogs, [taskId]: { slug, taskId, ...report, status: 'ready' } },
      }))
    } catch (cause) {
      if (!current()) return
      set((state) => ({
        buildLogs: { ...state.buildLogs, [taskId]: { ...loading, status: 'error', errorMessage: detail(cause) } },
      }))
    }
  },

  async loadBuildLogs(gateway, slug, taskId) {
    const current = get().buildLogs[taskId]
    if (!current || current.status === 'loading') return
    const auth = captureAuthGeneration()
    const loading: ContainerBuildLogsState = { ...current, status: 'loading' }
    const valid = () => auth === captureAuthGeneration() && get().buildLogs[taskId] === loading
    set((state) => ({ buildLogs: { ...state.buildLogs, [taskId]: loading } }))
    try {
      const report = await gateway.containers.getAppBuildLogs(slug, taskId, current.next)
      if (!valid()) return
      set((state) => ({
        buildLogs: {
          ...state.buildLogs,
          [taskId]: {
            ...current,
            lines: report.lines.length > 0 ? [...current.lines, ...report.lines] : current.lines,
            next: report.next,
            total: report.total,
            status: 'ready',
            errorMessage: undefined,
          },
        },
      }))
    } catch (cause) {
      if (!valid()) return
      set((state) => ({
        buildLogs: { ...state.buildLogs, [taskId]: { ...current, status: 'error', errorMessage: detail(cause) } },
      }))
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

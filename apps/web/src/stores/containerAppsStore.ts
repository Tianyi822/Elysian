import { create } from 'zustand'
import type { ComposeCheckResult, ContainerApp, ContainerAppFile } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/**
 * 容器应用工作区的界面状态。数据一律经 gateway.containers 的 adapter 取，
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
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway): Promise<void>
  create(gateway: ElysianGateway, input: { slug: string; displayName: string }): Promise<boolean>
  remove(gateway: ElysianGateway, slug: string): Promise<void>
  upload(gateway: ElysianGateway, slug: string, files: readonly File[]): Promise<void>
  save(gateway: ElysianGateway, slug: string, path: string, content: string): Promise<boolean>
  removeFile(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  runCheck(gateway: ElysianGateway, slug: string, path: string): Promise<void>
  clearCheck(): void
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

  async load(gateway) {
    // 首次加载才换整块加载态；已有清单时的再取走 refresh，不闪白屏。
    if (get().apps.length > 0) {
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

  async refresh(gateway) {
    set({ refreshing: true })
    try {
      set({ apps: await gateway.containers.listApps(), status: 'ready', refreshing: false })
    } catch (cause) {
      set({ refreshing: false, errorMessage: detail(cause) })
      useNotificationStore.getState().notify({ tone: 'danger', message: `读取应用工作区失败：${detail(cause)}` })
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
      set((state) => ({
        apps: state.apps.filter((app) => app.slug !== slug),
        check: state.check?.slug === slug ? null : state.check,
      }))
      useNotificationStore.getState().notify({ tone: 'success', message: `已删除工作区 ${slug} 及其目录` })
    } catch (cause) {
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
      await get().refresh(gateway)
      useNotificationStore.getState().notify({
        tone: 'success',
        message: uploaded.length === 1 ? `已上传 ${uploaded[0]}` : `已上传 ${uploaded.length} 个文件`,
      })
      // 上传完 compose 就顺手自检一次：用户传它就是为了确认引用路径。
      const compose = uploaded.filter(isComposeFile).pop()
      if (compose) void get().runCheck(gateway, slug, compose)
    } catch (cause) {
      useNotificationStore.getState().notify({ tone: 'danger', message: `上传文件失败：${detail(cause)}` })
    } finally {
      set({ writing: null })
    }
  },

  async save(gateway, slug, path, content) {
    set({ writing: appWritingKey(slug, path) })
    try {
      await gateway.containers.writeAppContent(slug, path, content)
      await get().refresh(gateway)
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

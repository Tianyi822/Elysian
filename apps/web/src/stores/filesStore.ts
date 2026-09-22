import { create } from 'zustand'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import type { ElysianGateway, FilePermissionInput } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useNotificationStore } from './notificationStore'

/**
 * 动作完成提示的演示标注：Docker 运行时动作已真实执行（cp/mv/tar/chmod 落到容器内
 * 文件系统），不再带标注；宿主机本地开发（内存演示）保留。括号形态追加在句子末尾，
 * 只用这一个来源。
 */
const MOCK_NOTE = isDockerRuntime() ? '' : 'mock，待接入真实执行'
const MOCK_SUFFIX = MOCK_NOTE ? `（${MOCK_NOTE}）` : ''

/** 剪贴板里暂存的条目与意图：copy 粘贴出副本，move 粘贴后源条目移除。 */
export type FilesClipboard = {
  path: string
  intent: 'copy' | 'move'
}

export type FilesState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 当前呈现（或加载失败）的目录，归一化后的绝对路径。 */
  path: string
  entries: readonly FileEntry[]
  errorMessage?: string
  /** 已算出的目录总大小（字节），按目录绝对路径记录；换目录不清，刷新即回种子。 */
  sizes: Record<string, number>
  /** 正在统计大小的目录路径。 */
  computingPaths: readonly string[]
  /** 文件剪贴板：只存内存，粘贴一次即清空，刷新即回空。 */
  clipboard?: FilesClipboard
  /** 搜索关键词；空串表示未在搜索，界面呈现当前目录列表。 */
  searchKeyword: string
  searchResults: readonly FileSearchResult[]
  searching: boolean
  load(gateway: ElysianGateway, path: string): Promise<void>
  computeSize(gateway: ElysianGateway, path: string): Promise<void>
  copyToClipboard(path: string): void
  moveToClipboard(path: string): void
  clearClipboard(): void
  paste(gateway: ElysianGateway, destDirPath: string): Promise<void>
  /** 重命名：名称校验与重名错误抛给调用方（对话框行内展示），成功后刷新并通知。 */
  rename(gateway: ElysianGateway, path: string, newName: string): Promise<void>
  compress(gateway: ElysianGateway, path: string): Promise<void>
  /** 应用权限与所有者：非法模式与空所有者的错误抛给调用方（对话框行内展示）。 */
  applyPermission(gateway: ElysianGateway, path: string, input: FilePermissionInput): Promise<void>
  /** 全树搜索：空关键词即清空结果回到目录列表；连续输入按次序号丢弃过期结果。 */
  search(gateway: ElysianGateway, keyword: string): Promise<void>
  /** 清空搜索：导航离开搜索态（进入某个结果、上一级等）时调用。 */
  clearSearch(): void
}

/**
 * 文件管理页的界面状态。目录路径的真源是路由（files/*），
 * 这里只保存「这个目录的列举结果」；连续双击产生的并发加载按次序号丢弃过期结果。
 * 目录大小不在列举里给出，按需经 computeSize 求和，结果按路径缓存。
 */
export const useFilesStore = create<FilesState>((set, get) => {
  let loadSequence = 0
  let searchSequence = 0

  const reload = async (gateway: ElysianGateway) => {
    await get().load(gateway, get().path)
  }

  const notify = (message: string, tone: 'success' | 'danger' = 'success') => {
    useNotificationStore.getState().notify({ tone, message })
  }

  return {
    status: 'idle',
    path: '/',
    entries: [],
    sizes: {},
    computingPaths: [],
    clipboard: undefined,
    searchKeyword: '',
    searchResults: [],
    searching: false,
    async load(gateway, path) {
      const sequence = ++loadSequence
      set({ status: 'loading', path, errorMessage: undefined })
      try {
        const entries = await gateway.files.list(path)
        if (sequence !== loadSequence) return
        set({ status: 'ready', entries })
      } catch (error) {
        if (sequence !== loadSequence) return
        set({
          status: 'error',
          entries: [],
          errorMessage: error instanceof Error ? error.message : '读取目录内容失败',
        })
      }
    },
    async computeSize(gateway, path) {
      const { computingPaths, sizes } = get()
      if (computingPaths.includes(path) || sizes[path] !== undefined) return
      set({ computingPaths: [...computingPaths, path] })
      try {
        const total = await gateway.files.size(path)
        set((state) => ({ sizes: { ...state.sizes, [path]: total } }))
      } catch (error) {
        notify(`统计目录大小失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger')
      } finally {
        set((state) => ({
          computingPaths: state.computingPaths.filter((item) => item !== path),
        }))
      }
    },
    copyToClipboard(path) {
      set({ clipboard: { path, intent: 'copy' } })
      notify(`已复制，去目标目录后点「粘贴」即生成副本${MOCK_SUFFIX}`)
    },
    moveToClipboard(path) {
      set({ clipboard: { path, intent: 'move' } })
      notify(`已就绪移动，去目标目录后点「粘贴」即移过去${MOCK_SUFFIX}`)
    },
    clearClipboard() {
      set({ clipboard: undefined })
    },
    async paste(gateway, destDirPath) {
      const { clipboard } = get()
      if (!clipboard) return
      const verb = clipboard.intent === 'copy' ? '复制' : '移动'
      try {
        if (clipboard.intent === 'copy') {
          const created = await gateway.files.copyEntry(clipboard.path, destDirPath)
          notify(`已复制为 ${created.name}${MOCK_SUFFIX}`)
        } else {
          const moved = await gateway.files.moveEntry(clipboard.path, destDirPath)
          notify(`已移动为 ${moved.name}${MOCK_SUFFIX}`)
        }
        set({ clipboard: undefined })
      } catch (error) {
        notify(`${verb}失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger')
      } finally {
        await reload(gateway)
      }
    },
    async rename(gateway, path, newName) {
      const renamed = await gateway.files.renameEntry(path, newName)
      await reload(gateway)
      notify(`已重命名为 ${renamed.name}${MOCK_SUFFIX}`)
    },
    async compress(gateway, path) {
      try {
        const archive = await gateway.files.compressEntry(path)
        notify(`已压缩为 ${archive.name}${MOCK_SUFFIX}`)
      } catch (error) {
        notify(`压缩失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger')
      } finally {
        await reload(gateway)
      }
    },
    async applyPermission(gateway, path, input) {
      await gateway.files.chmod(path, input)
      await reload(gateway)
      notify(
        `已把权限改为 ${input.mode}、所有者改为 ${input.owner}${input.recursive ? '（含子目录）' : ''}${MOCK_SUFFIX}`,
      )
    },
    async search(gateway, keyword) {
      const sequence = ++searchSequence
      set({ searchKeyword: keyword })
      if (!keyword.trim()) {
        if (sequence !== searchSequence) return
        set({ searchResults: [], searching: false })
        return
      }
      set({ searching: true })
      try {
        const results = await gateway.files.search(keyword)
        if (sequence !== searchSequence) return
        set({ searchResults: results, searching: false })
      } catch (error) {
        if (sequence !== searchSequence) return
        set({ searchResults: [], searching: false })
        notify(`搜索失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger')
      }
    },
    clearSearch() {
      set({ searchKeyword: '', searchResults: [], searching: false })
    },
  }
})

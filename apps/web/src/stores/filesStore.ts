import { create } from 'zustand'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import type { ElysianGateway, FilePermissionInput } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useMessageStore, type MessageTone } from './messageStore'
import { FileTransferError, isFileUploadConflict } from '../adapters/filesTransferError'

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

export type FileUploadItem = {
  name: string
  sizeBytes: number
  status: 'queued' | 'checking' | 'conflict' | 'uploading' | 'complete' | 'skipped' | 'error' | 'cancelled'
  progress: number
  errorMessage?: string
  replacing?: boolean
}

export type FilesUpload = {
  targetPath: string
  items: readonly FileUploadItem[]
  busy: boolean
  conflictIndex?: number
}

export type FilesDownload = {
  path: string
  name: string
  directory: boolean
  status: 'preparing' | 'started' | 'error' | 'cancelled'
  errorMessage?: string
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
  /** 同一目录的重新列举在途：旧列表留在屏上，只由它驱动表格遮罩。 */
  reloading: boolean
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
  download?: FilesDownload
  upload?: FilesUpload
  downloadEntry(gateway: ElysianGateway, path: string, entry: FileEntry): Promise<void>
  cancelDownload(): void
  dismissDownload(): void
  uploadFiles(gateway: ElysianGateway, targetPath: string, files: readonly File[]): Promise<void>
  decideUploadConflict(overwrite: boolean): void
  cancelUpload(): void
  dismissUpload(): void
}

/**
 * 文件管理页的界面状态。目录路径的真源是路由（files/*），
 * 这里只保存「这个目录的列举结果」；连续双击产生的并发加载按次序号丢弃过期结果。
 * 目录大小不在列举里给出，按需经 computeSize 求和，结果按路径缓存。
 */
export const useFilesStore = create<FilesState>((set, get) => {
  let loadSequence = 0
  let searchSequence = 0
  let sizeGeneration = 0
  let downloadSequence = 0
  let downloadController: AbortController | undefined
  let uploadController: AbortController | undefined
  let resolveConflict: ((decision: 'upload' | 'skip' | 'cancel') => void) | undefined

  const reload = async (gateway: ElysianGateway) => {
    await get().load(gateway, get().path)
  }

  const notify = (message: string, tone: MessageTone = 'success') => {
    useMessageStore.getState().notify({ tone, message })
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
    reloading: false,
    download: undefined,
    upload: undefined,
    async load(gateway, path) {
      const sequence = ++loadSequence
      // 同一个目录再列一次是刷新：旧列表留在屏上，只置 reloading；
      // 换目录才是新内容，走整块加载态。
      const inPlace = get().status === 'ready' && get().path === path
      set(inPlace ? { reloading: true, errorMessage: undefined } : { status: 'loading', path, reloading: false, errorMessage: undefined })
      try {
        const entries = await gateway.files.list(path)
        if (sequence !== loadSequence) return
        set({ status: 'ready', entries, reloading: false })
      } catch (error) {
        if (sequence !== loadSequence) return
        set({
          status: 'error',
          entries: [],
          reloading: false,
          errorMessage: error instanceof Error ? error.message : '读取目录内容失败',
        })
      }
    },
    async computeSize(gateway, path) {
      const generation = sizeGeneration
      const { computingPaths, sizes } = get()
      if (computingPaths.includes(path) || sizes[path] !== undefined) return
      set({ computingPaths: [...computingPaths, path] })
      try {
        const total = await gateway.files.size(path)
        if (generation !== sizeGeneration) return
        set((state) => ({ sizes: { ...state.sizes, [path]: total } }))
      } catch (error) {
        notify(`统计目录大小失败：${error instanceof Error ? error.message : '未知错误'}`, 'danger')
      } finally {
        if (generation !== sizeGeneration) return
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
    async downloadEntry(gateway, path, entry) {
      downloadController?.abort()
      const sequence = ++downloadSequence
      const controller = new AbortController()
      downloadController = controller
      set({ download: { path, name: entry.name, directory: entry.kind === 'directory', status: 'preparing' } })
      const fail = (error: Error) => {
        if (sequence !== downloadSequence || controller.signal.aborted) return
        if (get().download?.status === 'error' && get().download?.errorMessage === error.message) return
        set((state) => ({ download: state.download && { ...state.download, status: 'error', errorMessage: error.message } }))
        notify(`下载失败：${error.message}`, 'danger')
      }
      try {
        const download = await gateway.files.prepareDownload(path, controller.signal)
        if (controller.signal.aborted || sequence !== downloadSequence) return
        set((state) => ({ download: state.download && { ...state.download, name: download.name, status: 'started' } }))
        notify(`已开始下载 ${download.name}，请在浏览器中查看下载进度。`, 'info')
        gateway.files.startDownload(download, (error) => {
          if (sequence === downloadSequence && get().download) fail(error)
          else notify(`下载失败：${error.message}`, 'danger')
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error('准备下载失败'))
      }
    },
    cancelDownload() {
      if (get().download?.status !== 'preparing') return
      downloadController?.abort()
      ++downloadSequence
      set((state) => ({ download: state.download && { ...state.download, status: 'cancelled' } }))
      notify('已取消准备下载。', 'info')
    },
    dismissDownload() {
      if (get().download?.status === 'preparing') get().cancelDownload()
      set({ download: undefined })
    },
    async uploadFiles(gateway, targetPath, files) {
      if (get().upload?.busy || files.length === 0) return
      const controller = new AbortController()
      uploadController = controller
      set({ upload: { targetPath, busy: true, items: files.map((file) => ({ name: file.name, sizeBytes: file.size, progress: 0, status: 'queued' })) } })
      const updateItem = (index: number, patch: Partial<FileUploadItem>) => {
        set((state) => ({ upload: state.upload && { ...state.upload, items: state.upload.items.map((item, i) => i === index ? { ...item, ...patch } : item) } }))
      }
      let attemptedUpload = false
      let sessionExpired = false
      try {
        for (const [index, file] of files.entries()) {
          if (controller.signal.aborted) break
          let changed = false
          try {
            while (!controller.signal.aborted) {
              updateItem(index, { status: 'checking', progress: 0, errorMessage: undefined })
              const check = await gateway.files.checkUpload(targetPath, file.name, file.size, controller.signal)
              if (controller.signal.aborted) break
              if (check.state === 'replace' || changed) {
                if (changed) notify('上传目标已发生变化，请重新确认。', 'warning')
                updateItem(index, { status: 'conflict', replacing: check.state === 'replace', errorMessage: changed ? '目标已发生变化，请重新确认。' : undefined })
                const decision = await new Promise<'upload' | 'skip' | 'cancel'>((resolve) => {
                  resolveConflict = resolve
                  set((state) => ({ upload: state.upload && { ...state.upload, conflictIndex: index } }))
                })
                resolveConflict = undefined
                set((state) => ({ upload: state.upload && { ...state.upload, conflictIndex: undefined } }))
                if (decision === 'cancel' || controller.signal.aborted) break
                if (decision === 'skip') {
                  updateItem(index, { status: 'skipped', errorMessage: undefined })
                  break
                }
              }
              updateItem(index, { status: 'uploading', errorMessage: undefined })
              attemptedUpload = true
              try {
                await gateway.files.uploadFile(targetPath, file, check, check.state === 'replace', {
                  signal: controller.signal,
                  onProgress: (progress) => {
                    if (!controller.signal.aborted) updateItem(index, { progress })
                  },
                })
                updateItem(index, { status: 'complete', progress: 100 })
                break
              } catch (error) {
                if (!controller.signal.aborted && isFileUploadConflict(error)) {
                  changed = true
                  continue
                }
                throw error
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) updateItem(index, { status: 'error', errorMessage: error instanceof Error ? error.message : '上传失败' })
            if (error instanceof FileTransferError && error.status === 401) {
              sessionExpired = true
              break
            }
          }
        }
      } finally {
        resolveConflict = undefined
        uploadController = undefined
        set((state) => ({ upload: state.upload && {
          ...state.upload,
          busy: false,
          conflictIndex: undefined,
          items: state.upload.items.map((item) => ['queued', 'checking', 'conflict', 'uploading'].includes(item.status)
            ? { ...item, status: 'cancelled', errorMessage: item.status === 'uploading' ? '传输已取消，请刷新确认目标文件状态。' : undefined }
            : item),
        } }))
        const items = get().upload?.items ?? []
        const failures = items.filter((item) => item.status === 'error')
        const complete = items.filter((item) => item.status === 'complete').length
        if (failures.length) notify(`上传完成 ${complete} / ${items.length} 个文件；${failures.map((item) => `${item.name}：${item.errorMessage ?? '上传失败'}`).join('；')}`, 'danger')
        else notify(controller.signal.aborted ? `上传已取消，已上传 ${complete} / ${items.length} 个文件，请刷新确认文件状态。` : `已上传 ${complete} / ${items.length} 个文件`, controller.signal.aborted ? 'info' : 'success')
        // 即使最后一项失败或取消，先前成功及结果不确定的项仍需要回读。
        if (attemptedUpload) {
          ++sizeGeneration
          set({ sizes: {}, computingPaths: [] })
          if (!sessionExpired) {
            const keyword = get().searchKeyword
            await Promise.all([reload(gateway), keyword.trim() ? get().search(gateway, keyword) : Promise.resolve()])
          }
        }
      }
    },
    decideUploadConflict(overwrite) {
      resolveConflict?.(overwrite ? 'upload' : 'skip')
    },
    cancelUpload() {
      uploadController?.abort()
      resolveConflict?.('cancel')
    },
    dismissUpload() {
      if (!get().upload?.busy) set({ upload: undefined })
    },
  }
})

import type { LogListQuery, LogStorageStats, PlatformLogCategory, RuntimeLogEntry } from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS, formatLogBytes, logNumericSortKey } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'

type RuntimeLogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 清空完成提示的演示标注：容器内清的是服务器上的真实文件，不再带标注。 */
const MOCK_SUFFIX = isDockerRuntime() ? '' : '（演示数据，只清空内存中的演示日志）'

let loadRequestId = 0

function currentQuery(search: string): LogListQuery {
  const query: LogListQuery = {}
  const q = search.trim()
  if (q) query.q = q
  return query
}

type RuntimeLogState = {
  status: RuntimeLogStatus
  errorMessage: string | undefined
  /** 时间倒序（新 → 旧），与操作日志一致；界面按此顺序渲染，纵向滚动位置交给用户。 */
  entries: readonly RuntimeLogEntry[]
  total: number
  /** 因条数上限或读取字节预算未读全（更旧的内容还在服务器磁盘上）。 */
  truncated: boolean
  /** 无法解析而被跳过的行数与读取失败而被整份跳过的文件数（正常为 0）。 */
  skippedLines: number
  skippedFiles: number
  storage: LogStorageStats | undefined
  /** 搜索匹配 message 与 source，大小写不敏感；只改状态，由面板触发 load。 */
  search: string
  /** 刷新忙碌态：刷新期间按钮置灰；首屏加载走 status。 */
  refreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  /** 清空忙碌态：二次确认之后的删除请求进行中。 */
  clearing: boolean
  /** 待清空的类别（清空二次确认的目标）；null 表示弹窗关闭。 */
  clearTarget: PlatformLogCategory | null
  load: (gateway: ElysianGateway) => Promise<void>
  loadOlder: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  openClear: (category: PlatformLogCategory) => void
  closeClear: () => void
  clear: (gateway: ElysianGateway) => Promise<void>
}

export const useRuntimeLogStore = create<RuntimeLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  entries: [],
  total: 0,
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  storage: undefined,
  search: '',
  refreshing: false,
  loadingOlder: false,
  olderError: undefined,
  clearing: false,
  clearTarget: null,

  async load(gateway) {
    const requestId = ++loadRequestId
    const first = get().status !== 'ready'
    set({
      refreshing: true,
      ...(first ? { status: 'loading' as const } : {}),
      errorMessage: undefined,
      olderError: undefined,
    })
    try {
      const report = await gateway.logs.runtimeLog(currentQuery(get().search))
      if (requestId !== loadRequestId) return
      set({
        status: 'ready',
        entries: report.entries,
        total: report.total,
        truncated: report.truncated,
        skippedLines: report.skippedLines,
        skippedFiles: report.skippedFiles,
        storage: report.storage,
        refreshing: false,
      })
    } catch (error) {
      if (requestId !== loadRequestId) return
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '运行日志加载失败',
        refreshing: false,
      })
    }
  },

  async loadOlder(gateway) {
    const { truncated, entries, loadingOlder, refreshing, search } = get()
    if (!truncated || entries.length === 0 || loadingOlder || refreshing) return
    const last = entries[entries.length - 1]!
    set({ loadingOlder: true, olderError: undefined })
    try {
      const report = await gateway.logs.runtimeLog({
        ...currentQuery(search),
        before: last.at,
        beforeId: logNumericSortKey(last.id),
      })
      set({
        entries: [...get().entries, ...report.entries],
        truncated: report.truncated,
        loadingOlder: false,
      })
    } catch (error) {
      set({
        olderError: error instanceof Error ? error.message : '更早的记录加载失败',
        loadingOlder: false,
      })
    }
  },

  setSearch(search) {
    set({ search })
  },

  openClear(category) {
    set({ clearTarget: category })
  },

  closeClear() {
    set({ clearTarget: null })
  },

  async clear(gateway) {
    const category = get().clearTarget
    if (!category || get().clearing) return
    set({ clearing: true })
    try {
      const report = await gateway.logs.clearLogs(category)
      useMessageStore.getState().notify({
        tone: 'success',
        message: `${PLATFORM_LOG_CATEGORY_LABELS[report.category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}${MOCK_SUFFIX}`,
      })
      set({ clearTarget: null, clearing: false })
      // 清空后重新读取：正常会读到一条「已清空」留痕（自指留痕），不是空表。
      await get().load(gateway)
    } catch (error) {
      // 失败保留弹窗（用户可重试）：只解除忙碌态，不动 clearTarget。
      useMessageStore.getState().notify({
        tone: 'danger',
        message: `清空失败：${error instanceof Error ? error.message : '未知错误'}`,
      })
      set({ clearing: false })
    }
  },
}))

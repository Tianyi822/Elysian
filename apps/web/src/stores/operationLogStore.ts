import type {
  LogStorageStats,
  OperationLogCategory,
  OperationLogEntry,
  OperationLogListQuery,
  OperationLogOutcome,
  PlatformLogCategory,
} from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS, formatLogBytes } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { createLogReader } from './logReader'
import { useMessageStore } from './messageStore'

type OperationLogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 分类筛选取值：all 表示不按分类过滤。 */
export type OperationLogCategoryFilter = 'all' | OperationLogCategory

/** 结果筛选取值：all 表示不按结果过滤。 */
export type OperationLogResultFilter = 'all' | OperationLogOutcome

/** 清空完成提示的演示标注：容器内清的是服务器上的真实文件，不再带标注。 */
const MOCK_SUFFIX = isDockerRuntime() ? '' : '（演示数据，只清空内存中的演示日志）'

function currentQuery(state: {
  categoryFilter: OperationLogCategoryFilter
  resultFilter: OperationLogResultFilter
  search: string
}): OperationLogListQuery {
  const query: OperationLogListQuery = {}
  if (state.categoryFilter !== 'all') query.category = state.categoryFilter
  if (state.resultFilter !== 'all') query.result = state.resultFilter
  const q = state.search.trim()
  if (q) query.q = q
  return query
}

/**
 * 操作日志面板的界面状态，与运行日志同构（唯一差别是列表倒序、多两个筛选维度）。
 * 容器内条目与存储统计来自服务端的真实采集（每次操作由服务端中间件记录，客户端无法投稿）；
 * 宿主机本地开发读的是内存演示种子，面板据此常驻「演示数据」标识。
 */
type OperationLogState = {
  status: OperationLogStatus
  errorMessage: string | undefined
  /** 时间倒序（新 → 旧），与登录日志一致。 */
  entries: readonly OperationLogEntry[]
  total: number
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  storage: LogStorageStats | undefined
  /** 分类筛选；与结果、搜索一样只改状态，由面板触发 load。 */
  categoryFilter: OperationLogCategoryFilter
  resultFilter: OperationLogResultFilter
  /** 搜索匹配 action、summary 与 target，大小写不敏感。 */
  search: string
  /** 刷新忙碌态：刷新期间按钮置灰；首屏加载走 status（与运行日志同构）。 */
  refreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  /** 清空忙碌态：二次确认之后的删除请求进行中。 */
  clearing: boolean
  /** 待清空的类别（清空二次确认的目标）；null 表示弹窗关闭。 */
  clearTarget: PlatformLogCategory | null
  load: (gateway: ElysianGateway, options?: { silent?: boolean }) => Promise<void>
  loadOlder: (gateway: ElysianGateway) => Promise<void>
  setCategoryFilter: (filter: OperationLogCategoryFilter) => void
  setResultFilter: (filter: OperationLogResultFilter) => void
  setSearch: (search: string) => void
  openClear: (category: PlatformLogCategory) => void
  closeClear: () => void
  clear: (gateway: ElysianGateway) => Promise<void>
  resetSession: () => void
}

export const useOperationLogStore = create<OperationLogState>((set, get) => {
  let activeClear: symbol | undefined
  const reader = createLogReader<OperationLogEntry, OperationLogListQuery, OperationLogState>({
    get, set,
    queryFor: currentQuery,
    read: (gateway, query) => gateway.logs.operationLogs(query),
    timeOf: entry => entry.at,
    blocked: state => state.clearing,
    trackStorage: true,
  })
  const initialDisplay = {
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
  } satisfies Partial<OperationLogState>

  return {
    ...initialDisplay,
    categoryFilter: 'all',
    resultFilter: 'all',
    load: reader.load,
    loadOlder: reader.loadOlder,

    resetSession() {
      activeClear = undefined
      reader.invalidateReads({ dropSnapshot: true })
      set(initialDisplay)
    },

    setCategoryFilter(categoryFilter) {
      set({ categoryFilter, ...(categoryFilter !== get().categoryFilter ? reader.invalidateReads() : {}) })
    },

    setResultFilter(resultFilter) {
      set({ resultFilter, ...(resultFilter !== get().resultFilter ? reader.invalidateReads() : {}) })
    },

    setSearch(search) {
      set({ search, ...(search.trim() !== get().search.trim() ? reader.invalidateReads() : {}) })
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
      const operation = Symbol()
      activeClear = operation
      set({ ...reader.invalidateReads({ dropSnapshot: true }), clearing: true })
      try {
        const report = await gateway.logs.clearLogs(category)
        if (activeClear !== operation) return
        useMessageStore.getState().notify({
          tone: 'success',
          message: `${PLATFORM_LOG_CATEGORY_LABELS[report.category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}${MOCK_SUFFIX}`,
        })
        activeClear = undefined
        set({ clearTarget: null, clearing: false })
        await get().load(gateway, { silent: true })
      } catch (error) {
        if (activeClear !== operation) return
        activeClear = undefined
        useMessageStore.getState().notify({
          tone: 'danger',
          message: `清空失败：${error instanceof Error ? error.message : '未知错误'}`,
        })
        set({ clearing: false })
      }
    },
  }
})

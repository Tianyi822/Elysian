import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type {
  LogStorageStats,
  OperationLogCategory,
  OperationLogEntry,
  OperationLogListQuery,
  OperationLogOutcome,
  PlatformLogCategory,
} from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS, formatLogBytes, logNumericSortKey } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'

type OperationLogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 分类筛选取值：all 表示不按分类过滤。 */
export type OperationLogCategoryFilter = 'all' | OperationLogCategory

/** 结果筛选取值：all 表示不按结果过滤。 */
export type OperationLogResultFilter = 'all' | OperationLogOutcome

/** 清空完成提示的演示标注：容器内清的是服务器上的真实文件，不再带标注。 */
const MOCK_SUFFIX = isDockerRuntime() ? '' : '（演示数据，只清空内存中的演示日志）'

type ReadScope = { gateway: ElysianGateway; key: string; auth: number; snapshot: readonly OperationLogEntry[] }
let loaded: ReadScope | undefined
let pendingLoad: (ReadScope & { promise: Promise<void> }) | undefined
let pendingOlder: ReadScope | undefined

function matchesScope(previous: ReadScope | undefined, next: ReadScope): boolean {
  return previous?.gateway === next.gateway && previous.key === next.key && previous.auth === next.auth && previous.snapshot === next.snapshot
}

function invalidateReads() {
  pendingLoad = undefined
  pendingOlder = undefined
  return { refreshing: false, loadingOlder: false, olderError: undefined }
}

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
}

export const useOperationLogStore = create<OperationLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  entries: [],
  total: 0,
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  storage: undefined,
  categoryFilter: 'all',
  resultFilter: 'all',
  search: '',
  refreshing: false,
  loadingOlder: false,
  olderError: undefined,
  clearing: false,
  clearTarget: null,

  load(gateway) {
    if (get().clearing) return Promise.resolve()
    const query = currentQuery(get())
    const scope: ReadScope = { gateway, key: JSON.stringify(query), auth: captureAuthGeneration(), snapshot: get().entries }
    if (pendingLoad && matchesScope(pendingLoad, scope)) {
      return pendingLoad.promise
    }
    const first = get().status !== 'ready'
    const operation = { ...scope, promise: Promise.resolve() }
    pendingLoad = operation
    pendingOlder = undefined
    const current = () => pendingLoad === operation && scope.auth === captureAuthGeneration() && scope.key === JSON.stringify(currentQuery(get()))
    const acceptsResult = () => current() && scope.snapshot === get().entries
    set({ refreshing: true, status: first ? 'loading' : 'ready', errorMessage: undefined, loadingOlder: false, olderError: undefined })
    operation.promise = (async () => {
      try {
        const report = await gateway.logs.operationLogs(query)
        if (!acceptsResult()) return
        loaded = { ...scope, snapshot: report.entries }
        set({ status: 'ready', entries: report.entries, total: report.total, truncated: report.truncated, skippedLines: report.skippedLines, skippedFiles: report.skippedFiles, storage: report.storage, })
      } catch (error) {
        if (acceptsResult()) set({ status: first ? 'error' : 'ready', errorMessage: error instanceof Error ? error.message : '日志读取失败' })
      } finally {
        if (pendingLoad === operation) {
          const ownsBusy = current()
          pendingLoad = undefined
          if (ownsBusy) set({ refreshing: false })
        }
      }
    })()
    return operation.promise
  },

  async loadOlder(gateway) {
    const { truncated, entries, loadingOlder, refreshing, clearing } = get()
    if (!truncated || entries.length === 0 || loadingOlder || refreshing || clearing) return
    const query = currentQuery(get())
    const scope: ReadScope = { gateway, key: JSON.stringify(query), auth: captureAuthGeneration(), snapshot: entries }
    if (!matchesScope(loaded, scope)) return
    const last = entries[entries.length - 1]!
    pendingOlder = scope
    const current = () => pendingOlder === scope && scope.auth === captureAuthGeneration() && scope.key === JSON.stringify(currentQuery(get()))
    const acceptsResult = () => current() && scope.snapshot === get().entries
    set({ loadingOlder: true, olderError: undefined })
    try {
      const report = await gateway.logs.operationLogs({
        ...query,
        before: last.at,
        beforeId: logNumericSortKey(last.id),
      })
      if (!acceptsResult()) return
      const snapshot = [...entries, ...report.entries]
      loaded = { ...scope, snapshot }
      set({ entries: snapshot, truncated: report.truncated })
    } catch (error) {
      if (acceptsResult()) set({ olderError: error instanceof Error ? error.message : '更早的记录加载失败' })
    } finally {
      if (pendingOlder === scope) {
        const ownsBusy = current()
        pendingOlder = undefined
        if (ownsBusy) set({ loadingOlder: false })
      }
    }
  },

  setCategoryFilter(categoryFilter) {
    set({ categoryFilter, ...(categoryFilter !== get().categoryFilter ? invalidateReads() : {}) })
  },

  setResultFilter(resultFilter) {
    set({ resultFilter, ...(resultFilter !== get().resultFilter ? invalidateReads() : {}) })
  },

  setSearch(search) {
    set({ search, ...(search.trim() !== get().search.trim() ? invalidateReads() : {}) })
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
    loaded = undefined
    set({ ...invalidateReads(), clearing: true })
    try {
      const report = await gateway.logs.clearLogs(category)
      useMessageStore.getState().notify({
        tone: 'success',
        message: `${PLATFORM_LOG_CATEGORY_LABELS[report.category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}${MOCK_SUFFIX}`,
      })
      set({ clearTarget: null, clearing: false })
      await get().load(gateway, { silent: true })
    } catch (error) {
      useMessageStore.getState().notify({
        tone: 'danger',
        message: `清空失败：${error instanceof Error ? error.message : '未知错误'}`,
      })
      set({ clearing: false })
    }
  },
}))

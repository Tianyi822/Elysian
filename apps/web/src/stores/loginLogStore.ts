import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { LoginLogEntry, LoginLogListQuery, LoginLogStatus } from '@elysian/contracts'
import { logNumericSortKey } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

type LoginLogLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 登录状态筛选取值：all 表示不按结果过滤。 */
export type LoginLogStatusFilter = 'all' | LoginLogStatus

type ReadScope = { gateway: ElysianGateway; key: string; auth: number; snapshot: readonly LoginLogEntry[] }
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
  statusFilter: LoginLogStatusFilter
  search: string
}): LoginLogListQuery {
  const query: LoginLogListQuery = {}
  if (state.statusFilter !== 'all') query.status = state.statusFilter
  const q = state.search.trim()
  if (q) query.q = q
  return query
}

type LoginLogState = {
  status: LoginLogLoadStatus
  errorMessage: string | undefined
  entries: readonly LoginLogEntry[]
  total: number
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  /** 状态筛选；与搜索一样只改状态，由面板触发 load。 */
  statusFilter: LoginLogStatusFilter
  /** 搜索按 IP、归属地与用户代理匹配。 */
  search: string
  refreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  load: (gateway: ElysianGateway, options?: { silent?: boolean }) => Promise<void>
  loadOlder: (gateway: ElysianGateway) => Promise<void>
  setStatusFilter: (statusFilter: LoginLogStatusFilter) => void
  setSearch: (search: string) => void
}

export const useLoginLogStore = create<LoginLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  entries: [],
  total: 0,
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  statusFilter: 'all',
  search: '',
  refreshing: false,
  loadingOlder: false,
  olderError: undefined,

  load(gateway) {
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
        const report = await gateway.logs.loginLogs(query)
        if (!acceptsResult()) return
        loaded = { ...scope, snapshot: report.entries }
        set({ status: 'ready', entries: report.entries, total: report.total, truncated: report.truncated, skippedLines: report.skippedLines, skippedFiles: report.skippedFiles, })
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
    const { truncated, entries, loadingOlder, refreshing } = get()
    if (!truncated || entries.length === 0 || loadingOlder || refreshing) return
    const query = currentQuery(get())
    const scope: ReadScope = { gateway, key: JSON.stringify(query), auth: captureAuthGeneration(), snapshot: entries }
    if (!matchesScope(loaded, scope)) return
    const last = entries[entries.length - 1]!
    pendingOlder = scope
    const current = () => pendingOlder === scope && scope.auth === captureAuthGeneration() && scope.key === JSON.stringify(currentQuery(get()))
    const acceptsResult = () => current() && scope.snapshot === get().entries
    set({ loadingOlder: true, olderError: undefined })
    try {
      const report = await gateway.logs.loginLogs({
        ...query,
        before: last.time,
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

  setStatusFilter(statusFilter) {
    set({ statusFilter, ...(statusFilter !== get().statusFilter ? invalidateReads() : {}) })
  },

  setSearch(search) {
    set({ search, ...(search.trim() !== get().search.trim() ? invalidateReads() : {}) })
  },
}))

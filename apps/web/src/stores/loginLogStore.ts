import type { LoginLogEntry, LoginLogListQuery, LoginLogStatus } from '@elysian/contracts'
import { logNumericSortKey } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

type LoginLogLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 登录状态筛选取值：all 表示不按结果过滤。 */
export type LoginLogStatusFilter = 'all' | LoginLogStatus

let loadRequestId = 0

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
  load: (gateway: ElysianGateway) => Promise<void>
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
      const report = await gateway.logs.loginLogs(currentQuery(get()))
      if (requestId !== loadRequestId) return
      set({
        status: 'ready',
        entries: report.entries,
        total: report.total,
        truncated: report.truncated,
        skippedLines: report.skippedLines,
        skippedFiles: report.skippedFiles,
        refreshing: false,
      })
    } catch (error) {
      if (requestId !== loadRequestId) return
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '登录日志加载失败',
        refreshing: false,
      })
    }
  },

  async loadOlder(gateway) {
    const { truncated, entries, loadingOlder, refreshing } = get()
    if (!truncated || entries.length === 0 || loadingOlder || refreshing) return
    const last = entries[entries.length - 1]!
    set({ loadingOlder: true, olderError: undefined })
    try {
      const report = await gateway.logs.loginLogs({
        ...currentQuery(get()),
        before: last.time,
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

  setStatusFilter(statusFilter) {
    set({ statusFilter })
  },

  setSearch(search) {
    set({ search })
  },
}))

import type { LoginLogEntry, LoginLogListQuery, LoginLogStatus } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { createLogReader } from './logReader'

type LoginLogLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 登录状态筛选取值：all 表示不按结果过滤。 */
export type LoginLogStatusFilter = 'all' | LoginLogStatus

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
  resetSession: () => void
}

export const useLoginLogStore = create<LoginLogState>((set, get) => {
  const reader = createLogReader<LoginLogEntry, LoginLogListQuery, LoginLogState>({
    get, set,
    queryFor: currentQuery,
    read: (gateway, query) => gateway.logs.loginLogs(query),
    timeOf: entry => entry.time,
  })
  const initialDisplay = {
    status: 'idle',
    errorMessage: undefined,
    entries: [],
    total: 0,
    truncated: false,
    skippedLines: 0,
    skippedFiles: 0,
    search: '',
    refreshing: false,
    loadingOlder: false,
    olderError: undefined,
  } satisfies Partial<LoginLogState>

  return {
    ...initialDisplay,
    statusFilter: 'all',
    load: reader.load,
    loadOlder: reader.loadOlder,

    resetSession() {
      reader.invalidateReads({ dropSnapshot: true })
      set(initialDisplay)
    },

    setStatusFilter(statusFilter) {
      set({ statusFilter, ...(statusFilter !== get().statusFilter ? reader.invalidateReads() : {}) })
    },

    setSearch(search) {
      set({ search, ...(search.trim() !== get().search.trim() ? reader.invalidateReads() : {}) })
    },
  }
})

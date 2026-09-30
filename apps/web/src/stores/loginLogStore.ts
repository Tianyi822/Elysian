import type { LoginLogEntry, LoginLogStatus } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

type LoginLogLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 登录状态筛选取值：all 表示不按结果过滤。 */
export type LoginLogStatusFilter = 'all' | LoginLogStatus

type LoginLogState = {
  status: LoginLogLoadStatus
  errorMessage: string | undefined
  entries: readonly LoginLogEntry[]
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  /** 状态筛选；与搜索一样只影响视图，不动数据。 */
  statusFilter: LoginLogStatusFilter
  /** 搜索按 IP、归属地与用户代理匹配。 */
  search: string
  load: (gateway: ElysianGateway) => Promise<void>
  setStatusFilter: (statusFilter: LoginLogStatusFilter) => void
  setSearch: (search: string) => void
}

export const useLoginLogStore = create<LoginLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  entries: [],
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  statusFilter: 'all',
  search: '',

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const report = await gateway.logs.loginLogs()
      set({
        status: 'ready',
        entries: report.entries,
        truncated: report.truncated,
        skippedLines: report.skippedLines,
        skippedFiles: report.skippedFiles,
      })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : '登录日志加载失败' })
    }
  },

  setStatusFilter(statusFilter) {
    set({ statusFilter })
  },

  setSearch(search) {
    set({ search })
  },
}))

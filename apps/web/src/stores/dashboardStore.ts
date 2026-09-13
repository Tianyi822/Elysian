import type { AuditRecord } from '@elysian/contracts'
import { create } from 'zustand'
import {
  aggregateStatCards,
  buildModuleCards,
  buildSeverityDistribution,
} from '../adapters/mock/aggregations'
import type { ModuleCard, SeverityDistribution, StatCards } from '../adapters/mock/aggregations'
import { BASE_DATE, createIncidentTrend } from '../adapters/mock/timeseries'
import type { DailyIncidents, TimeRange } from '../adapters/mock/timeseries'
import type { ElysianGateway } from '../contracts/adapters'

export type DashboardState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  refreshing: boolean
  stats?: StatCards
  modules?: ModuleCard[]
  distribution?: SeverityDistribution
  /** 完整 30 天序列；时间范围切换只做切片，不重新加载。 */
  trend?: readonly DailyIncidents[]
  auditRecords?: readonly AuditRecord[]
  range: TimeRange
  errorMessage?: string
  load: (gateway: ElysianGateway) => Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
  setRange: (range: TimeRange) => void
}

export async function loadDashboard(gateway: ElysianGateway) {
  const [incidentList, runs, moduleStatuses, approvals, audit, skills] = await Promise.all([
    gateway.incidents.listRows({}),
    gateway.runs.list(),
    gateway.runs.listModuleStatuses(),
    gateway.approvals.list(),
    gateway.audit.list(),
    gateway.skills.list(),
  ])

  const input = {
    incidentRows: incidentList.rows,
    runs,
    approvals,
    audit,
    skills,
  }

  return {
    stats: aggregateStatCards(input, BASE_DATE),
    modules: buildModuleCards({ incidentRows: incidentList.rows, runs, approvals, moduleStatuses }),
    distribution: buildSeverityDistribution(incidentList.rows),
    trend: createIncidentTrend(),
    auditRecords: audit,
  }
}

export const useDashboardStore = create<DashboardState>((set) => ({
  status: 'idle',
  refreshing: false,
  range: '7d',
  async load(gateway) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const data = await loadDashboard(gateway)
      set({ status: 'ready', ...data })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取仪表盘数据失败',
      })
    }
  },
  async refresh(gateway) {
    // 刷新时保留已有内容，只标记正在刷新，避免整屏闪烁。
    set({ refreshing: true, errorMessage: undefined })
    try {
      const data = await loadDashboard(gateway)
      set({ status: 'ready', ...data, refreshing: false })
    } catch (error) {
      set({
        refreshing: false,
        errorMessage: error instanceof Error ? error.message : '刷新仪表盘数据失败',
      })
    }
  },
  setRange(range) {
    set({ range })
  },
}))

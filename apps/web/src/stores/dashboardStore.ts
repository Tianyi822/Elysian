import type { AuditRecord, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import { aggregateStatCards, buildModuleCards } from '../adapters/mock/aggregations'
import type { ModuleCard, StatCards } from '../adapters/mock/aggregations'
import { BASE_DATE } from '../adapters/mock/dataset'
import {
  appendLiveResourceSample,
  getLiveResources,
} from '../adapters/mock/resourceMetrics'
import type { DailyResourceMetrics, TimeRange } from '../adapters/mock/resourceMetrics'
import type { ElysianGateway } from '../contracts/adapters'
import { onStreamEvent } from './eventStreamStore'

export type DashboardState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  refreshing: boolean
  stats?: StatCards
  modules?: ModuleCard[]
  /** 完整 30 天单机资源序列；时间范围切换只做切片，实时采样会滚动追加。 */
  resources?: readonly DailyResourceMetrics[]
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
    resources: getLiveResources(),
    auditRecords: audit,
  }
}

/*
 * 事件回灌：事件流是仪表盘的心跳。resource/sample 滚动追加资源序列，
 * incident/created 增量更新指标卡与模块卡（数据集侧由 gateway 落库，刷新后一致）。
 */
let detachLive: Unsubscribe | undefined
/** 已增量应用过的新事故标识：同一事故的重复事件（重连重放）不推高两次。 */
const appliedLiveIncidents = new Set<string>()

function attachLiveEvents(): void {
  if (detachLive) return
  detachLive = onStreamEvent((event) => {
    const { status } = useDashboardStore.getState()
    if (status !== 'ready') return

    if (event.name === 'incident/created') {
      if (appliedLiveIncidents.has(event.payload.incidentId)) return
      appliedLiveIncidents.add(event.payload.incidentId)
      useDashboardStore.setState((state) => ({
        stats: state.stats && {
          ...state.stats,
          totalIncidents: state.stats.totalIncidents + 1,
          openIncidents: state.stats.openIncidents + 1,
        },
        modules: state.modules?.map((module) =>
          event.payload.moduleId && module.moduleId === event.payload.moduleId
            ? { ...module, activeIncidents: module.activeIncidents + 1 }
            : module,
        ),
      }))
      return
    }

    if (event.name === 'resource/sample') {
      appendLiveResourceSample(event.payload)
      useDashboardStore.setState({ resources: [...getLiveResources()] })
    }
  })
}

export const useDashboardStore = create<DashboardState>((set) => ({
  status: 'idle',
  refreshing: false,
  range: '7d',
  async load(gateway) {
    attachLiveEvents()
    appliedLiveIncidents.clear()
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

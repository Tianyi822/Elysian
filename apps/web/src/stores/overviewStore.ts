import { RISK_RANK, SEVERITIES, SEVERITY_RANK } from '@elysian/contracts'
import type { AuditRecord, RiskLevel, Severity } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

/** 总览是唯一一处跨领域聚合：数据全部经适配层取，不读其他页面的内部状态。 */
export type ServiceHealth = {
  service: string
  openCount: number
  /** 未归档事故里最严重的一档；没有未归档事故时为 undefined，表示正常。 */
  worstSeverity?: Severity
}

export type OverviewData = {
  /** 事故条数：只统计事故，不含告警与待处理任务。 */
  incidentTotal: number
  /** 事件中心的总条数，含告警与待处理任务，用于说明两个数字的差别。 */
  eventTotal: number
  severityCounts: Record<Severity, number>
  runningRuns: number
  waitingRuns: number
  activeModules: number
  pendingApprovals: number
  highestPendingRisk?: RiskLevel
  serviceHealth: readonly ServiceHealth[]
  recentActivity: readonly AuditRecord[]
}

const CLOSED_STATUSES = new Set(['resolved', 'closed'])

export async function loadOverview(gateway: ElysianGateway): Promise<OverviewData> {
  const [incidentList, runs, moduleStatuses, approvals, audit] = await Promise.all([
    gateway.incidents.listRows({}),
    gateway.runs.list(),
    gateway.runs.listModuleStatuses(),
    gateway.approvals.list(),
    gateway.audit.list(),
  ])

  const incidents = incidentList.rows.filter((row) => row.kind === 'incident')

  // 严重等级分布按事故统计：告警与待处理任务不是事故，混进来会让「事故严重等级」失真。
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
    Severity,
    number
  >
  for (const incident of incidents) {
    severityCounts[incident.severity] += 1
  }

  const byService = new Map<string, { openCount: number; worstSeverity?: Severity }>()
  for (const incident of incidents) {
    const current = byService.get(incident.service) ?? { openCount: 0 }
    if (incident.status && !CLOSED_STATUSES.has(incident.status)) {
      current.openCount += 1
      if (
        current.worstSeverity === undefined ||
        SEVERITY_RANK[incident.severity] < SEVERITY_RANK[current.worstSeverity]
      ) {
        current.worstSeverity = incident.severity
      }
    }
    byService.set(incident.service, current)
  }

  const serviceHealth: ServiceHealth[] = [...byService.entries()]
    .map(([service, value]) => ({
      service,
      openCount: value.openCount,
      ...(value.worstSeverity ? { worstSeverity: value.worstSeverity } : {}),
    }))
    .sort((a, b) => b.openCount - a.openCount || a.service.localeCompare(b.service))

  const pending = approvals.filter((approval) => approval.status === 'pending')
  const highestPendingRisk = pending.reduce<RiskLevel | undefined>((worst, approval) => {
    if (!worst) return approval.riskLevel
    return RISK_RANK[approval.riskLevel] > RISK_RANK[worst] ? approval.riskLevel : worst
  }, undefined)

  return {
    incidentTotal: incidents.length,
    eventTotal: incidentList.total,
    severityCounts,
    runningRuns: runs.filter((run) => run.status === 'running').length,
    waitingRuns: runs.filter((run) => run.status === 'waiting-approval').length,
    activeModules: moduleStatuses.filter((module) => module.status === 'running').length,
    pendingApprovals: pending.length,
    ...(highestPendingRisk ? { highestPendingRisk } : {}),
    serviceHealth,
    recentActivity: audit.slice(0, 8),
  }
}

type OverviewState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data?: OverviewData
  errorMessage?: string
  refreshing: boolean
  load: (gateway: ElysianGateway) => Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
}

export const useOverviewStore = create<OverviewState>((set) => ({
  status: 'idle',
  refreshing: false,
  async load(gateway) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const data = await loadOverview(gateway)
      set({ status: 'ready', data })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取总览数据失败',
      })
    }
  },
  async refresh(gateway) {
    // 刷新时保留已有内容，只标记正在刷新，避免整屏闪烁。
    set({ refreshing: true, errorMessage: undefined })
    try {
      const data = await loadOverview(gateway)
      set({ status: 'ready', data, refreshing: false })
    } catch (error) {
      set({
        refreshing: false,
        errorMessage: error instanceof Error ? error.message : '刷新总览数据失败',
      })
    }
  },
}))

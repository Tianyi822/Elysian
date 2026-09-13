import {
  RISK_RANK,
  RESPONSIBILITY_MODULES,
  SEVERITIES,
} from '@elysian/contracts'
import type {
  AgentRun,
  ApprovalRequest,
  AuditRecord,
  IncidentListRow,
  ModuleStatus,
  RiskLevel,
  RunStatus,
  Severity,
  Skill,
} from '@elysian/contracts'

/**
 * 仪表盘的聚合纯函数。输入全部是契约类型，输出是界面直接消费的形状；
 * 不依赖 mock 数据集本身，测试可以用手工构造的小数据集独立验证。
 *
 * 「独立聚合」是验收要求：界面数值必须能从数据集用另一套算法核对，
 * 因此这里的函数不允许被测试当作期望值的来源。
 */

const CLOSED_STATUSES = new Set(['resolved', 'closed'])

export type StatCardsInput = {
  incidentRows: readonly IncidentListRow[]
  runs: readonly AgentRun[]
  approvals: readonly ApprovalRequest[]
  audit: readonly AuditRecord[]
  skills: readonly Skill[]
}

export type StatCards = {
  totalIncidents: number
  openIncidents: number
  runningRuns: number
  waitingRuns: number
  pendingApprovals: number
  highestPendingRisk?: RiskLevel
  todayAuditEvents: number
  enabledSkills: number
  affectedServices: number
}

function isIncident(row: IncidentListRow): boolean {
  return row.kind === 'incident'
}

function isOpenIncident(row: IncidentListRow): boolean {
  return isIncident(row) && row.status !== undefined && !CLOSED_STATUSES.has(row.status)
}

export function aggregateStatCards(input: StatCardsInput, todayIso: string): StatCards {
  const incidents = input.incidentRows.filter(isIncident)
  const pending = input.approvals.filter((approval) => approval.status === 'pending')

  const highestPendingRisk = pending.reduce<RiskLevel | undefined>((worst, approval) => {
    if (!worst) return approval.riskLevel
    return RISK_RANK[approval.riskLevel] > RISK_RANK[worst] ? approval.riskLevel : worst
  }, undefined)

  const affectedServices = new Set(
    input.incidentRows.filter(isOpenIncident).map((row) => row.service),
  ).size

  return {
    totalIncidents: incidents.length,
    openIncidents: incidents.filter((row) => row.status === 'open').length,
    runningRuns: input.runs.filter((run) => run.status === 'running').length,
    waitingRuns: input.runs.filter((run) => run.status === 'waiting-approval').length,
    pendingApprovals: pending.length,
    ...(highestPendingRisk ? { highestPendingRisk } : {}),
    todayAuditEvents: input.audit.filter((record) => record.at.slice(0, 10) === todayIso).length,
    enabledSkills: input.skills.filter((skill) => skill.enabled).length,
    affectedServices,
  }
}

export type ModuleCardsInput = {
  incidentRows: readonly IncidentListRow[]
  runs: readonly AgentRun[]
  approvals: readonly ApprovalRequest[]
  moduleStatuses: readonly ModuleStatus[]
}

export type ModuleCard = {
  moduleId: string
  /** 未归档的关联事故数。 */
  activeIncidents: number
  /** 当前活跃运行的状态；没有活跃运行时为 null。 */
  runStatus: RunStatus | null
  pendingApprovals: number
}

/** 13 张模块卡，顺序与职责模块词典一致。 */
export function buildModuleCards(input: ModuleCardsInput): ModuleCard[] {
  return RESPONSIBILITY_MODULES.map((module) => {
    const status = input.moduleStatuses.find((entry) => entry.moduleId === module.id)
    const activeRun = status?.activeRunId
      ? input.runs.find((run) => run.id === status.activeRunId)
      : undefined

    const activeIncidents = input.incidentRows.filter(
      (row) => isOpenIncident(row) && row.moduleId === module.id,
    ).length

    const pendingApprovals = input.approvals.filter(
      (approval) => approval.status === 'pending' && approval.requestedBy === module.id,
    ).length

    return {
      moduleId: module.id,
      activeIncidents,
      runStatus: activeRun ? activeRun.status : null,
      pendingApprovals,
    }
  })
}

export type SeverityDistribution = Record<Severity, number>

/** 只统计事故条目，告警与待处理任务不计入。 */
export function buildSeverityDistribution(
  incidentRows: readonly IncidentListRow[],
): SeverityDistribution {
  const distribution = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  ) as SeverityDistribution
  for (const row of incidentRows.filter(isIncident)) {
    distribution[row.severity] += 1
  }
  return distribution
}

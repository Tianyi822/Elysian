import type {
  AgentRun,
  ApprovalRequest,
  AuditRecord,
  IncidentListRow,
  Skill,
} from '@elysian/contracts'
import { RESPONSIBILITY_MODULES } from '@elysian/contracts'
import { describe, expect, it } from 'vitest'
import { createMockDataset } from './dataset'
import { aggregateStatCards, buildModuleCards, buildSeverityDistribution } from './aggregations'
import { BASE_DATE, createIncidentTrend, dailyTotal } from './timeseries'

const T = '2026-09-12T07:00:00.000Z'
const TODAY = '2026-09-12'

/** 手工构造的小数据集：期望值全部手算，不经过被测函数。 */
const rows: IncidentListRow[] = [
  { id: 'INC-1', kind: 'incident', title: 'a', severity: 'sev1', status: 'open', source: 's', service: 'svc-a', at: T, moduleId: 'incident-command' },
  { id: 'INC-2', kind: 'incident', title: 'b', severity: 'sev2', status: 'resolved', source: 's', service: 'svc-b', at: T, moduleId: 'coordination' },
  { id: 'INC-3', kind: 'incident', title: 'c', severity: 'sev2', status: 'analyzing', source: 's', service: 'svc-a', at: T, moduleId: 'coordination' },
  { id: 'ALT-1', kind: 'alert', title: 'd', severity: 'sev3', source: 's', service: 'svc-z', at: T },
  { id: 'TASK-1', kind: 'pending-task', title: 'e', severity: 'sev4', source: 's', service: 'svc-y', at: T },
]

const runs: AgentRun[] = [
  {
    id: 'RUN-1',
    moduleId: 'incident-command',
    status: 'running',
    startedAt: T,
    turns: [],
  },
]

const approvals: ApprovalRequest[] = [
  {
    id: 'AP-1', actionId: 'ACT-1', actionTitle: '动作一', status: 'pending', policy: 'ask',
    riskLevel: 'critical', target: 't', parameters: {}, blastRadius: 'b',
    requestedBy: 'incident-command', requestedAt: T, expiresAt: T,
  },
  {
    id: 'AP-2', actionId: 'ACT-2', actionTitle: '动作二', status: 'approved', outcome: 'allowed-once', policy: 'ask',
    riskLevel: 'high', target: 't', parameters: {}, blastRadius: 'b',
    requestedBy: 'incident-command', requestedAt: T, expiresAt: T,
  },
]

const audit: AuditRecord[] = [
  { id: 'A-1', at: '2026-09-12T07:00:00.000Z', kind: 'event', actor: 'x', subject: 's', summary: 'm', detail: 'd', traceId: 't' },
  { id: 'A-2', at: '2026-09-11T07:00:00.000Z', kind: 'decision', actor: 'x', subject: 's', summary: 'm', detail: 'd', traceId: 't' },
]

const skills: Skill[] = [
  { id: 'sk-1', name: '一', responsibility: 'r', version: '1.0.0', capabilities: ['c'], riskLevel: 'low', enabled: true },
  { id: 'sk-2', name: '二', responsibility: 'r', version: '1.0.0', capabilities: ['c'], riskLevel: 'low', enabled: false },
]

describe('指标卡聚合（期望值手算）', () => {
  const stats = aggregateStatCards(
    { incidentRows: rows, runs, approvals, audit, skills },
    TODAY,
  )

  it('事故总数只统计事故（3 条），不含告警与待处理任务', () => {
    expect(stats.totalIncidents).toBe(3)
  })

  it('待处理事故只算 open 状态（1 条）', () => {
    expect(stats.openIncidents).toBe(1)
  })

  it('运行计数按运行状态（1 执行中、0 等待审批）', () => {
    expect(stats.runningRuns).toBe(1)
    expect(stats.waitingRuns).toBe(0)
  })

  it('待审批 1 条，最高风险为致命', () => {
    expect(stats.pendingApprovals).toBe(1)
    expect(stats.highestPendingRisk).toBe('critical')
  })

  it('今日审计事件按基准日期过滤（2 条里 1 条）', () => {
    expect(stats.todayAuditEvents).toBe(1)
  })

  it('启用技能 1 个', () => {
    expect(stats.enabledSkills).toBe(1)
  })

  it('受影响服务只统计未归档事故的去重服务数（svc-a，1 个）', () => {
    expect(stats.affectedServices).toBe(1)
  })
})

describe('模块卡聚合（期望值手算）', () => {
  const cards = buildModuleCards({
    incidentRows: rows,
    runs,
    approvals,
    moduleStatuses: [
      { moduleId: 'incident-command', status: 'running', activeRunId: 'RUN-1' },
      { moduleId: 'coordination', status: 'idle' },
    ],
  })

  it('恰好 13 张，顺序与职责模块词典一致', () => {
    expect(cards.map((card) => card.moduleId)).toEqual(
      RESPONSIBILITY_MODULES.map((module) => module.id),
    )
  })

  it('事故指挥：1 条未归档事故、运行中、1 条待审批', () => {
    const card = cards.find((entry) => entry.moduleId === 'incident-command')
    expect(card).toEqual({
      moduleId: 'incident-command',
      activeIncidents: 1,
      runStatus: 'running',
      pendingApprovals: 1,
    })
  })

  it('协调中心：1 条未归档事故（分析中）、无活跃运行、无待审批', () => {
    const card = cards.find((entry) => entry.moduleId === 'coordination')
    expect(card).toEqual({
      moduleId: 'coordination',
      activeIncidents: 1,
      runStatus: null,
      pendingApprovals: 0,
    })
  })

  it('其余 11 个模块全为零', () => {
    const idle = cards.filter(
      (card) => card.moduleId !== 'incident-command' && card.moduleId !== 'coordination',
    )
    expect(idle).toHaveLength(11)
    for (const card of idle) {
      expect(card).toEqual({
        moduleId: card.moduleId,
        activeIncidents: 0,
        runStatus: null,
        pendingApprovals: 0,
      })
    }
  })
})

describe('严重等级分布（期望值手算）', () => {
  it('只统计事故：sev1 一条、sev2 两条、告警与任务不计入', () => {
    expect(buildSeverityDistribution(rows)).toEqual({ sev1: 1, sev2: 2, sev3: 0, sev4: 0 })
  })
})

describe('对真实演示数据集的健全性检查', () => {
  it('指标卡数值与数据集的朴素独立计算一致', () => {
    const dataset = createMockDataset()
    const stats = aggregateStatCards(
      {
        incidentRows: dataset.incidents.map((incident) => ({
          id: incident.id,
          kind: 'incident' as const,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          source: incident.source,
          service: incident.service,
          at: incident.detectedAt,
          owner: incident.owner,
        })),
        runs: dataset.runs,
        approvals: dataset.approvals,
        audit: dataset.audit,
        skills: dataset.skills,
      },
      BASE_DATE,
    )

    // 期望值用测试里的朴素过滤算出，不经过被测函数。
    expect(stats.totalIncidents).toBe(dataset.incidents.length)
    expect(stats.openIncidents).toBe(
      dataset.incidents.filter((incident) => incident.status === 'open').length,
    )
    expect(stats.runningRuns).toBe(dataset.runs.filter((run) => run.status === 'running').length)
    expect(stats.pendingApprovals).toBe(
      dataset.approvals.filter((approval) => approval.status === 'pending').length,
    )
    expect(stats.enabledSkills).toBe(dataset.skills.filter((skill) => skill.enabled).length)
    expect(stats.todayAuditEvents).toBe(
      dataset.audit.filter((record) => record.at.slice(0, 10) === BASE_DATE).length,
    )
  })

  it('趋势数据健康：每天有量、今日量与分布表可对上', () => {
    const trend = createIncidentTrend()
    const today = trend[trend.length - 1]
    expect(today).toBeDefined()
    expect(dailyTotal(today as NonNullable<typeof today>)).toBeGreaterThan(0)
  })
})

import type {
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  ElysianEvent,
  EventStreamHandlers,
  Incident,
  IncidentListRow,
  ModuleStatus,
  Skill,
  Unsubscribe,
} from '@elysian/contracts'
import { SEVERITY_RANK } from '@elysian/contracts'
import type {
  ApprovalAdapter,
  AuditAdapter,
  EventsAdapter,
  IncidentAdapter,
  IncidentListQuery,
  IncidentListResult,
  RunAdapter,
  SkillAdapter,
} from '../../contracts/adapters'
import { toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'

/*
 * 各个领域的 mock 适配实现。它们共用同一份内存数据集，
 * 因此审批、审计、事件流之间引用的标识是一致的。
 */

function matches(selected: readonly string[] | undefined, value: string | undefined): boolean {
  if (!selected || selected.length === 0) return true
  if (value === undefined) return false
  return selected.includes(value)
}

export function sortRows(
  rows: readonly IncidentListRow[],
  sort: IncidentListQuery['sort'],
): IncidentListRow[] {
  const sorted = [...rows]
  switch (sort) {
    case 'detected-asc':
      return sorted.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    case 'severity':
      return sorted.sort((a, b) => {
        const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        if (bySeverity !== 0) return bySeverity
        return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
      })
    case 'detected-desc':
    default:
      return sorted.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
}

export class MockIncidentAdapter implements IncidentAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async listRows(query: IncidentListQuery): Promise<IncidentListResult> {
    const rows = toIncidentListRows(this.dataset())
    const filtered = rows.filter(
      (row) =>
        matches(query.severities, row.severity) &&
        matches(query.statuses, row.status) &&
        matches(query.sources, row.source),
    )
    const availableSources = [...new Set(rows.map((row) => row.source))].sort()
    return {
      rows: sortRows(filtered, query.sort),
      total: filtered.length,
      availableSources,
    }
  }

  async find(incidentId: string): Promise<Incident | undefined> {
    return this.dataset().incidents.find((incident) => incident.id === incidentId)
  }
}

export class MockSkillAdapter implements SkillAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly Skill[]> {
    return this.dataset().skills
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<Skill> {
    const dataset = this.dataset()
    const index = dataset.skills.findIndex((candidate) => candidate.id === skillId)
    const current = index >= 0 ? dataset.skills[index] : undefined
    if (!current) throw new Error(`技能不存在：${skillId}`)
    const updated: Skill = { ...current, enabled }
    ;(dataset.skills as Skill[])[index] = updated
    return updated
  }
}

export class MockApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly ApprovalRequest[]> {
    return this.dataset().approvals
  }

  async decide(
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ): Promise<ApprovalRequest> {
    const dataset = this.dataset()
    const index = dataset.approvals.findIndex((candidate) => candidate.id === requestId)
    const current = index >= 0 ? dataset.approvals[index] : undefined
    if (!current) throw new Error(`审批请求不存在：${requestId}`)

    const updated: ApprovalRequest = {
      ...current,
      status: decision.outcome === 'rejected' ? 'rejected' : 'approved',
      outcome: decision.outcome,
      decidedBy: '当前用户',
      decidedAt: new Date().toISOString(),
      note: decision.note,
    }
    ;(dataset.approvals as ApprovalRequest[])[index] = updated
    return updated
  }
}

export class MockAuditAdapter implements AuditAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AuditRecord[]> {
    return this.dataset().audit
  }
}

export class MockRunAdapter implements RunAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AgentRun[]> {
    return this.dataset().runs
  }

  async find(runId: string): Promise<AgentRun | undefined> {
    return this.dataset().runs.find((run) => run.id === runId)
  }

  async listModuleStatuses(): Promise<readonly ModuleStatus[]> {
    return this.dataset().moduleStatuses
  }
}

/**
 * 内存事件源：事件流端点不可用时的降级实现，契约与 SSE 实现完全一致。
 * 它按固定节奏产出确定性的事件内容，使界面在没有服务端进程时也能演示增量刷新。
 */
export function createInMemoryEventsAdapter(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
): EventsAdapter {
  const intervalMs = options.intervalMs ?? 3000

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      handlers.onStatus('connecting')

      let counter = 0
      let cursor = 0

      const emitLater = () => {
        counter += 1
        const data = dataset()
        const events: ElysianEvent[] = []

        const run = data.runs[cursor % Math.max(1, data.runs.length)]
        if (run) {
          events.push({
            id: `mem-${counter}-agent`,
            name: 'agent/status',
            at: new Date().toISOString(),
            payload: { moduleId: run.moduleId, status: 'running' },
          })
        }

        const approval = data.approvals[cursor % Math.max(1, data.approvals.length)]
        if (approval && approval.status === 'pending') {
          events.push({
            id: `mem-${counter}-approval`,
            name: 'approval/asked',
            at: new Date().toISOString(),
            payload: { approvalId: approval.id },
          })
        }

        const incident = data.incidents[cursor % Math.max(1, data.incidents.length)]
        if (incident) {
          events.push({
            id: `mem-${counter}-incident`,
            name: 'incident/updated',
            at: new Date().toISOString(),
            payload: { incidentId: incident.id, status: incident.status },
          })
        }

        cursor += 1
        for (const event of events) handlers.onEvent(event)
      }

      handlers.onStatus('live')
      const timer = setInterval(emitLater, intervalMs)

      return () => {
        clearInterval(timer)
      }
    },
  }
}

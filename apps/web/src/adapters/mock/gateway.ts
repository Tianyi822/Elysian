import { SEVERITY_RANK } from '@elysian/contracts'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  ElysianEvent,
  EventName,
  EventStreamHandlers,
  Incident,
  IncidentListRow,
  Skill,
  Unsubscribe,
} from '@elysian/contracts'
import type {
  ApprovalAdapter,
  AuditAdapter,
  ElysianGateway,
  EventsAdapter,
  IncidentAdapter,
  IncidentListQuery,
  IncidentListResult,
  SkillAdapter,
} from '../../contracts/adapters'
import { createMockDataset, toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'

function matches(selected: readonly string[] | undefined, value: string | undefined): boolean {
  if (!selected || selected.length === 0) return true
  if (value === undefined) return false
  return selected.includes(value)
}

export function sortRows(rows: readonly IncidentListRow[], sort: IncidentListQuery['sort']): IncidentListRow[] {
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

class MockIncidentAdapter implements IncidentAdapter {
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

class MockSkillAdapter implements SkillAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly Skill[]> {
    return this.dataset().skills
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<Skill> {
    const skill = this.dataset().skills.find((candidate) => candidate.id === skillId)
    if (!skill) throw new Error(`技能不存在：${skillId}`)
    const updated: Skill = { ...skill, enabled }
    const dataset = this.dataset()
    const index = dataset.skills.findIndex((candidate) => candidate.id === skillId)
    if (index >= 0) {
      ;(dataset.skills as Skill[])[index] = updated
    }
    return updated
  }
}

class MockApprovalAdapter implements ApprovalAdapter {
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

class MockAuditAdapter implements AuditAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AuditRecord[]> {
    return this.dataset().audit
  }
}

/**
 * 内存事件源：在没有事件流端点时的降级实现，契约与 SSE 实现一致。
 * 它按固定节奏产出确定性事件，使界面在没有服务端进程时也能演示增量刷新。
 */
export function createInMemoryEventsAdapter(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
): EventsAdapter {
  const intervalMs = options.intervalMs ?? 2500
  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      handlers.onStatus('connecting')

      let counter = 0
      let cursor = 0
      const emit = () => {
        const data = dataset()
        const approvals = data.approvals
        const runs = data.runs
        const sources: ElysianEvent[] = []

        const run = runs[cursor % Math.max(1, runs.length)]
        if (run) {
          sources.push({
            id: `mem-${counter += 1}`,
            name: 'agent/status' satisfies EventName,
            at: new Date().toISOString(),
            payload: { moduleId: run.moduleId, status: 'running' },
          })
        }
        const approval = approvals[cursor % Math.max(1, approvals.length)]
        if (approval && approval.status === 'pending') {
          sources.push({
            id: `mem-${counter += 1}`,
            name: 'approval/asked' satisfies EventName,
            at: new Date().toISOString(),
            payload: { approvalId: approval.id },
          })
        }
        cursor += 1

        for (const event of sources) handlers.onEvent(event)
      }

      const timer = setInterval(emit, intervalMs)
      handlers.onStatus('live')

      return () => {
        clearInterval(timer)
      }
    },
  }
}

/** 真实 SSE 实现留到 05 号票；此处先声明同一契约下的降级实现。 */
export function createMockGateway(): ElysianGateway {
  let dataset = createMockDataset()
  const read = () => dataset

  return {
    incidents: new MockIncidentAdapter(read),
    skills: new MockSkillAdapter(read),
    approvals: new MockApprovalAdapter(read),
    audit: new MockAuditAdapter(read),
    events: createInMemoryEventsAdapter(read),
    async reset() {
      dataset = createMockDataset()
    },
  }
}

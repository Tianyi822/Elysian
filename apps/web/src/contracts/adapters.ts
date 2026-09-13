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

/*
 * Web 侧适配接口。界面只依赖这些接口，不关心数据来自 mock、内存降级还是真实网关。
 * 这是整个前端唯一的测试接缝：页面测试在这里注入替代实现。
 */

/** 事件中心的查询条件。空数组或缺省表示不筛选该维度。 */
export type IncidentListQuery = {
  severities?: readonly string[]
  statuses?: readonly string[]
  sources?: readonly string[]
  sort?: IncidentSort
}

export type IncidentSort = 'detected-desc' | 'detected-asc' | 'severity'

export type IncidentListResult = {
  rows: readonly IncidentListRow[]
  total: number
  /** 数据集里出现过的全部来源，供筛选器渲染候选项。 */
  availableSources: readonly string[]
}

export interface IncidentAdapter {
  listRows(query: IncidentListQuery): Promise<IncidentListResult>
  find(incidentId: string): Promise<Incident | undefined>
}

export interface SkillAdapter {
  list(): Promise<readonly Skill[]>
  setEnabled(skillId: string, enabled: boolean): Promise<Skill>
}

export interface ApprovalAdapter {
  list(): Promise<readonly ApprovalRequest[]>
  decide(
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ): Promise<ApprovalRequest>
}

export interface AuditAdapter {
  list(): Promise<readonly AuditRecord[]>
}

export interface RunAdapter {
  list(): Promise<readonly AgentRun[]>
  find(runId: string): Promise<AgentRun | undefined>
  /** 13 个职责模块各自的忙闲状态。 */
  listModuleStatuses(): Promise<readonly ModuleStatus[]>
}

export interface EventsAdapter {
  subscribe(handlers: EventStreamHandlers): Unsubscribe
}

/** 页面级访问区域。权限只做到这一粒度，本阶段不实现更细的权限模型。 */
export type PageArea =
  | 'dashboard'
  | 'incidents'
  | 'runs'
  | 'skills'
  | 'approvals'
  | 'audit'
  | 'settings'

/**
 * 会话与权限占位。本期没有认证，mock 实现全部放行；
 * 但界面上的「无权限」分支是真实存在的，接入认证后由这里决定。
 */
export interface SessionAdapter {
  canView(area: PageArea): Promise<boolean>
}

/** 页面注入的聚合入口。 */
export interface ElysianGateway {
  session: SessionAdapter
  incidents: IncidentAdapter
  runs: RunAdapter
  skills: SkillAdapter
  approvals: ApprovalAdapter
  audit: AuditAdapter
  events: EventsAdapter
  /** 把演示数据重置回种子状态。 */
  reset(): Promise<void>
}

/** 便于测试与类型收窄：判断一个事件是不是某个名字。 */
export function isEventNamed<K extends ElysianEvent['name']>(
  event: ElysianEvent,
  name: K,
): event is Extract<ElysianEvent, { name: K }> {
  return event.name === name
}

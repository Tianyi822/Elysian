import type { ApprovalOutcome } from './enums.ts'
import type { AgentRun, ApprovalRequest, AuditRecord, Incident, Skill } from './domain.ts'

/** 技能注册表：技能的发现、版本与启停状态。 */
export interface SkillRegistry {
  list(): Promise<readonly Skill[]>
  setEnabled(skillId: string, enabled: boolean): Promise<Skill>
}

/** 能力接缝：审批的读写入口。实现由适配层提供。 */
export interface ApprovalSeam {
  list(): Promise<readonly ApprovalRequest[]>
  decide(requestId: string, decision: { outcome: ApprovalOutcome; note?: string }): Promise<ApprovalRequest>
}

/** 审计日志：审计记录的读取入口。 */
export interface AuditLog {
  list(): Promise<readonly AuditRecord[]>
}

/** 事故来源：事故详情的读取入口。 */
export interface IncidentSource {
  list(): Promise<readonly Incident[]>
  find(incidentId: string): Promise<Incident | undefined>
}

/** 运行来源：Agent 运行的读取入口。 */
export interface RunSource {
  list(): Promise<readonly AgentRun[]>
  find(runId: string): Promise<AgentRun | undefined>
}

declare module './context.ts' {
  interface Context {
    skills: SkillRegistry
    approvals: ApprovalSeam
    audit: AuditLog
    incidents: IncidentSource
    runs: RunSource
  }
}

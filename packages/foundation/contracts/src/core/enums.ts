/**
 * 枚举取值与中文标签表。
 *
 * 界面文案一律从标签表取用，组件内不硬编码中文。
 * 沿用 Cordis 生态既有取值的枚举（Agent 状态、轮次结束原因、审批决策结果、审批策略、
 * 沙箱模式）不重新定义；带「Elysian 新增」注释的是生态里没有对应概念的运维域取值。
 */

/** 严重等级：事故的严重度，`sev1` 最高。Elysian 新增。 */
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_LABELS: Record<Severity, string> = {
  sev1: '致命',
  sev2: '严重',
  sev3: '一般',
  sev4: '提示',
}

/** 严重等级排序权重，1 最严重。 */
export const SEVERITY_RANK: Record<Severity, number> = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 }

/** 事故状态。Elysian 新增。 */
export const INCIDENT_STATUSES = [
  'open',
  'analyzing',
  'awaiting-approval',
  'mitigating',
  'resolved',
  'closed',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: '待处理',
  analyzing: '分析中',
  'awaiting-approval': '待审批',
  mitigating: '处置中',
  resolved: '已恢复',
  closed: '已归档',
}

/** 运行状态：一次 Agent 运行的队列与执行状态。Elysian 新增。 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting-approval',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  'waiting-approval': '待审批',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
}

/** Agent 状态：职责模块自身的忙闲，是 Agent 维度而非运行维度。沿用 Cordis 取值。 */
export const AGENT_STATUSES = ['idle', 'running'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: '空闲',
  running: '执行中',
}

/** 轮次结束原因。沿用 Cordis 取值。 */
export const TURN_END_REASONS = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
] as const
export type TurnEndReason = (typeof TURN_END_REASONS)[number]

export const TURN_END_REASON_LABELS: Record<TurnEndReason, string> = {
  completed: '完成',
  aborted: '中止',
  blocked: '受阻',
  error: '错误',
  'max-tokens': '超长',
  interrupted: '打断',
}

/** 审批队列状态：请求处于流程的哪一步。Elysian 新增。 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
}

/** 审批决策结果。沿用 Cordis 取值，`unavailable` 必须按失败关闭处理。 */
export const APPROVAL_OUTCOMES = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

export const APPROVAL_OUTCOME_LABELS: Record<ApprovalOutcome, string> = {
  'allowed-once': '一次性放行',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '不可用',
}

/** 审批策略。沿用 Cordis 取值。 */
export const APPROVAL_POLICIES = ['ask', 'never'] as const
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  ask: '需审批',
  never: '不需审批',
}

/** 风险等级：描述一个动作的危险程度，与事故严重等级是两套独立枚举。Elysian 新增。 */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '致命',
}

/** 风险等级排序权重，4 最危险。 */
export const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 }

/** 沙箱模式：可执行动作的准入档位。沿用 Cordis 取值。 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]

export const SANDBOX_MODE_LABELS: Record<SandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

/** 审计类型。Elysian 新增。 */
export const AUDIT_KINDS = ['event', 'decision', 'tool-call', 'approval', 'execution'] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]

export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  event: '事件',
  decision: '决策',
  'tool-call': '工具调用',
  approval: '审批',
  execution: '执行结果',
}

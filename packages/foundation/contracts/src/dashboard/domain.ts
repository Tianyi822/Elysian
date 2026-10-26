import type {
  AgentStatus,
  ApprovalOutcome,
  ApprovalPolicy,
  ApprovalStatus,
  AuditKind,
  IncidentStatus,
  RiskLevel,
  RunStatus,
  Severity,
  TurnEndReason,
} from '../core/enums.ts'

/*
 * 领域类型。标识一律用字符串，不使用自增数字：mock 与真实后端因此可以共用同一套类型，
 * 前端也不需要知道后端的主键策略。
 */

export type IncidentId = string

/** 告警：监控或云平台上报的原始信号。多条告警可聚合成一条事故，也可能不产生事故。 */
export type Alert = {
  id: string
  incidentId?: IncidentId
  severity: Severity
  /** 来源渠道，用于事件中心筛选。 */
  source: string
  service: string
  at: string
  summary: string
}

/** 待处理任务：尚未归属到具体事故、但仍需人处置的动作请求。 */
export type PendingTask = {
  id: string
  title: string
  source: string
  service: string
  at: string
  owner?: string
}

/** 指标摘要：值以字符串承载，避免 mock 与真实数据在精度与格式上打架。 */
export type MetricSummary = {
  label: string
  value: string
  unit?: string
  trend?: 'rising' | 'falling' | 'steady'
}

/** 证据：支撑判断的可核对材料，必须能指回来源。 */
export type Evidence = {
  id: string
  kind: 'metric' | 'log' | 'change' | 'topology'
  summary: string
  /** 来源引用，界面上要能据此回查。 */
  sourceRef: string
  at: string
}

/** 判断：基于证据得出的结论，与证据分开呈现，不伪装成已确认事实。 */
export type Finding = {
  id: string
  statement: string
  confidence: 'low' | 'medium' | 'high'
  /** 支撑这条判断的证据标识，必须能对上证据条目。 */
  evidenceIds: readonly string[]
}

/** 建议动作：动作本体。风险等级描述的是动作，不是事故严重度。 */
export type ProposedAction = {
  id: string
  incidentId?: IncidentId
  runId?: string
  title: string
  target: string
  parameters: Readonly<Record<string, string>>
  /** 影响范围，审批时必须与参数摘要一起展示。 */
  blastRadius: string
  riskLevel: RiskLevel
  approvalId?: string
  /** 本期所有动作都待接入真实执行，界面不得呈现为已执行。 */
  execution: 'awaiting-integration'
}

/** 执行结果：动作执行后的结果与回滚状态。 */
export type ExecutionResult = {
  id: string
  actionId: string
  at: string
  status: 'succeeded' | 'failed' | 'rolled-back' | 'awaiting-integration'
  summary: string
}

/** 工具调用：一次经过流水线的工具执行，含三个阶段与决策结果。 */
export type ToolCall = {
  id: string
  name: string
  at: string
  phase: 'pre-execute' | 'execute' | 'post-execute'
  decision?: 'allow' | 'deny' | 'ask'
  durationMs?: number
  summary: string
}

/** 模型请求：一次运行的模型调用摘要。 */
export type ModelRequest = {
  id: string
  at: string
  model: string
  summary: string
  promptTokens?: number
  completionTokens?: number
}

/** 步骤：运行内的阶段单位，可含一次模型请求与若干次工具调用。 */
export type Step = {
  id: string
  index: number
  title: string
  at: string
  toolCalls: readonly ToolCall[]
  modelRequests: readonly ModelRequest[]
}

/** 轮次：一次「模型请求到产出」的完整回合，是步骤的容器。 */
export type Turn = {
  id: string
  index: number
  startedAt: string
  endedAt?: string
  endReason?: TurnEndReason
  steps: readonly Step[]
}

/** Agent 运行：某个职责模块针对某条事故的一次完整执行。 */
export type AgentRun = {
  id: string
  incidentId?: IncidentId
  moduleId: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  /** 等待原因必须可读，界面不允许把它显示成「等待中」。 */
  waitingReason?: string
  error?: { message: string; endReason: TurnEndReason }
  turns: readonly Turn[]
}

/** 时间线条目：事故详情与运行时间线共用的展示单位。 */
export type TimelineEntry = {
  id: string
  at: string
  kind: 'detected' | 'alert' | 'decision' | 'tool-call' | 'approval' | 'execution' | 'note'
  actor: string
  summary: string
}

/** 事故：Elysian 的一等对象。 */
export type Incident = {
  id: IncidentId
  title: string
  severity: Severity
  status: IncidentStatus
  source: string
  service: string
  detectedAt: string
  updatedAt: string
  owner: string
  runId?: string
  timeline: readonly TimelineEntry[]
  metrics: readonly MetricSummary[]
  evidence: readonly Evidence[]
  findings: readonly Finding[]
  actions: readonly ProposedAction[]
  executionResults: readonly ExecutionResult[]
}

/**
 * 审批请求。两层信息不合并：
 * `status` 是队列生命周期，`outcome` 是决策结果。
 */
export type ApprovalRequest = {
  id: string
  actionId: string
  /** 动作标题。审批队列要能直接读出被审批的是什么动作，不必回查事故。 */
  actionTitle: string
  status: ApprovalStatus
  outcome?: ApprovalOutcome
  policy: ApprovalPolicy
  riskLevel: RiskLevel
  target: string
  parameters: Readonly<Record<string, string>>
  blastRadius: string
  requestedBy: string
  requestedAt: string
  expiresAt: string
  decidedBy?: string
  decidedAt?: string
  note?: string
}

/** 技能：可安装、可启停、带 manifest 的能力单元。 */
export type Skill = {
  id: string
  name: string
  responsibility: string
  version: string
  capabilities: readonly string[]
  riskLevel: RiskLevel
  enabled: boolean
  lastUsedAt?: string
}

/** 审计记录：事件、决策、工具调用、审批与执行结果的时间顺序记录。 */
export type AuditRecord = {
  id: string
  at: string
  kind: AuditKind
  actor: string
  subject: string
  summary: string
  detail: string
  traceId: string
}

/** 职责模块状态：Agent 维度的忙闲，与运行状态是两回事。 */
export type ModuleStatus = {
  moduleId: string
  status: AgentStatus
  activeRunId?: string
  incidentId?: IncidentId
}

/** 事故、告警与待处理任务的合并视图单位，供事件中心列表使用。 */
export type IncidentListRow = {
  id: string
  kind: 'incident' | 'alert' | 'pending-task'
  title: string
  severity: Severity
  status?: IncidentStatus
  source: string
  service: string
  at: string
  owner?: string
  moduleId?: string
}

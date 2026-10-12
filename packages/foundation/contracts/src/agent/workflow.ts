import type { AgentCapabilitySnapshot } from './capabilities.ts'
import type { RuntimeFailure, RuntimeRunStatus } from './runtime.ts'
import type { AgentInput, AgentModelProfile } from './sessions.ts'

export const AGENT_WORKFLOW_STEP_KINDS = ['agent', 'operation', 'approval', 'condition', 'parallel', 'foreach', 'subworkflow'] as const
export type AgentWorkflowStepKind = (typeof AGENT_WORKFLOW_STEP_KINDS)[number]
export const AGENT_WORKFLOW_STEP_KIND_LABELS: Record<AgentWorkflowStepKind, string> = {
  agent: 'Agent 分析', operation: '执行操作', approval: '人工确认', condition: '条件分支',
  parallel: '并行分支', foreach: '有限遍历', subworkflow: '固定子流程',
}
export const AGENT_WORKFLOW_CONDITION_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'exists'] as const
export type AgentWorkflowConditionOperator = (typeof AGENT_WORKFLOW_CONDITION_OPERATORS)[number]

export type AgentWorkflowOutputBinding = { stepId: string; pointer: string }
/** 五种值来源严格互斥；空 object 和 array 也是有效绑定。JSON 原文不能转成浮点数。 */
export type AgentWorkflowBinding =
  | { literalJson: string; input?: never; step?: never; object?: never; array?: never }
  | { literalJson?: never; input: string; step?: never; object?: never; array?: never }
  | { literalJson?: never; input?: never; step: AgentWorkflowOutputBinding; object?: never; array?: never }
  | { literalJson?: never; input?: never; step?: never; object: Readonly<Record<string, AgentWorkflowBinding>>; array?: never }
  | { literalJson?: never; input?: never; step?: never; object?: never; array: readonly AgentWorkflowBinding[] }
/** 有限条件树，不包含可执行表达式；lt/lte/gt/gte 仅比较 JSON 数值。 */
export type AgentWorkflowCondition = {
  op: AgentWorkflowConditionOperator
  left?: AgentWorkflowBinding
  right?: AgentWorkflowBinding
  children?: readonly AgentWorkflowCondition[]
}
export type AgentWorkflowStepDefinition = {
  id: string
  kind: AgentWorkflowStepKind
  instruction?: string
  capability?: string
  input: AgentWorkflowBinding
  outputSchemaJson: string
  next?: string
  condition?: AgentWorkflowCondition
  then?: string
  else?: string
  finish?: AgentWorkflowBinding
  selection?: AgentInput
  parallel?: AgentWorkflowParallel
  foreach?: AgentWorkflowForeach
  subworkflow?: AgentWorkflowSubworkflow
}
export type AgentWorkflowBody = { entry: string; steps: readonly AgentWorkflowStepDefinition[]; outputSchemaJson: string }
export type AgentWorkflowParallel = { join: 'all'; branches: readonly AgentWorkflowBranch[] }
export type AgentWorkflowBranch = { id: string; input: AgentWorkflowBinding; body: AgentWorkflowBody }
export type AgentWorkflowForeach = { items: AgentWorkflowBinding; body: AgentWorkflowBody }
export type AgentWorkflowSubworkflow = { definitionId: string; definitionRevision: number }
export type AgentWorkflowLanguageVersion = 'v1' | 'workflow/v1' | 'workflow/v2'
export type AgentWorkflowDefinition = {
  languageVersion?: AgentWorkflowLanguageVersion
  id: string
  revision: number
  name: string
  enabled: boolean
  goal: string
  inputSchemaJson: string
  outputSchemaJson: string
  entry: string
  steps: readonly AgentWorkflowStepDefinition[]
  createdAt: string
}
export type AgentCreateWorkflowDefinitionInput = Omit<AgentWorkflowDefinition, 'id' | 'revision' | 'createdAt'>
export type AgentUpdateWorkflowDefinitionInput = AgentCreateWorkflowDefinitionInput & { expectedRevision: number }
export type AgentWorkflowLimits = {
  activeMilliseconds: number
  modelRequests: number
  calls: number
  tokens: number
  resultBytes: number
  attempts: number
}
/** tokens 为保守预算扣账；实际/估算用量仍分别读取每个 Run。 */
export type AgentWorkflowUsage = Omit<AgentWorkflowLimits, 'attempts'> & { reservedMilliseconds: number }
export const AGENT_WORKFLOW_STATUSES = ['ready', 'queued', 'running', 'waiting-approval', 'waiting-resource', 'recovery-required', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
export type AgentWorkflowStatus = (typeof AGENT_WORKFLOW_STATUSES)[number]
export const AGENT_WORKFLOW_RECOVERY_ACTIONS = ['continue', 'renew-approval', 'retry', 'accept-result'] as const
export type AgentWorkflowRecoveryAction = (typeof AGENT_WORKFLOW_RECOVERY_ACTIONS)[number]
export const AGENT_WORKFLOW_RECOVERY_ACTION_LABELS: Record<AgentWorkflowRecoveryAction, string> = {
  continue: '继续推进', 'renew-approval': '重新请求审批', retry: '重新尝试步骤', 'accept-result': '补录已确认结果',
}
export const AGENT_WORKFLOW_STATUS_LABELS: Record<AgentWorkflowStatus, string> = {
  ready: '待推进', queued: '排队中', running: '运行中', 'waiting-approval': '等待审批',
  'waiting-resource': '等待资源',
  'recovery-required': '等待人工恢复', succeeded: '已完成', failed: '已失败', cancelled: '已取消', interrupted: '已中断',
}
export type AgentWorkflowInstance = {
  gateClosed?: boolean
  definitions?: readonly AgentWorkflowDefinition[]
  languageVersion?: AgentWorkflowLanguageVersion
  rootScopeId?: string
  executionTree?: AgentWorkflowExecutionTree
  id: string
  requestId: string
  definitionId: string
  definitionRevision: number
  sourceSessionId: string
  sessionId: string
  taskId: string
  revision: number
  status: AgentWorkflowStatus
  currentStepId: string
  activeRunId?: string
  inputJson: string
  outputJson?: string
  model: AgentModelProfile
  snapshot: AgentCapabilitySnapshot
  createdAt: string
  updatedAt: string
  readyAt?: string
  endedAt?: string
  cancelRequestedAt?: string
  error?: RuntimeFailure
  limits: AgentWorkflowLimits
  usage: AgentWorkflowUsage
  lastSeq: string
  allowedActions: readonly AgentWorkflowRecoveryAction[]
}
export type AgentWorkflowAttempt = {
  scopeId?: string
  nodeId?: string
  iteration?: number
  expectedRevision?: number
  workflowId: string
  stepId: string
  number: number
  runId: string
  runNumber: number
  status: RuntimeRunStatus
  inputJson: string
  outputJson?: string
  outputCallId?: string
  outputRequestId?: string
  completionSource?: string
  evidence?: string
  eventSeq?: string
  workspaceRevision: number
  createdAt: string
  endedAt?: string
}
export type AgentWorkflowEvent = {
  workflowId: string
  seq: string
  type: string
  stepId?: string
  runId?: string
  at: string
  detail?: string
}
export type AgentCreateWorkflowInput = {
  requestId: string
  definitionId: string
  definitionRevision: number
  sourceSessionId: string
  inputJson: string
}
export type AgentWorkflowRecoveryInput = {
  nodeId?: string
  requestId: string
  expectedRevision: number
  action: AgentWorkflowRecoveryAction
  evidence?: string
  outputJson?: string
}

export type AgentWorkflowScope = {
  id: string
  workflowId: string
  parentScopeId?: string
  parentNodeId?: string
  path: string
  kind: string
  taskId: string
  parentWorkspaceRevision: number
  parentMemoryRevision: number
  depth: number
  ordinal: number
  status: AgentWorkflowStatus
  currentStepId: string
  inputJson: string
  outputJson?: string
  body: AgentWorkflowBody
  createdAt: string
  endedAt?: string
}
export type AgentWorkflowNodeExecution = {
  id: string
  workflowId: string
  scopeId: string
  stepId: string
  stableKey: string
  kind: AgentWorkflowStepKind
  ordinal: number
  status: AgentWorkflowStatus | 'skipped'
  taskId: string
  runId?: string
  attempt: number
  revision: number
  inputJson: string
  outputJson?: string
  expanded: boolean
  joinWorkspaceRevision: number
  error?: RuntimeFailure
  createdAt: string
  endedAt?: string
  allowedActions: readonly AgentWorkflowRecoveryAction[]
}
export type AgentWorkflowExecutionTree = { rootScopeId: string; scopes: readonly AgentWorkflowScope[]; nodes: readonly AgentWorkflowNodeExecution[] }

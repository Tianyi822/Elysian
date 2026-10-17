import type { AgentModelProfile } from './sessions.ts'
import type { AgentCapabilitySnapshot, AgentRecoveryCursor } from './capabilities.ts'
import type { AgentInput } from './sessions.ts'

export * from './sessions.ts'

/** 真实任务的运行协议，与仪表盘 AgentRun 演示模型分别维护。 */
export const RUNTIME_RUN_STATUSES = [
  'queued', 'running', 'waiting-input', 'waiting-approval', 'waiting-resource', 'waiting-task', 'recovery-required', 'succeeded', 'failed', 'cancelled', 'interrupted',
] as const
export type RuntimeRunStatus = (typeof RUNTIME_RUN_STATUSES)[number]
export const RUNTIME_RUN_STATUS_LABELS: Record<RuntimeRunStatus, string> = {
  queued: '排队中', running: '执行中', 'waiting-input': '等待回答', 'waiting-approval': '等待审批', 'waiting-resource': '等待资源', 'waiting-task': '等待平台任务', 'recovery-required': '等待人工恢复', succeeded: '已成功', failed: '已失败',
  cancelled: '已取消', interrupted: '运行中断',
}

/** tool-batch/v1 只接受这四个无参数、只读 Docker 工具。 */
export const RUNTIME_TOOL_NAMES = [
  'docker_containers_list', 'docker_images_list', 'docker_policy_view', 'docker_self_container',
] as const
export type RuntimeToolName = (typeof RUNTIME_TOOL_NAMES)[number]
export type RuntimeStep = { tool: RuntimeToolName; args: Readonly<Record<string, never>> }
export type RuntimeSubmitInput = { requestId: string; kind: 'tool-batch'; steps: readonly RuntimeStep[] }
export type RuntimeMemoryStatus = 'unchanged' | 'updated' | 'stale' | 'invalidated'
export type RuntimeTaskSummary = { latestRun?: RuntimeRun; memoryStatus?: RuntimeMemoryStatus }
export type RuntimeBatchTask = RuntimeSubmitInput & RuntimeTaskSummary & { id: string; driverVersion: string; createdAt: string }
export type RuntimeAgentTask = RuntimeTaskSummary & {
  id: string
  requestId: string
  kind: 'agent'
  driverVersion: string
  createdAt: string
  sessionId: string
  /** 首次接受的任务目标，续轮输入不能覆盖。 */
  goal: string
  steps: readonly RuntimeStep[] | null
}
export type RuntimeWorkflowTask = Omit<RuntimeAgentTask, 'kind'> & { kind: 'workflow' }
export type RuntimeTask = RuntimeBatchTask | RuntimeAgentTask | RuntimeWorkflowTask
export type RuntimeFailure = { code: string; message: string }
export type RuntimeUsage = {
  calls: number
  resultBytes: number
  modelRequests?: number
  tokens?: number
  estimatedTokens?: number
  /** 供应商未报告时省略；不能把未知用量视为零。 */
  actualTokens?: number
  cachedTokens?: number
}
export type RuntimeLimits = {
  concurrency: number
  queueCapacity: number
  maxSteps: number
  inputBytes: number
  callTimeoutSeconds: number
  runTimeoutSeconds: number
  resultBytes: number
  runResultBytes: number
  logBytes: number
  frameBytes: number
  retentionDays: number
  cancelGraceSeconds: number
  maxModelRequests?: number
  modelTimeoutSeconds?: number
  outputTokens?: number
  tokenBudget?: number
  userBytes?: number
  memoryBytes?: number
  modelResponseBytes?: number
  /** 单文件字节限额为正时开放图片；此时张数省略或为 0 表示不限制张数。 */
  imageCountPerMessage?: number
  /** 省略或为 0 表示本通道不开放图片。 */
  imageBytesPerFile?: number
  /** 单消息图片总字节限额；省略或为 0 表示不设置独立总量限制。 */
  imageBytesPerMessage?: number
}

export type RuntimeRun = {
  scopeId?: string
  nodeId?: string
  driver?: string
  workflowId?: string
  workflowStepId?: string
  workflowAttempt?: number
  workflowFrozenFrom?: RuntimeRunStatus
  workflowOutputSchemaJson?: string
  workflowOutputJson?: string
  workflowOutputRequestId?: string
  workflowOutputCallId?: string
  workflowNext?: string
  workflowActiveReserved?: number
  driverVersion?: string
  snapshot?: AgentCapabilitySnapshot
  selection?: AgentInput
  supersededByRunId?: string
  resume?: AgentRecoveryCursor
  activeMilliseconds?: number
  id: string
  taskId: string
  status: RuntimeRunStatus
  createdAt: string
  startedAt?: string
  endedAt?: string
  /** 取消请求已落盘；存在此字段不表示运行已停止。 */
  cancelRequestedAt?: string
  endReason?: string
  error?: RuntimeFailure
  task?: RuntimeTask
  limits: RuntimeLimits
  usage: RuntimeUsage
  /** 十进制序号，不能转成可能失去精度的 JavaScript number。 */
  lastSeq: string
  sessionId?: string
  runNumber?: number
  requestId?: string
  input?: string
  /** 接受运行时固定的模型修订，永远不包含凭据。 */
  model?: AgentModelProfile
  historySeq?: string
  initialMemoryRevision?: number
  phase?: 'queued' | 'inference' | 'checkpoint' | 'final-memory' | 'workflow-output' | 'waiting-input' | 'waiting-approval' | 'waiting-resource' | 'waiting-task' | 'completed'
  memoryStatus?: RuntimeMemoryStatus
  warning?: RuntimeFailure
}

export type RuntimeJSONValue = null | boolean | number | string | readonly RuntimeJSONValue[] | { readonly [key: string]: RuntimeJSONValue }
export type RuntimeCall = {
  id: string
  runId: string
  tool: string
  status: RuntimeRunStatus
  startedAt?: string
  endedAt?: string
  /** 从 0 开始的固定步骤位置。 */
  stepIndex: number
  args: Readonly<Record<string, RuntimeJSONValue>>
  /** agent/v2 的精确参数原文；避免浏览器数值转换改变审批内容。 */
  argumentsJson?: string
  operationId?: string
  result?: RuntimeJSONValue
  error?: RuntimeFailure
  truncated: boolean
  modelRequestId?: string
  modelCallId?: string
}

/** 事件载荷为有界摘要；完整结果经 calls 接口分页读取。 */
export type RuntimeEvent = {
  runId: string
  seq: string
  type: string
  at: string
  callId?: string
  stepIndex?: number
  data?: RuntimeJSONValue
}

export type RuntimeToolSchema = {
  name: RuntimeToolName
  description: string
  parameters: Readonly<Record<string, RuntimeJSONValue>>
}
export type RuntimeInfo = {
  available: boolean
  worker: string
  storage: string
  reason?: string
  tools: readonly RuntimeToolSchema[]
  limits: RuntimeLimits
  queueDepth: number
  /** 旧批处理快照可能没有分项能力；实时 Agent API 以 AgentRuntimeInfo 为准。 */
  batch?: RuntimeCapability
  agent?: RuntimeCapability
  skills?: RuntimeCapability
  mcp?: RuntimeCapability
  containerExecution?: RuntimeCapability
  approvals?: RuntimeCapability
  workflow?: RuntimeCapability
  wiki?: RuntimeCapability
  embedding?: RuntimeCapability
  workflowV2?: RuntimeCapability
  resourceLocks?: RuntimeCapability
  executionRuntimes?: RuntimeCapability
}
export type RuntimeCapability = { available: boolean; reason?: string }
/** 执行器受管进程的公开身份与生命周期；不包含容器凭据或启动参数。state 当前取值 running 与 stopping。 */
export type AgentExecutionRuntime = {
  id: string
  containerId: string
  /** 由 stdio MCP 探测启动的进程才回填服务身份。 */
  serverId?: string
  serverRevision?: number
  state: string
}
export type AgentRuntimeInfo = RuntimeInfo & {
  batch: RuntimeCapability
  agent: RuntimeCapability
  skills: RuntimeCapability
  mcp: RuntimeCapability
  containerExecution: RuntimeCapability
  approvals: RuntimeCapability
  workflow: RuntimeCapability
  wiki: RuntimeCapability
  embedding: RuntimeCapability
  workflowV2: RuntimeCapability
  resourceLocks: RuntimeCapability
  executionRuntimes: RuntimeCapability
}
export type RuntimePage<T> = { items: readonly T[]; nextCursor: string; hasMore: boolean }
export type RuntimeListQuery = {
  status?: RuntimeRunStatus
  requestId?: string
  sessionId?: string
  taskId?: string
  workflowId?: string
  cursor?: string
  limit?: number
}
export type RuntimeAPIError = { error: string; code: string }

export function runtimeRunIsActive(status: RuntimeRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting-input' || status === 'waiting-approval' || status === 'waiting-resource' || status === 'waiting-task' || status === 'recovery-required'
}

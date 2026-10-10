import type { RuntimeFailure, RuntimeJSONValue, RuntimeMemoryStatus, RuntimeRunStatus } from './runtime.ts'
import type { AgentPromptRef, AgentResourceRef, AgentRevisionRef } from './capabilities.ts'

/** 模型能力由配置声明；source 记录能力信息来源。 */
export type AgentModelCapabilities = { text: boolean; tools: boolean; source: string }

/** 公开的不可变模型修订，不包含 credential 字段。 */
export type AgentModelProfile = {
  id: string
  revision: number
  name: string
  baseUrl: string
  model: string
  contextTokens: number
  outputTokens: number
  capabilities: AgentModelCapabilities
  active: boolean
  hasCredential: boolean
}

export type AgentModelProfileInput = {
  name: string
  baseUrl: string
  model: string
  contextTokens: number
  outputTokens: number
  capabilities: AgentModelCapabilities
  active: boolean
  /** 省略则沿用旧值，空串明确清除；仅用于提交，不属于公开配置。 */
  credential?: string
}
export type AgentUpdateModelProfileInput = AgentModelProfileInput & { expectedRevision: number }

/** 模型切换响应给出公开修订差异；此说明不是任务或会话的持久事实。 */
export type AgentModelChange = {
  before?: AgentModelProfile
  after: AgentModelProfile
  differences: readonly string[]
  notices: readonly string[]
}

/** 面板登录与 Agent 会话分开；退出登录不会删除任务历史。 */
export type AgentSession = {
  id: string
  title: string
  createdAt: string
  lastActivityAt: string
  modelProfileId: string
  modelRevision: number
  activeRunId?: string
  activeWorkflowId?: string
  lastSeq: string
  notices?: readonly string[]
  modelChange?: AgentModelChange
}

export type AgentCreateSessionInput = { title: string; modelProfileId: string; modelRevision: number }
export type AgentSwitchModelInput = { modelProfileId: string; modelRevision: number }
export type AgentInput = {
  requestId: string
  content: string
  skills?: readonly AgentRevisionRef[]
  resources?: readonly AgentResourceRef[]
  prompts?: readonly AgentPromptRef[]
}

/** 公开对话只包含用户输入和助手答复，不承载工具结果、工作记忆或隐藏推理。 */
export type AgentMessage = {
  id: string
  sessionId: string
  taskId: string
  runId: string
  seq: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  runStatus?: RuntimeRunStatus
}

/** 事件序号按十进制字符串保留，不使用 JavaScript number 比较或递增。 */
export type AgentMemoryCursor = { runNumber: number; eventSeq: string }
export type AgentEvidenceRef = { runId: string; eventSeq: string }
export type AgentMemoryFact = { text: string; sources: readonly AgentEvidenceRef[] }
export type AgentWorkingMemory = {
  /** 对应任务最近一轮的公开状态；当前记忆版本可仍为旧的已确认快照。 */
  memoryStatus?: RuntimeMemoryStatus
  taskId: string
  revision: number
  updatedAt: string
  coverage: AgentMemoryCursor
  objective: string
  constraints: readonly string[]
  facts: readonly AgentMemoryFact[]
  todos: readonly string[]
  openQuestions: readonly string[]
  summary: string
}

/** 模型函数提议可以包含未获准名称；是否执行由父进程核对。 */
export type AgentModelToolCall = { id: string; name: string; arguments: RuntimeJSONValue }
export type AgentModelUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** 缺少此字段表示服务端没有报告缓存用量。 */
  cachedTokens?: number
}
export type AgentModelResponse = {
  content: string
  toolCalls?: readonly AgentModelToolCall[]
  finishReason: string
  usage: AgentModelUsage
}
export type AgentModelRequestRecord = {
  id: string
  runId: string
  index: number
  purpose: 'inference' | 'checkpoint' | 'final-memory' | 'workflow-output' | 'input-material'
  status: RuntimeRunStatus
  startedAt: string
  endedAt?: string
  contextRefs: readonly AgentEvidenceRef[]
  memoryRevision: number
  response?: AgentModelResponse
  error?: RuntimeFailure
  estimatedTokens: number
  eventSeq?: string
  historySeq: string
}

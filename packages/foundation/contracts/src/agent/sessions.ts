import type { RuntimeFailure, RuntimeJSONValue, RuntimeMemoryStatus, RuntimeRunStatus, RuntimeUsage } from './runtime.ts'
import type { AgentPermissionMode, AgentPromptRef, AgentResourceRef, AgentRevisionRef } from './capabilities.ts'
import type { AgentWikiRef } from './memory.ts'

/** 模型能力由配置声明；source 记录能力信息来源。 */
export type AgentModelReasoningLevel = string
export type AgentModelCapabilities = {
  /** 是否支持文本输入；Ely 运行要求文本与工具调用。 */
  text: boolean
  tools: boolean
  /** 多模态输入能力；缺失时按 false 处理以兼容旧配置。 */
  image?: boolean
  video?: boolean
  pdf?: boolean
  /** 高级响应能力；缺失时按 false 处理以兼容旧配置。 */
  structuredOutput?: boolean
  webSearch?: boolean
  systemMessages?: boolean
  /** 支持的推理等级，按用户指定的低到高顺序保存；不选择本次运行的强度。 */
  reasoningLevels?: readonly AgentModelReasoningLevel[]
  /** 声明的默认推理档，必须是 reasoningLevels 之一；官方预设按文档填入，未声明时界面回落到通用策略。 */
  defaultReasoningLevel?: AgentModelReasoningLevel
  source: string
}

export type AgentModelProvider = 'openai-compatible' | 'deepseek' | 'zhipu'

export const AGENT_MODEL_API_FORMATS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'chat-completions', label: 'Chat Completions (/chat/completions)' },
  { value: 'responses', label: 'Responses (/responses)' },
] as const
export type AgentModelAPIFormat = typeof AGENT_MODEL_API_FORMATS[number]['value']

/** 公开的不可变模型修订，不包含 credential 字段；model 既是上送供应商的标识，也是界面显示名。 */
export type AgentModelProfile = {
  provider: AgentModelProvider
  apiFormat: AgentModelAPIFormat
  id: string
  revision: number
  baseUrl: string
  model: string
  contextTokens: number
  outputTokens: number
  capabilities: AgentModelCapabilities
  active: boolean
  hasCredential: boolean
  service?: { id: string; revision: number; name: string; active: boolean; enabled: boolean }
}

/** 一个服务共用地址、协议和凭据，保存时原子更新全部模型修订。 */
export type AgentModelService = {
  id: string
  revision: number
  name: string
  provider: AgentModelProvider
  apiFormat: AgentModelAPIFormat
  baseUrl: string
  active: boolean
  hasCredential: boolean
  models: readonly (AgentModelProfile & { enabled: boolean })[]
}
export type AgentModelServiceInput = {
  name: string
  provider: AgentModelProvider
  apiFormat: AgentModelAPIFormat
  baseUrl: string
  active: boolean
  credential?: string
  models: readonly {
    id?: string
    model: string
    contextTokens: number
    outputTokens: number
    capabilities: AgentModelCapabilities
    enabled: boolean
  }[]
}
export type AgentUpdateModelServiceInput = AgentModelServiceInput & { expectedRevision: number }

/** 读取远端目录的临时连接信息，不保存配置；省略凭据可沿用同地址的已保存凭据。 */
export type AgentModelDiscoveryInput = {
  provider: AgentModelProvider
  apiFormat: AgentModelAPIFormat
  baseUrl: string
  credential?: string
  serviceId?: string
  expectedRevision?: number
}
export type AgentDiscoveredModel = {
  model: string
  name: string
  contextTokens?: number
  outputTokens?: number
}

export type AgentModelProfileInput = {
  provider: AgentModelProvider
  apiFormat: AgentModelAPIFormat
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
export type AgentRenameSessionInput = { title: string }
export type AgentSwitchModelInput = { modelProfileId: string; modelRevision: number }

/** 已上传图片附件的引用；字节先经 multipart 上传端点入库，提交时只携带 id。 */
export type AgentAttachmentRef = { id: string }

/** 附件前端预检常量：与服务端 Agent Limits 默认值一致，服务端仍是权威。 */
export const AGENT_ATTACHMENT_LIMITS = {
  acceptMimeTypes: ['image/jpeg', 'image/png'],
  maxFileBytes: 1048576,
  maxMessageBytes: 8388608,
} as const

export type AgentInput = {
  permissionMode?: AgentPermissionMode
  requestId: string
  content: string
  /** 仅续轮使用：替换会话最后一条用户消息及其回复。 */
  replaceMessageId?: string
  /** 本轮主循环的思考等级；省略时沿用模型默认，必须属于固定模型修订声明的档位。 */
  reasoningLevel?: AgentModelReasoningLevel
  skills?: readonly AgentRevisionRef[]
  resources?: readonly AgentResourceRef[]
  prompts?: readonly AgentPromptRef[]
  /** 随消息发送的图片附件引用；不限制张数，受压缩后单图与消息总字节限额约束，模型必须声明 image 能力。 */
  attachments?: readonly AgentAttachmentRef[]
}

/** 公开消息携带的附件描述符：只含引用与摘要，字节经专用端点按需读取。 */
export type AgentMessageAttachment = {
  id: string
  name: string
  mimeType: string
  bytes: number
  width: number
  height: number
}

/** 公开对话只包含用户输入和助手答复，不承载工具结果、工作记忆或隐藏推理。 */
export type AgentMessage = {
  /** 被替换的原始消息；连续编辑保持此标识，便于增量读取移除旧轮。 */
  replacesMessageId?: string
  /** 服务端判定该消息引用了不可信或未核实内容，展示时须与普通答复区分。 */
  quarantined?: boolean
  /** 消息成文时引用的 Wiki 页面修订；由父进程核验，不在前端补全。 */
  wikiSources?: readonly AgentWikiRef[]
  /** 该轮用户消息随文发送的图片附件描述符；旧文档缺字段按不存在兼容。 */
  attachments?: readonly AgentMessageAttachment[]
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
  /** 供应商显式返回的思考文本或公开摘要，与最终答复分开显示。 */
  reasoning?: string
  content: string
  toolCalls?: readonly AgentModelToolCall[]
  finishReason: string
  usage: AgentModelUsage
}
export type AgentModelRequestRecord = {
  /** 本次推理请求实际提供的工具，用于恢复后校验按需加载范围。 */
  toolNames?: readonly string[]
  /** 运行中的思考文本快照，不表示已确认模型响应。 */
  reasoning?: string
  /** 请求结束但未形成完整响应时保留的公开正文片段。 */
  content?: string
  /** 本次请求随上下文送入的 Wiki 页面修订。 */
  wikiSources?: readonly AgentWikiRef[]
  /** 本次请求实际载入的资料条目（技能正文、MCP 资源等 ContextItem 的 ID）。 */
  contextItemIds?: readonly string[]
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
/** 运行中可替换的展示快照；公开消息与历史仍以会话消息接口为准。 */
export interface AgentChatOutput {
  runId: string
  responseId: string
  reasoning: string
  content: string
  done: boolean
  timeline?: AgentChatTimelineSnapshot
}

export type AgentChatToolStatus = 'planned' | 'waiting-approval' | 'waiting-resource' | 'waiting-task' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'denied' | 'expired' | 'revoked' | 'not-executed'
type AgentChatTimelineEntryBase = {
  id: string
  modelRequestId: string
  requestIndex: number
  startedAt: string
  endedAt?: string
}
export type AgentChatTimelineEntry = AgentChatTimelineEntryBase & (
  { kind: 'reasoning' | 'content'; text: string; status: RuntimeRunStatus; incomplete: boolean }
  | { kind: 'tool'; tool: string; modelCallId: string; callIndex: number; argumentsJson: string; callId?: string; status: AgentChatToolStatus; error?: RuntimeFailure; truncated: boolean }
)
/** 只读展示投影，条目按推理请求及工具调用顺序排列；终答由公开消息确认。 */
export type AgentChatTimelineSnapshot = {
  runId: string
  status: RuntimeRunStatus
  done: boolean
  usage?: RuntimeUsage
  finalResponseId?: string
  entries: readonly AgentChatTimelineEntry[]
}

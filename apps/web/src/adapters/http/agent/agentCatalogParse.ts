import { validAgentModelReasoningLevels } from '@elysian/contracts'
import type {
  AgentModelCapabilities,
  AgentModelReasoningLevel,
  AgentModelProfile,
  AgentModelService,
  AgentModelProvider,
  AgentModelAPIFormat,
} from '@elysian/contracts'

/** 模型服务、模型配置与能力声明的公开响应解析。 */
function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

export function parseAgentModelCapabilities(value: unknown): AgentModelCapabilities {
  const row = object(value, 'Agent 模型能力无效')
  if (typeof row.text !== 'boolean' || typeof row.tools !== 'boolean' || typeof row.source !== 'string') {
    throw new Error('Agent 模型能力无效')
  }
  const optionalBoolean = (key: string): boolean | undefined => {
    if (row[key] === undefined) return undefined
    if (typeof row[key] !== 'boolean') throw new Error('Agent 模型能力无效')
    return row[key]
  }
  let reasoningLevels: readonly AgentModelReasoningLevel[] | undefined
  if (row.reasoningLevels !== undefined) {
    if (!validAgentModelReasoningLevels(row.reasoningLevels)) {
      throw new Error('Agent 模型推理等级无效')
    }
    reasoningLevels = row.reasoningLevels
  }
  const image = optionalBoolean('image')
  const video = optionalBoolean('video')
  const pdf = optionalBoolean('pdf')
  const structuredOutput = optionalBoolean('structuredOutput')
  const webSearch = optionalBoolean('webSearch')
  const systemMessages = optionalBoolean('systemMessages')
  return {
    text: row.text,
    tools: row.tools,
    source: row.source,
    ...(image === undefined ? {} : { image }),
    ...(video === undefined ? {} : { video }),
    ...(pdf === undefined ? {} : { pdf }),
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(systemMessages === undefined ? {} : { systemMessages }),
    ...(reasoningLevels === undefined ? {} : { reasoningLevels }),
  }
}

export function parseAgentModelService(value: unknown): AgentModelService {
  const row = object(value, 'Agent 模型服务响应无效')
  if (!Array.isArray(row.models) || row.models.length === 0) throw new Error('Agent 模型服务响应无效')
  const models = row.models.map((item: unknown) => {
    const model = object(item, 'Agent 服务模型无效')
    return { ...parseAgentModelProfile(item), enabled: boolean(model.enabled, 'Agent 服务模型开关无效') }
  })
  const first = models[0]!
  if (row.provider !== first.provider || row.apiFormat !== first.apiFormat || row.baseUrl !== first.baseUrl || row.hasCredential !== first.hasCredential || models.some(model => model.provider !== row.provider || model.apiFormat !== row.apiFormat || model.baseUrl !== row.baseUrl || model.hasCredential !== row.hasCredential || model.active !== (row.active && model.enabled))) throw new Error('Agent 模型服务配置不一致')
  return { id: string(row.id, 'Agent 模型服务响应无效'), revision: positiveInteger(row.revision, 'Agent 模型服务响应无效'), name: string(row.name, 'Agent 模型服务响应无效'), provider: first.provider, apiFormat: first.apiFormat, baseUrl: first.baseUrl, hasCredential: first.hasCredential, active: boolean(row.active, 'Agent 模型服务响应无效'), models }
}

export function parseAgentModelProfile(value: unknown): AgentModelProfile {
  const row = object(value, 'Agent 模型配置响应无效')
  const provider: AgentModelProvider = row.provider === 'openai-compatible' || row.provider === 'deepseek' ? row.provider
      : (() => { throw new Error('Agent 模型供应商无效') })()
  const apiFormat: AgentModelAPIFormat = row.apiFormat === 'chat-completions' || row.apiFormat === 'anthropic-messages' || row.apiFormat === 'responses' ? row.apiFormat
      : (() => { throw new Error('Agent 模型 API 格式无效') })()
  return {
    provider,
    apiFormat,
    id: string(row.id, 'Agent 模型配置响应无效'),
    revision: positiveInteger(row.revision, 'Agent 模型配置响应无效'),
    name: string(row.name, 'Agent 模型配置响应无效'),
    baseUrl: string(row.baseUrl, 'Agent 模型配置响应无效'),
    model: string(row.model, 'Agent 模型配置响应无效'),
    contextTokens: positiveInteger(row.contextTokens, 'Agent 模型配置响应无效'),
    outputTokens: positiveInteger(row.outputTokens, 'Agent 模型配置响应无效'),
    capabilities: parseAgentModelCapabilities(row.capabilities),
    active: boolean(row.active, 'Agent 模型配置响应无效'),
    hasCredential: boolean(row.hasCredential, 'Agent 模型配置响应无效'),
  }
}

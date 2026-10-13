import { getAgentModelPreset, validAgentModelReasoningLevels } from '@elysian/contracts'
import type { AgentModelProfile, AgentModelService, AgentModelServiceInput, AgentModelProfileInput } from '@elysian/contracts'

/** 系统设置的确定性模型演示数据；凭据只写不回显，更新核对修订。 */
let idTicks = 0

function nextId(prefix: string): string {
  return `${prefix}-${100 + idTicks++}`
}

export class ModelSettingsMockError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ModelSettingsMockError'
    this.status = status
    this.code = code
  }
}

type ModelRecord = { profile: AgentModelProfile; credential: string; removed?: boolean }
const modelRecords: ModelRecord[] = []

function seedModels(): void {
  const credential = 'demo-secret-token'
  modelRecords.push(
    {
      profile: {
        id: 'mp-ely-main', revision: 1, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 128000, outputTokens: 4096, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ely-main', revision: 2, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 160000, outputTokens: 8192, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ely-main', revision: 3, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 200000, outputTokens: 8192, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ollama-local', revision: 1, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:32b',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32768, outputTokens: 4096, capabilities: { text: true, tools: true, source: '本机探测' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-deepseek-backup', revision: 1, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        provider: 'deepseek', apiFormat: 'chat-completions' as const, contextTokens: 1048576, outputTokens: 393216, capabilities: getAgentModelPreset('deepseek', 'deepseek-flash')!.capabilities,
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-deepseek-backup', revision: 2, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        provider: 'deepseek', apiFormat: 'chat-completions' as const, contextTokens: 1048576, outputTokens: 393216, capabilities: getAgentModelPreset('deepseek', 'deepseek-flash')!.capabilities,
        active: false, hasCredential: true,
      },
      credential,
    },
  )
}

function conflict(): ModelSettingsMockError {
  return new ModelSettingsMockError(409, 'revision-conflict', '模型配置已被修改，请重新读取后重试')
}

function loopbackHost(host: string): boolean {
  const lowered = host.toLowerCase()
  return lowered === '127.0.0.1' || lowered === '::1' || lowered === 'localhost'
}

function validateModelInput(input: AgentModelProfileInput, credential = input.credential ?? ''): void {
  if (input.apiFormat !== 'chat-completions' && input.apiFormat !== 'anthropic-messages' && input.apiFormat !== 'responses') {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型 API 格式无效')
  }
  if (input.provider !== 'openai-compatible' && input.provider !== 'deepseek') {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型供应商必须是 OpenAI 兼容接口或 DeepSeek')
  }
  if (credential.trim() === '') {
    throw new ModelSettingsMockError(400, 'invalid-profile', '请配置 API Key')
  }
  if (!input.baseUrl.trim() || input.baseUrl.length > 2048 ||
    !input.model.trim() || input.model.length > 200 || !input.capabilities.source.trim() || input.capabilities.source.length > 80) {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型服务地址、模型标识与能力来源必须是有效文本')
  }
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型服务地址必须是无凭据、查询参数或片段的 HTTP 或 HTTPS 地址')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== '' ||
    url.search !== '' || url.hash !== '') {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型服务地址必须是无凭据、查询参数或片段的 HTTP 或 HTTPS 地址')
  }
  if (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 1 || input.contextTokens > 2_000_000 ||
    !Number.isSafeInteger(input.outputTokens) || input.outputTokens < 1 || input.outputTokens > input.contextTokens) {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型上下文与输出上限必须为有效的正整数，输出不能超过上下文')
  }
  const reasoningLevels = input.capabilities.reasoningLevels ?? []
  if (!validAgentModelReasoningLevels(reasoningLevels)) {
    throw new ModelSettingsMockError(400, 'invalid-profile', '模型推理等级无效或重复')
  }
  {
    if (credential.length > 8192 || /[\u0000-\u001f\u007f]/.test(credential)) {
      throw new ModelSettingsMockError(400, 'invalid-profile', '模型凭据格式无效')
    }
    if (url.protocol === 'http:' && credential !== '' && !loopbackHost(url.hostname)) {
      throw new ModelSettingsMockError(400, 'invalid-profile', 'HTTP 模型服务地址携带凭据时仅允许本机回环地址，请改用 HTTPS')
    }
  }
}

export function mockListModelProfiles(): readonly AgentModelProfile[] {
  const latestById = new Map<string, AgentModelProfile>()
  for (const record of modelRecords) {
    latestById.set(record.profile.id, record.profile)
  }
  return [...latestById.values()].filter(profile => ![...modelRecords].reverse().find(record => record.profile.id === profile.id)?.removed)
}

export function mockGetModelProfile(id: string, revision?: number): AgentModelProfile {
  if (revision === undefined) {
    for (let index = modelRecords.length - 1; index >= 0; index -= 1) {
      const record = modelRecords[index]
      if (record !== undefined && record.profile.id === id) return record.profile
    }
    throw new ModelSettingsMockError(404, 'profile-not-found', '模型配置不存在')
  }
  const hit = modelRecords.find((record) => record.profile.id === id && record.profile.revision === revision)
  if (hit === undefined) throw new ModelSettingsMockError(404, 'profile-revision-not-found', '模型配置修订不存在')
  return hit.profile
}

export function mockCreateModelProfile(input: AgentModelProfileInput): AgentModelProfile {
  validateModelInput(input)
  const id = nextId('mp')
  const credential = input.credential ?? ''
  const profile: AgentModelProfile = {
    id, revision: 1, baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(), provider: input.provider, apiFormat: input.apiFormat, contextTokens: input.contextTokens, outputTokens: input.outputTokens,
    capabilities: { ...structuredClone(input.capabilities), source: input.capabilities.source.trim() },
    active: input.active, hasCredential: credential !== '',
  }
  modelRecords.push({ profile, credential })
  return profile
}

export function mockUpdateModelProfile(id: string, input: AgentModelProfileInput & { expectedRevision: number }): AgentModelProfile {
  let current: ModelRecord | undefined
  for (let index = modelRecords.length - 1; index >= 0; index -= 1) {
    const record = modelRecords[index]
    if (record !== undefined && record.profile.id === id) {
      current = record
      break
    }
  }
  if (current === undefined) throw new ModelSettingsMockError(404, 'profile-not-found', '模型配置不存在')
  if (current.profile.service || current.removed) throw new ModelSettingsMockError(409, 'service-managed-profile', '请通过模型服务配置更新该模型')
  if (current.profile.revision !== input.expectedRevision) throw conflict()
  const credential = input.credential === undefined ? current.credential : input.credential
  validateModelInput(input, credential)
  const profile: AgentModelProfile = {
    id, revision: current.profile.revision + 1,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), model: input.model.trim(),
    provider: input.provider, apiFormat: input.apiFormat, contextTokens: input.contextTokens, outputTokens: input.outputTokens,
    capabilities: { ...structuredClone(input.capabilities), source: input.capabilities.source.trim() },
    active: input.active, hasCredential: credential !== '',
  }
  modelRecords.push({ profile, credential })
  return profile
}

export function mockListModelServices(): readonly AgentModelService[] {
  const groups = new Map<string, AgentModelService>()
  for (const profile of mockListModelProfiles()) {
    const ref = profile.service
    const id = ref?.id ?? profile.id
    const service = groups.get(id) ?? { id, revision: ref?.revision ?? profile.revision, name: ref?.name ?? profile.model, provider: profile.provider, apiFormat: profile.apiFormat, baseUrl: profile.baseUrl, active: ref?.active ?? profile.active, hasCredential: profile.hasCredential, models: [] }
    groups.set(id, { ...service, models: [...service.models, { ...profile, enabled: ref?.enabled ?? profile.active }] })
  }
  return [...groups.values()]
}

export function mockSaveModelService(input: AgentModelServiceInput, id?: string, expectedRevision?: number): AgentModelService {
  const old = id ? mockListModelServices().find(service => service.id === id) : undefined
  if (id && !old) throw new ModelSettingsMockError(404, 'service-not-found', '模型服务不存在')
  if (old && old.revision !== expectedRevision) throw conflict()
  if (!input.name.trim() || input.name.length > 120 || input.models.length < 1 || input.models.length > 64) throw new ModelSettingsMockError(400, 'invalid-service', '请填写服务名称，并配置 1 至 64 个模型')
  const previous = [...modelRecords].reverse().find(record => record.profile.id === old?.models[0]?.id)
  const credential = input.credential ?? previous?.credential ?? ''
  if (input.provider === 'deepseek' && input.active && !credential.trim()) throw new ModelSettingsMockError(400, 'invalid-profile', '启用 DeepSeek 服务前请配置 API Key')
  const seenIds = new Set<string>(), seenModels = new Set<string>()
  for (const row of input.models) {
    if (row.id && (!old?.models.some(model => model.id === row.id) || seenIds.has(row.id))) throw new ModelSettingsMockError(400, 'invalid-service', '模型编号不属于当前服务或重复')
    if (seenModels.has(row.model.trim())) throw new ModelSettingsMockError(400, 'invalid-service', '同一服务不能重复配置相同模型标识')
    seenIds.add(row.id ?? ''); seenModels.add(row.model.trim())
    validateModelInput({ ...input, ...row, active: input.active && row.enabled }, credential)
  }
  const serviceId = id ?? nextId('service')
  const revision = (old?.revision ?? 0) + 1
  const records = input.models.map(row => {
    const prior = old?.models.find(model => model.id === row.id)
    const profile: AgentModelProfile = { id: row.id ?? nextId('mp'), revision: (prior?.revision ?? 0) + 1, model: row.model.trim(), baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), provider: input.provider, apiFormat: input.apiFormat, contextTokens: row.contextTokens, outputTokens: row.outputTokens, capabilities: { ...structuredClone(row.capabilities), source: row.capabilities.source.trim() }, active: input.active && row.enabled, hasCredential: credential !== '', service: { id: serviceId, revision, name: input.name.trim(), active: input.active, enabled: row.enabled } }
    return { profile, credential }
  })
  const removed = (old?.models ?? []).filter(model => !seenIds.has(model.id)).map(model => ({ profile: { ...model, active: false, revision: model.revision + 1 }, credential: previous?.credential ?? '', removed: true }))
  modelRecords.push(...records, ...removed)
  return mockListModelServices().find(service => service.id === serviceId)!
}

export function resetModelSettingsData(): void {
  modelRecords.length = 0
  idTicks = 0
  seedModels()
}

resetModelSettingsData()

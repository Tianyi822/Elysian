import { getAgentModelPreset, validAgentModelReasoningLevels } from '@elysian/contracts'
import type {
  AgentExecutionGrant,
  AgentExecutionGrantInput,
  AgentExecutionProfile,
  AgentExecutionProfileInput,
  AgentExecutionRuntime,
  AgentModelProfile,
  AgentModelService,
  AgentModelServiceInput,
  AgentModelProfileInput,
  AgentResourceRule,
  AgentResourceRuleInput,
} from '@elysian/contracts'

/*
 * Ely 模型与执行配置域演示数据集。种子行手工固定（确定性可复现），会话内的
 * 增改启停落在这份内存数据上，刷新回到种子状态。状态机遵守服务端语义：
 * 修订不可变（更新追加新修订）、expectedRevision CAS、凭据只写不回显、
 * 新建禁止自带编号、路径与编号不一致拒绝、执行限额只收不放宽。
 */

/** 演示时钟：种子之后的每次写操作递增一分钟，保证时间确定性可复现。 */
const SEED_BASE_MILLIS = Date.parse('2026-10-11T09:00:00Z')
let clockTicks = 0
let idTicks = 0

function mockNow(): string {
  return new Date(SEED_BASE_MILLIS + clockTicks++ * 60_000).toISOString()
}

/** 新建条目的确定性编号：与种子字符串编号不冲突。 */
function nextId(prefix: string): string {
  return `${prefix}-${100 + idTicks++}`
}

/** 确定性内容摘要：仅演示用，与服务端真实 digest 算法无关。 */
function mockDigest(content: string): string {
  let hash1 = 0x811c9dc5
  let hash2 = 0x01000193
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    hash1 = ((hash1 ^ code) * 0x01000193) >>> 0
    hash2 = ((hash2 + code * (index + 7)) * 0x85ebca6b) >>> 0
  }
  const hex = (value: number) => value.toString(16).padStart(8, '0')
  return `${hex(hash1)}${hex(hash2)}${hex(hash1 ^ hash2)}${hex((hash1 + hash2) >>> 0)}${hex(hash2 ^ 0xdeadbeef)}${hex((hash1 * 31) >>> 0)}${hex(hash1 >>> 1)}${hex(hash2 >>> 2)}`
}

/** 与服务端 {error,code} 同构的 mock 错误：status 供排障，code 供冲突判定。 */
export class AgentCapabilitiesMockError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AgentCapabilitiesMockError'
    this.status = status
    this.code = code
  }
}

type ModelRecord = { profile: AgentModelProfile; credential: string; removed?: boolean }
type VersionedRecord<T> = { id: string; item: T }

const modelRecords: ModelRecord[] = []
const executionRecords: VersionedRecord<AgentExecutionProfile>[] = []
const grantRecords: VersionedRecord<AgentExecutionGrant>[] = []
const ruleRecords: VersionedRecord<AgentResourceRule>[] = []
let runtimeRecords: readonly AgentExecutionRuntime[] = []

function seedModels(): void {
  const credential = 'demo-secret-token'
  modelRecords.push(
    {
      profile: {
        id: 'mp-ely-main', revision: 1, name: '主力模型', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 128000, outputTokens: 4096, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ely-main', revision: 2, name: '主力模型', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 160000, outputTokens: 8192, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ely-main', revision: 3, name: '主力模型', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 200000, outputTokens: 8192, capabilities: { text: true, tools: true, source: '管理员配置' },
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-ollama-local', revision: 1, name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:32b',
        provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32768, outputTokens: 4096, capabilities: { text: true, tools: true, source: '本机探测' },
        active: true, hasCredential: false,
      },
      credential: '',
    },
    {
      profile: {
        id: 'mp-deepseek-backup', revision: 1, name: '备用 DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        provider: 'deepseek', apiFormat: 'chat-completions' as const, contextTokens: 1048576, outputTokens: 393216, capabilities: getAgentModelPreset('deepseek', 'deepseek-flash')!.capabilities,
        active: true, hasCredential: true,
      },
      credential,
    },
    {
      profile: {
        id: 'mp-deepseek-backup', revision: 2, name: '备用 DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        provider: 'deepseek', apiFormat: 'chat-completions' as const, contextTokens: 1048576, outputTokens: 393216, capabilities: getAgentModelPreset('deepseek', 'deepseek-flash')!.capabilities,
        active: false, hasCredential: true,
      },
      credential,
    },
  )
}

function seedExecutionProfiles(): void {
  executionRecords.push(
    {
      id: 'ep-python-tools',
      item: {
        id: 'ep-python-tools', revision: 1, enabled: true, name: 'Python 工具执行',
        image: `registry.example.com/elysian/python-tools@sha256:${'a1b2c3d4'.repeat(8)}`, runtime: 'python',
        command: ['python3', '-'], timeoutSeconds: 30, cpuMillis: 500, memoryBytes: 536870912, pids: 64,
        createdAt: '2026-09-02T08:30:00Z',
      },
    },
    {
      id: 'ep-python-tools',
      item: {
        id: 'ep-python-tools', revision: 2, enabled: true, name: 'Python 工具执行',
        image: `registry.example.com/elysian/python-tools@sha256:${'a1b2c3d4'.repeat(8)}`, runtime: 'python',
        command: ['python3', '-'], timeoutSeconds: 60, cpuMillis: 500, memoryBytes: 268435456, pids: 48,
        createdAt: '2026-09-18T10:12:00Z',
      },
    },
    {
      id: 'ep-node-build',
      item: {
        id: 'ep-node-build', revision: 1, enabled: true, name: 'Node 构建执行',
        image: `registry.example.com/elysian/node-build@sha256:${'9f8e7d6c'.repeat(8)}`, runtime: 'node',
        command: ['node', '-'], timeoutSeconds: 120, cpuMillis: 800, memoryBytes: 536870912, pids: 96,
        createdAt: '2026-09-20T14:05:00Z',
      },
    },
    {
      id: 'ep-bash-audit',
      item: {
        id: 'ep-bash-audit', revision: 1, enabled: false, name: 'Bash 审计执行',
        image: `registry.example.com/elysian/bash-audit@sha256:${'0a1b2c3d'.repeat(8)}`, runtime: 'bash',
        command: ['bash', '-'], timeoutSeconds: 15, cpuMillis: 200, memoryBytes: 134217728, pids: 32,
        createdAt: '2026-09-25T09:44:00Z',
      },
    },
  )
}

function seedGrants(): void {
  grantRecords.push(
    {
      id: 'eg-project-readonly',
      item: {
        id: 'eg-project-readonly', revision: 1, enabled: true, name: '项目数据只读',
        directories: [{ path: '/srv/projects/panel', access: 'ro' }], network: [], privateCidrs: [],
        createdAt: '2026-09-05T11:00:00Z',
      },
    },
    {
      id: 'eg-project-readonly',
      item: {
        id: 'eg-project-readonly', revision: 2, enabled: true, name: '项目数据只读',
        directories: [{ path: '/srv/projects/panel', access: 'ro' }],
        network: [{ scheme: 'https', host: 'registry.example.com', port: 443 }],
        privateCidrs: [], createdAt: '2026-09-22T16:40:00Z',
      },
    },
    {
      id: 'eg-pypi-proxy',
      item: {
        id: 'eg-pypi-proxy', revision: 1, enabled: true, name: 'PyPI 出网',
        directories: [],
        network: [
          { scheme: 'https', host: 'pypi.org', port: 443 },
          { scheme: 'https', host: 'files.pythonhosted.org', port: 443 },
        ],
        privateCidrs: [], createdAt: '2026-09-08T13:26:00Z',
      },
    },
    {
      id: 'eg-legacy-disabled',
      item: {
        id: 'eg-legacy-disabled', revision: 1, enabled: false, name: '遗留授权（停用）',
        directories: [{ path: '/srv/legacy', access: 'rw' }], network: [], privateCidrs: [],
        createdAt: '2026-08-30T07:15:00Z',
      },
    },
  )
}

function seedResourceRules(): void {
  ruleRecords.push(
    {
      id: 'rr-registry-mirror',
      item: {
        id: 'rr-registry-mirror', revision: 1, digest: mockDigest('rr-registry-mirror:1'), createdAt: '2026-09-12T10:00:00Z',
        name: '注册表镜像映射', enabled: true, complete: true,
        selector: {
          source: 'mcp-tool',
          ref: { id: 'mcp-server-registry', revision: 3, digest: mockDigest('catalog:mcp-server-registry:3') },
          originalName: 'registry_lookup', catalogDigest: mockDigest('catalog:mcp-server-registry:3'),
        },
        mappings: [{ kind: 'registry-entry', authority: 'mcp', access: 'read', literal: 'registry/entries' }],
      },
    },
    {
      id: 'rr-registry-mirror',
      item: {
        id: 'rr-registry-mirror', revision: 2, digest: mockDigest('rr-registry-mirror:2'), createdAt: '2026-09-29T15:30:00Z',
        name: '注册表镜像映射', enabled: true, complete: true,
        selector: {
          source: 'mcp-tool',
          ref: { id: 'mcp-server-registry', revision: 3, digest: mockDigest('catalog:mcp-server-registry:3') },
          originalName: 'registry_lookup', catalogDigest: mockDigest('catalog:mcp-server-registry:3'),
        },
        mappings: [
          { kind: 'registry-entry', authority: 'mcp', access: 'read', literal: 'registry/entries' },
          { kind: 'registry-entry', authority: 'mcp', access: 'write', pointer: '/results/0' },
        ],
      },
    },
    {
      id: 'rr-script-config',
      item: {
        id: 'rr-script-config', revision: 1, digest: mockDigest('rr-script-config:1'), createdAt: '2026-10-02T09:20:00Z',
        name: '脚本配置键映射', enabled: true, complete: false,
        selector: { source: 'script', ref: { id: 'skill-bundle-config', revision: 1, digest: mockDigest('skill:config:1') } },
        mappings: [{ kind: 'config-key', authority: 'script', access: 'read', pointer: '/config/keys' }],
      },
    },
  )
}

function seedRuntimes(): void {
  runtimeRecords = [
    {
      id: 'exr-7f3a2c', containerId: `c9e1ab5d4f${'3f2a1b'.repeat(4)}`,
      serverId: 'mcp-server-registry', serverRevision: 3, state: 'running',
    },
  ]
}

function reseed(): void {
  modelRecords.length = 0
  executionRecords.length = 0
  grantRecords.length = 0
  ruleRecords.length = 0
  clockTicks = 0
  idTicks = 0
  seedModels()
  seedExecutionProfiles()
  seedGrants()
  seedResourceRules()
  seedRuntimes()
}

reseed()

/** 演示种子复位：回到确定性初始状态（刷新即回种子，同口径）。 */
export function resetAgentCapabilitiesData(): void {
  reseed()
}

function latestById<T extends { id: string }>(records: readonly { id: string; item: T }[], id: string): T | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record !== undefined && record.item.id === id) return record.item
  }
  return undefined
}

/** 各编号取最新修订（记录按插入序追加，最后一次出现即最新），保持首次创建顺序。 */
function listLatest<T extends { id: string }>(records: readonly { id: string; item: T }[]): readonly T[] {
  const latestById = new Map<string, T>()
  for (const record of records) {
    latestById.set(record.item.id, record.item)
  }
  return [...latestById.values()]
}

function conflict(domain: '模型配置' | '执行环境' | '执行授权' | '资源规则'): AgentCapabilitiesMockError {
  const code = domain === '模型配置' || domain === '资源规则' ? 'revision-conflict' : 'execution_revision_conflict'
  const message = domain === '模型配置' ? '模型配置已被修改，请重新读取后重试'
    : domain === '执行环境' ? '执行环境已被修改，请重新读取后重试'
      : domain === '执行授权' ? '执行授权已被修改，请重新读取后重试'
        : '资源规则修订已变化'
  return new AgentCapabilitiesMockError(409, code, message)
}

function loopbackHost(host: string): boolean {
  const lowered = host.toLowerCase()
  return lowered === '127.0.0.1' || lowered === '::1' || lowered === 'localhost'
}

function validateModelInput(input: AgentModelProfileInput, credential = input.credential ?? ''): void {
  if (input.apiFormat !== 'chat-completions' && input.apiFormat !== 'anthropic-messages' && input.apiFormat !== 'responses') {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型 API 格式无效')
  }
  if (input.provider !== 'openai-compatible' && input.provider !== 'deepseek') {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型供应商必须是 OpenAI 兼容接口或 DeepSeek')
  }
  if (input.provider === 'deepseek' && input.active && credential.trim() === '') {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '启用 DeepSeek 模型前请配置 API Key')
  }
  if (!input.name.trim() || input.name.length > 120 || !input.baseUrl.trim() || input.baseUrl.length > 2048 ||
    !input.model.trim() || input.model.length > 200 || !input.capabilities.source.trim() || input.capabilities.source.length > 80) {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型名称、服务地址、模型标识与能力来源必须是有效文本')
  }
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型服务地址必须是无凭据、查询参数或片段的 HTTP 或 HTTPS 地址')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== '' ||
    url.search !== '' || url.hash !== '') {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型服务地址必须是无凭据、查询参数或片段的 HTTP 或 HTTPS 地址')
  }
  if (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 1 || input.contextTokens > 2_000_000 ||
    !Number.isSafeInteger(input.outputTokens) || input.outputTokens < 1 || input.outputTokens > input.contextTokens) {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型上下文与输出上限必须为有效的正整数，输出不能超过上下文')
  }
  const reasoningLevels = input.capabilities.reasoningLevels ?? []
  if (!validAgentModelReasoningLevels(reasoningLevels)) {
    throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型推理等级无效或重复')
  }
  {
    if (credential.length > 8192 || /[\u0000-\u001f\u007f]/.test(credential)) {
      throw new AgentCapabilitiesMockError(400, 'invalid-profile', '模型凭据格式无效')
    }
    if (url.protocol === 'http:' && credential !== '' && !loopbackHost(url.hostname)) {
      throw new AgentCapabilitiesMockError(400, 'invalid-profile', 'HTTP 模型服务地址携带凭据时仅允许本机回环地址，请改用 HTTPS 或清除凭据')
    }
  }
}

/** 模型公开列表：各编号取最新修订，凭据不回显（只有 hasCredential 布尔）。 */
export function mockListModelProfiles(): readonly AgentModelProfile[] {
  const latestById = new Map<string, AgentModelProfile>()
  for (const record of modelRecords) {
    latestById.set(record.profile.id, record.profile)
  }
  return [...latestById.values()].filter(profile => ![...modelRecords].reverse().find(record => record.profile.id === profile.id)?.removed)
}

/** 服务端无模型单读端点；本函数供演示与测试核对修订事实。 */
export function mockGetModelProfile(id: string, revision?: number): AgentModelProfile {
  if (revision === undefined) {
    for (let index = modelRecords.length - 1; index >= 0; index -= 1) {
      const record = modelRecords[index]
      if (record !== undefined && record.profile.id === id) return record.profile
    }
    throw new AgentCapabilitiesMockError(404, 'profile-not-found', '模型配置不存在')
  }
  const hit = modelRecords.find((record) => record.profile.id === id && record.profile.revision === revision)
  if (hit === undefined) throw new AgentCapabilitiesMockError(404, 'profile-revision-not-found', '模型配置修订不存在')
  return hit.profile
}

/** 创建：credential 省略即无凭据；返回公开修订（凭据只写不回显）。 */
export function mockCreateModelProfile(input: AgentModelProfileInput): AgentModelProfile {
  validateModelInput(input)
  const id = nextId('mp')
  const credential = input.credential ?? ''
  const profile: AgentModelProfile = {
    id, revision: 1, name: input.name.trim(), baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(), provider: input.provider, apiFormat: input.apiFormat, contextTokens: input.contextTokens, outputTokens: input.outputTokens,
    capabilities: { ...structuredClone(input.capabilities), source: input.capabilities.source.trim() },
    active: input.active, hasCredential: credential !== '',
  }
  modelRecords.push({ profile, credential })
  return profile
}

/** 更新：expectedRevision CAS；credential 省略沿用旧值、空串清除；追加新修订。 */
export function mockUpdateModelProfile(id: string, input: AgentModelProfileInput & { expectedRevision: number }): AgentModelProfile {
  let current: ModelRecord | undefined
  for (let index = modelRecords.length - 1; index >= 0; index -= 1) {
    const record = modelRecords[index]
    if (record !== undefined && record.profile.id === id) {
      current = record
      break
    }
  }
  if (current === undefined) throw new AgentCapabilitiesMockError(404, 'profile-not-found', '模型配置不存在')
  if (current.profile.service || current.removed) throw new AgentCapabilitiesMockError(409, 'service-managed-profile', '请通过模型服务配置更新该模型')
  if (current.profile.revision !== input.expectedRevision) throw conflict('模型配置')
  const credential = input.credential === undefined ? current.credential : input.credential
  validateModelInput(input, credential)
  const profile: AgentModelProfile = {
    id, revision: current.profile.revision + 1, name: input.name.trim(),
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
    const service = groups.get(id) ?? { id, revision: ref?.revision ?? profile.revision, name: ref?.name ?? profile.name, provider: profile.provider, apiFormat: profile.apiFormat, baseUrl: profile.baseUrl, active: ref?.active ?? profile.active, hasCredential: profile.hasCredential, models: [] }
    groups.set(id, { ...service, models: [...service.models, { ...profile, enabled: ref?.enabled ?? profile.active }] })
  }
  return [...groups.values()]
}

export function mockSaveModelService(input: AgentModelServiceInput, id?: string, expectedRevision?: number): AgentModelService {
  const old = id ? mockListModelServices().find(service => service.id === id) : undefined
  if (id && !old) throw new AgentCapabilitiesMockError(404, 'service-not-found', '模型服务不存在')
  if (old && old.revision !== expectedRevision) throw conflict('模型配置')
  if (!input.name.trim() || input.name.length > 120 || input.models.length < 1 || input.models.length > 64) throw new AgentCapabilitiesMockError(400, 'invalid-service', '请填写服务名称，并配置 1 至 64 个模型')
  const previous = [...modelRecords].reverse().find(record => record.profile.id === old?.models[0]?.id)
  const credential = input.credential ?? previous?.credential ?? ''
  if (input.provider === 'deepseek' && input.active && !credential.trim()) throw new AgentCapabilitiesMockError(400, 'invalid-profile', '启用 DeepSeek 服务前请配置 API Key')
  const seenIds = new Set<string>(), seenModels = new Set<string>()
  for (const row of input.models) {
    if (row.id && (!old?.models.some(model => model.id === row.id) || seenIds.has(row.id))) throw new AgentCapabilitiesMockError(400, 'invalid-service', '模型编号不属于当前服务或重复')
    if (seenModels.has(row.model.trim())) throw new AgentCapabilitiesMockError(400, 'invalid-service', '同一服务不能重复配置相同模型标识')
    seenIds.add(row.id ?? ''); seenModels.add(row.model.trim())
    validateModelInput({ ...input, ...row, active: input.active && row.enabled }, credential)
  }
  const serviceId = id ?? nextId('service')
  const revision = (old?.revision ?? 0) + 1
  const records = input.models.map(row => {
    const prior = old?.models.find(model => model.id === row.id)
    const profile: AgentModelProfile = { id: row.id ?? nextId('mp'), revision: (prior?.revision ?? 0) + 1, name: row.name.trim(), model: row.model.trim(), baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), provider: input.provider, apiFormat: input.apiFormat, contextTokens: row.contextTokens, outputTokens: row.outputTokens, capabilities: { ...structuredClone(row.capabilities), source: row.capabilities.source.trim() }, active: input.active && row.enabled, hasCredential: credential !== '', service: { id: serviceId, revision, name: input.name.trim(), active: input.active, enabled: row.enabled } }
    return { profile, credential }
  })
  const removed = (old?.models ?? []).filter(model => !seenIds.has(model.id)).map(model => ({ profile: { ...model, active: false, revision: model.revision + 1 }, credential: previous?.credential ?? '', removed: true }))
  modelRecords.push(...records, ...removed)
  return mockListModelServices().find(service => service.id === serviceId)!
}

function validateExecutionInput(input: AgentExecutionProfileInput): void {
  if (!input.name.trim() || !input.image.trim()) {
    throw new AgentCapabilitiesMockError(400, 'execution_invalid_profile', '执行配置名称或镜像无效，镜像必须固定为仓库名与完整 SHA-256 摘要')
  }
  if (input.runtime !== 'python' && input.runtime !== 'node' && input.runtime !== 'bash') {
    throw new AgentCapabilitiesMockError(400, 'execution_invalid_runtime', '执行环境只能为 Python、Node 或 Bash')
  }
  if (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > 64 || input.command[0] === '' ||
    input.command.some((part) => typeof part !== 'string' || part.includes('\0') || new TextEncoder().encode(part).length > 4096) ||
    new TextEncoder().encode(input.command.join('')).length > 16 * 1024) {
    throw new AgentCapabilitiesMockError(400, 'execution_invalid_command', '容器命令必须包含 1 至 64 个参数')
  }
  if (input.timeoutSeconds < 1 || input.timeoutSeconds > 300 || input.cpuMillis < 1 || input.cpuMillis > 1000 ||
    input.memoryBytes < 1 || input.memoryBytes > 512 * 1024 * 1024 || input.pids < 1 || input.pids > 128) {
    throw new AgentCapabilitiesMockError(400, 'execution_invalid_limits', '执行限额只能收紧，不能超过 5 分钟、1 CPU、512 MiB 内存与 128 个进程')
  }
}

export function mockListExecutionProfiles(): readonly AgentExecutionProfile[] {
  return listLatest(executionRecords)
}

export function mockGetExecutionProfile(id: string, revision?: number): AgentExecutionProfile {
  const hit = revision === undefined
    ? latestById(executionRecords, id)
    : executionRecords.find((record) => record.item.id === id && record.item.revision === revision)?.item
  if (hit === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_profile_not_found', revision === undefined ? '执行环境配置不存在' : '执行环境配置修订不存在')
  }
  return hit
}

function putExecutionProfile(pathId: string, input: AgentExecutionProfileInput): AgentExecutionProfile {
  validateExecutionInput(input)
  if (pathId === '') {
    if (input.id !== undefined && input.id !== '') {
      throw new AgentCapabilitiesMockError(400, 'invalid-id', '新建执行配置不能指定编号')
    }
    if (input.expectedRevision !== 0) {
      throw new AgentCapabilitiesMockError(409, 'execution_revision_conflict', '新建执行环境的预期修订必须为零')
    }
    const item: AgentExecutionProfile = {
      id: nextId('ep'), revision: 1, enabled: input.enabled, name: input.name.trim(), image: input.image.trim(),
      runtime: input.runtime, command: [...input.command], timeoutSeconds: input.timeoutSeconds,
      cpuMillis: input.cpuMillis, memoryBytes: input.memoryBytes, pids: input.pids, createdAt: mockNow(),
    }
    executionRecords.push({ id: item.id, item })
    return item
  }
  if (input.id !== undefined && input.id !== '' && input.id !== pathId) {
    throw new AgentCapabilitiesMockError(400, 'invalid-id', '执行配置编号与路径不一致')
  }
  const current = latestById(executionRecords, pathId)
  if (current === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_profile_not_found', '执行环境配置不存在')
  }
  if (current.revision !== input.expectedRevision) throw conflict('执行环境')
  const item: AgentExecutionProfile = {
    id: pathId, revision: current.revision + 1, enabled: input.enabled, name: input.name.trim(), image: input.image.trim(),
    runtime: input.runtime, command: [...input.command], timeoutSeconds: input.timeoutSeconds,
    cpuMillis: input.cpuMillis, memoryBytes: input.memoryBytes, pids: input.pids, createdAt: mockNow(),
  }
  executionRecords.push({ id: pathId, item })
  return item
}

export function mockCreateExecutionProfile(input: AgentExecutionProfileInput): AgentExecutionProfile {
  return putExecutionProfile('', input)
}

export function mockUpdateExecutionProfile(id: string, input: AgentExecutionProfileInput): AgentExecutionProfile {
  return putExecutionProfile(id, input)
}

export function mockSetExecutionProfileEnabled(id: string, expectedRevision: number, enabled: boolean): AgentExecutionProfile {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new AgentCapabilitiesMockError(400, 'invalid-enabled-input', '启停操作必须指定 enabled 和当前修订')
  }
  const current = latestById(executionRecords, id)
  if (current === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_profile_not_found', '执行环境配置不存在')
  }
  if (current.revision !== expectedRevision) throw conflict('执行环境')
  const item: AgentExecutionProfile = { ...current, revision: current.revision + 1, enabled, createdAt: mockNow() }
  executionRecords.push({ id, item })
  return item
}

function validateGrantInput(input: AgentExecutionGrantInput): void {
  if (!input.name.trim()) {
    throw new AgentCapabilitiesMockError(400, 'execution_invalid_grant', '授权名称无效或授权条目数量超过上限')
  }
  for (const directory of input.directories) {
    if (!directory.path.trim() || (directory.access !== 'ro' && directory.access !== 'rw')) {
      throw new AgentCapabilitiesMockError(400, 'execution_invalid_directory', '目录授权只能指定只读或读写')
    }
  }
  for (const endpoint of input.network) {
    if ((endpoint.scheme !== 'http' && endpoint.scheme !== 'https') || !endpoint.host.trim() ||
      !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      throw new AgentCapabilitiesMockError(400, 'execution_invalid_endpoint', '网络授权必须指定 HTTP 或 HTTPS、精确域名及有效端口')
    }
    if (loopbackHost(endpoint.host)) {
      throw new AgentCapabilitiesMockError(403, 'execution_forbidden_endpoint', '回环与实例元数据地址禁止授权')
    }
  }
  for (const cidr of input.privateCidrs) {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(cidr.trim())) {
      throw new AgentCapabilitiesMockError(400, 'execution_invalid_cidr', '私网授权必须是规范的私有地址网段，不能包含回环、链路本地或元数据地址')
    }
  }
}

export function mockListGrants(): readonly AgentExecutionGrant[] {
  return listLatest(grantRecords)
}

export function mockGetGrant(id: string, revision?: number): AgentExecutionGrant {
  const hit = revision === undefined
    ? latestById(grantRecords, id)
    : grantRecords.find((record) => record.item.id === id && record.item.revision === revision)?.item
  if (hit === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_grant_not_found', revision === undefined ? '执行授权不存在' : '执行授权修订不存在')
  }
  return hit
}

function putGrant(pathId: string, input: AgentExecutionGrantInput): AgentExecutionGrant {
  validateGrantInput(input)
  if (pathId === '') {
    if (input.id !== undefined && input.id !== '') {
      throw new AgentCapabilitiesMockError(400, 'invalid-id', '新建执行授权不能指定编号')
    }
    if (input.expectedRevision !== 0) {
      throw new AgentCapabilitiesMockError(409, 'execution_revision_conflict', '新建执行授权的预期修订必须为零')
    }
    const item: AgentExecutionGrant = {
      id: nextId('eg'), revision: 1, enabled: input.enabled, name: input.name.trim(),
      directories: input.directories.map((directory) => ({ path: directory.path.trim(), access: directory.access })),
      network: input.network.map((endpoint) => ({ ...endpoint, host: endpoint.host.trim() })),
      privateCidrs: input.privateCidrs.map((cidr) => cidr.trim()), createdAt: mockNow(),
    }
    grantRecords.push({ id: item.id, item })
    return item
  }
  if (input.id !== undefined && input.id !== '' && input.id !== pathId) {
    throw new AgentCapabilitiesMockError(400, 'invalid-id', '执行授权编号与路径不一致')
  }
  const current = latestById(grantRecords, pathId)
  if (current === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_grant_not_found', '执行授权不存在')
  }
  if (current.revision !== input.expectedRevision) throw conflict('执行授权')
  const item: AgentExecutionGrant = {
    id: pathId, revision: current.revision + 1, enabled: input.enabled, name: input.name.trim(),
    directories: input.directories.map((directory) => ({ path: directory.path.trim(), access: directory.access })),
    network: input.network.map((endpoint) => ({ ...endpoint, host: endpoint.host.trim() })),
    privateCidrs: input.privateCidrs.map((cidr) => cidr.trim()), createdAt: mockNow(),
  }
  grantRecords.push({ id: pathId, item })
  return item
}

export function mockCreateGrant(input: AgentExecutionGrantInput): AgentExecutionGrant {
  return putGrant('', input)
}

export function mockUpdateGrant(id: string, input: AgentExecutionGrantInput): AgentExecutionGrant {
  return putGrant(id, input)
}

export function mockSetGrantEnabled(id: string, expectedRevision: number, enabled: boolean): AgentExecutionGrant {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new AgentCapabilitiesMockError(400, 'invalid-enabled-input', '启停操作必须指定 enabled 和当前修订')
  }
  const current = latestById(grantRecords, id)
  if (current === undefined) {
    throw new AgentCapabilitiesMockError(404, 'execution_grant_not_found', '执行授权不存在')
  }
  if (current.revision !== expectedRevision) throw conflict('执行授权')
  const item: AgentExecutionGrant = { ...current, revision: current.revision + 1, enabled, createdAt: mockNow() }
  grantRecords.push({ id, item })
  return item
}

function validateResourceRuleInput(input: AgentResourceRuleInput): void {
  if (!input.name.trim() || !Array.isArray(input.mappings) || input.mappings.length < 1 || input.mappings.length > 32) {
    throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源规则必须固定能力来源、修订及 1 至 32 条资源映射')
  }
  const selector = input.selector
  if (selector.source !== 'mcp-tool' && selector.source !== 'mcp-resource' && selector.source !== 'mcp-prompt' && selector.source !== 'script') {
    throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源规则必须固定能力来源、修订及 1 至 32 条资源映射')
  }
  if (!selector.ref.id || !Number.isSafeInteger(selector.ref.revision) || selector.ref.revision < 1) {
    throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源规则必须固定能力来源、修订及 1 至 32 条资源映射')
  }
  if (selector.source !== 'script' && (!selector.originalName || !selector.catalogDigest)) {
    throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', 'MCP 资源规则必须固定原始能力名及目录摘要')
  }
  for (const mapping of input.mappings) {
    if (!mapping.kind || !mapping.authority || (mapping.access !== 'read' && mapping.access !== 'write')) {
      throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源映射必须指定资源类型、真实来源、读写模式及唯一值来源')
    }
    const hasLiteral = mapping.literal !== undefined
    const hasPointer = mapping.pointer !== undefined
    if (hasLiteral === hasPointer) {
      throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源映射必须指定资源类型、真实来源、读写模式及唯一值来源')
    }
    if (hasPointer && !mapping.pointer.startsWith('/')) {
      throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '资源映射 JSON Pointer 无效')
    }
  }
}

export function mockListResourceRules(): readonly AgentResourceRule[] {
  return listLatest(ruleRecords)
}

export function mockGetResourceRule(id: string, revision?: number): AgentResourceRule {
  const hit = revision === undefined
    ? latestById(ruleRecords, id)
    : ruleRecords.find((record) => record.item.id === id && record.item.revision === revision)?.item
  if (hit === undefined) {
    throw new AgentCapabilitiesMockError(404, 'resource-rule-not-found', '资源规则不存在')
  }
  return hit
}

function putResourceRule(pathId: string, expectedRevision: number, input: AgentResourceRuleInput): AgentResourceRule {
  validateResourceRuleInput(input)
  if (pathId === '') {
    if (expectedRevision !== 0) {
      throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '创建资源规则的预期修订必须为零')
    }
    const id = nextId('rr')
    const item: AgentResourceRule = {
      ...input, id, revision: 1, digest: mockDigest(`${id}:1:${JSON.stringify(input)}`), createdAt: mockNow(),
    }
    ruleRecords.push({ id, item })
    return item
  }
  if (expectedRevision < 1) {
    throw new AgentCapabilitiesMockError(400, 'invalid-resource-rule', '更新资源规则必须指定编号及当前修订')
  }
  const current = latestById(ruleRecords, pathId)
  if (current === undefined) {
    throw new AgentCapabilitiesMockError(404, 'resource-rule-not-found', '资源规则不存在')
  }
  if (current.revision !== expectedRevision) throw conflict('资源规则')
  const item: AgentResourceRule = {
    ...input, id: pathId, revision: current.revision + 1,
    digest: mockDigest(`${pathId}:${current.revision + 1}:${JSON.stringify(input)}`), createdAt: mockNow(),
  }
  ruleRecords.push({ id: pathId, item })
  return item
}

export function mockCreateResourceRule(input: AgentResourceRuleInput): AgentResourceRule {
  return putResourceRule('', 0, input)
}

export function mockUpdateResourceRule(id: string, input: AgentResourceRuleInput & { expectedRevision: number }): AgentResourceRule {
  return putResourceRule(id, input.expectedRevision, input)
}

/** 执行器受管进程只读列表；演示环境恒为一条运行中的托管进程。 */
export function mockListExecutionRuntimes(): readonly AgentExecutionRuntime[] {
  return runtimeRecords
}

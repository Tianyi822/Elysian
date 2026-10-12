import { validAgentModelReasoningLevels } from '@elysian/contracts'
import type {
  AgentExecutionGrant,
  AgentExecutionProfile,
  AgentMCPServer,
  AgentModelCapabilities,
  AgentModelReasoningLevel,
  AgentModelProfile,
  AgentModelService,
  AgentModelProvider,
  AgentModelAPIFormat,
  AgentResourceMapping,
  AgentResourceRule,
  AgentResourceSelector,
  AgentRevisionRef,
  AgentSkill,
  AgentSkillSource,
  AgentWorkspaceFile,
} from '@elysian/contracts'

/*
 * Agent 目录实体的共享 parse 纯函数：模型 Profile、技能、MCP 服务、执行 Profile、
 * 目录/网络授权与资源规则。工作台环境选择器与各配置模块复用同一份校验，
 * 形状漂移抛中文错误，不把错误体当空列表。
 */

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

function nonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(message)
  return value
}

function strings(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(message)
  return value as readonly string[]
}

/** 修订引用 {id,revision,digest?}：digest 可选。 */
export function parseAgentRevisionRef(value: unknown, label = '修订引用'): AgentRevisionRef {
  const row = object(value, `Agent ${label}无效`)
  return {
    id: string(row.id, `Agent ${label}无效`),
    revision: positiveInteger(row.revision, `Agent ${label}无效`),
    ...row.digest === undefined ? {} : { digest: string(row.digest, `Agent ${label}无效`) },
  }
}

function parseWorkspaceFile(value: unknown, label: string): AgentWorkspaceFile {
  const row = object(value, `Agent ${label}文件无效`)
  return {
    path: string(row.path, `Agent ${label}文件无效`),
    size: nonNegativeInteger(row.size, `Agent ${label}文件无效`),
    digest: string(row.digest, `Agent ${label}文件无效`),
  }
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

/** 公开模型 Profile；凭据不回显，只有 hasCredential 布尔。 */
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

function parseSkillSource(value: unknown): AgentSkillSource {
  const row = object(value, 'Agent 技能来源无效')
  if (row.kind !== 'directory' && row.kind !== 'zip' && row.kind !== 'git') {
    throw new Error('Agent 技能来源无效')
  }
  return {
    kind: row.kind,
    ...row.path === undefined ? {} : { path: string(row.path, 'Agent 技能来源无效') },
    ...row.url === undefined ? {} : { url: string(row.url, 'Agent 技能来源无效') },
    ...row.ref === undefined ? {} : { ref: string(row.ref, 'Agent 技能来源无效') },
    ...row.subdirectory === undefined ? {} : { subdirectory: string(row.subdirectory, 'Agent 技能来源无效') },
    /** 服务端解析的完整提交；导入请求不接受预填。 */
    ...row.commit === undefined ? {} : { commit: string(row.commit, 'Agent 技能来源无效') },
  }
}

/** 技能条目：不可变内容包摘要加文件清单；manifest 自述不能替代授权。 */
export function parseAgentSkill(value: unknown): AgentSkill {
  const row = object(value, 'Agent 技能响应无效')
  const manifestRow = object(row.manifest, 'Agent 技能清单无效')
  let metadata: Readonly<Record<string, string>> | undefined
  if (manifestRow.metadata !== undefined) {
    const raw = object(manifestRow.metadata, 'Agent 技能清单无效')
    for (const entryValue of Object.values(raw)) {
      if (typeof entryValue !== 'string') throw new Error('Agent 技能清单无效')
    }
    metadata = raw as Readonly<Record<string, string>>
  }
  return {
    id: string(row.id, 'Agent 技能响应无效'),
    revision: positiveInteger(row.revision, 'Agent 技能响应无效'),
    createdAt: string(row.createdAt, 'Agent 技能响应无效'),
    enabled: boolean(row.enabled, 'Agent 技能响应无效'),
    source: parseSkillSource(row.source),
    manifest: {
      name: string(manifestRow.name, 'Agent 技能清单无效'),
      description: string(manifestRow.description, 'Agent 技能清单无效'),
      ...manifestRow.license === undefined ? {} : { license: string(manifestRow.license, 'Agent 技能清单无效') },
      ...manifestRow.compatibility === undefined ? {} : { compatibility: string(manifestRow.compatibility, 'Agent 技能清单无效') },
      ...(metadata === undefined ? {} : { metadata }),
      ...manifestRow.allowedTools === undefined ? {} : { allowedTools: string(manifestRow.allowedTools, 'Agent 技能清单无效') },
    },
    digest: string(row.digest, 'Agent 技能响应无效'),
    bytes: nonNegativeInteger(row.bytes, 'Agent 技能响应无效'),
    files: Array.isArray(row.files) ? row.files.map((item) => parseWorkspaceFile(item, '技能')) : [],
  }
}

/** 公开 MCP 服务投影：不含 credential 与容器 environment。 */
export function parseAgentMCPServer(value: unknown): AgentMCPServer {
  const row = object(value, 'Agent MCP 服务响应无效')
  if (row.transport !== 'streamable-http' && row.transport !== 'stdio') {
    throw new Error('Agent MCP 服务响应无效')
  }
  let stdio: AgentMCPServer['stdio']
  if (row.stdio !== undefined) {
    const spec = object(row.stdio, 'Agent MCP 容器规格无效')
    stdio = {
      image: string(spec.image, 'Agent MCP 容器规格无效'),
      command: strings(spec.command, 'Agent MCP 容器规格无效'),
      hasEnvironment: boolean(spec.hasEnvironment, 'Agent MCP 容器规格无效'),
      ...spec.grantId === undefined ? {} : { grantId: string(spec.grantId, 'Agent MCP 容器规格无效') },
      ...spec.grantRevision === undefined ? {} : { grantRevision: positiveInteger(spec.grantRevision, 'Agent MCP 容器规格无效') },
    }
  }
  return {
    id: string(row.id, 'Agent MCP 服务响应无效'),
    revision: positiveInteger(row.revision, 'Agent MCP 服务响应无效'),
    name: string(row.name, 'Agent MCP 服务响应无效'),
    transport: row.transport,
    ...row.url === undefined ? {} : { url: string(row.url, 'Agent MCP 服务响应无效') },
    ...(stdio === undefined ? {} : { stdio }),
    active: boolean(row.active, 'Agent MCP 服务响应无效'),
    revoked: boolean(row.revoked, 'Agent MCP 服务响应无效'),
    hasCredential: boolean(row.hasCredential, 'Agent MCP 服务响应无效'),
  }
}

/** 执行配置 Profile：runtime 三选一，command 为字符串数组，数值上限由服务端裁决。 */
export function parseAgentExecutionProfile(value: unknown): AgentExecutionProfile {
  const row = object(value, 'Agent 执行配置响应无效')
  if (row.runtime !== 'python' && row.runtime !== 'node' && row.runtime !== 'bash') {
    throw new Error('Agent 执行配置响应无效')
  }
  return {
    id: string(row.id, 'Agent 执行配置响应无效'),
    revision: positiveInteger(row.revision, 'Agent 执行配置响应无效'),
    enabled: boolean(row.enabled, 'Agent 执行配置响应无效'),
    name: string(row.name, 'Agent 执行配置响应无效'),
    image: string(row.image, 'Agent 执行配置响应无效'),
    runtime: row.runtime,
    command: strings(row.command, 'Agent 执行配置响应无效'),
    timeoutSeconds: positiveInteger(row.timeoutSeconds, 'Agent 执行配置响应无效'),
    cpuMillis: positiveInteger(row.cpuMillis, 'Agent 执行配置响应无效'),
    memoryBytes: positiveInteger(row.memoryBytes, 'Agent 执行配置响应无效'),
    pids: positiveInteger(row.pids, 'Agent 执行配置响应无效'),
    createdAt: string(row.createdAt, 'Agent 执行配置响应无效'),
  }
}

/** 目录/网络授权：directories 的 access 为 ro/rw，network 端点带 scheme/host/port。 */
export function parseAgentExecutionGrant(value: unknown): AgentExecutionGrant {
  const row = object(value, 'Agent 授权响应无效')
  const directories: AgentExecutionGrant['directories'] = Array.isArray(row.directories)
    ? row.directories.map((item) => {
      const entry = object(item, 'Agent 授权目录无效')
      const access = entry.access
      if (access !== 'ro' && access !== 'rw') throw new Error('Agent 授权目录无效')
      return { path: string(entry.path, 'Agent 授权目录无效'), access }
    })
    : []
  const network: AgentExecutionGrant['network'] = Array.isArray(row.network)
    ? row.network.map((item) => {
      const endpoint = object(item, 'Agent 授权网络端点无效')
      const scheme = endpoint.scheme
      if (scheme !== 'http' && scheme !== 'https') throw new Error('Agent 授权网络端点无效')
      return {
        scheme,
        host: string(endpoint.host, 'Agent 授权网络端点无效'),
        port: positiveInteger(endpoint.port, 'Agent 授权网络端点无效'),
      }
    })
    : []
  return {
    id: string(row.id, 'Agent 授权响应无效'),
    revision: positiveInteger(row.revision, 'Agent 授权响应无效'),
    enabled: boolean(row.enabled, 'Agent 授权响应无效'),
    name: string(row.name, 'Agent 授权响应无效'),
    directories,
    network,
    privateCidrs: row.privateCidrs === undefined ? [] : strings(row.privateCidrs, 'Agent 授权响应无效'),
    createdAt: string(row.createdAt, 'Agent 授权响应无效'),
  }
}

function parseResourceSelector(value: unknown): AgentResourceSelector {
  const row = object(value, 'Agent 资源规则选择器无效')
  if (row.source !== 'mcp-tool' && row.source !== 'mcp-resource' && row.source !== 'mcp-prompt' && row.source !== 'script') {
    throw new Error('Agent 资源规则选择器无效')
  }
  return {
    source: row.source,
    ref: parseAgentRevisionRef(row.ref, '资源规则选择器引用'),
    ...row.originalName === undefined ? {} : { originalName: string(row.originalName, 'Agent 资源规则选择器无效') },
    ...row.catalogDigest === undefined ? {} : { catalogDigest: string(row.catalogDigest, 'Agent 资源规则选择器无效') },
  }
}

function parseResourceMapping(value: unknown): AgentResourceMapping {
  const row = object(value, 'Agent 资源规则映射无效')
  if (row.access !== 'read' && row.access !== 'write') throw new Error('Agent 资源规则映射无效')
  const hasLiteral = row.literal !== undefined
  const hasPointer = row.pointer !== undefined
  if (hasLiteral === hasPointer) throw new Error('Agent 资源规则映射的 literal 与 pointer 必须二选一')
  return {
    kind: string(row.kind, 'Agent 资源规则映射无效'),
    authority: string(row.authority, 'Agent 资源规则映射无效'),
    access: row.access,
    ...row.subtree === undefined ? {} : { subtree: boolean(row.subtree, 'Agent 资源规则映射无效') },
    ...(hasLiteral ? { literal: string(row.literal, 'Agent 资源规则映射无效') } : { pointer: string(row.pointer, 'Agent 资源规则映射无效') }),
  }
}

/** 资源规则：版本化并发策略输入，digest 由服务端固化。 */
export function parseAgentResourceRule(value: unknown): AgentResourceRule {
  const row = object(value, 'Agent 资源规则响应无效')
  return {
    id: string(row.id, 'Agent 资源规则响应无效'),
    revision: positiveInteger(row.revision, 'Agent 资源规则响应无效'),
    digest: string(row.digest, 'Agent 资源规则响应无效'),
    createdAt: string(row.createdAt, 'Agent 资源规则响应无效'),
    name: string(row.name, 'Agent 资源规则响应无效'),
    enabled: boolean(row.enabled, 'Agent 资源规则响应无效'),
    complete: boolean(row.complete, 'Agent 资源规则响应无效'),
    selector: parseResourceSelector(row.selector),
    mappings: Array.isArray(row.mappings) ? row.mappings.map(parseResourceMapping) : [],
  }
}

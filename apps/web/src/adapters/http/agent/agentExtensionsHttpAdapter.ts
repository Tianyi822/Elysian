import { parseRuntimeAccess } from './agentChatGovernance'
import { parseProfile } from './executionParse'
import type {
  AgentJSONSchema,
  AgentMCPProbeRequest,
  AgentMCPCatalogProjection,
  AgentCapabilityRevocationPage,
  AgentCapabilityKind,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentSkill,
  AgentSkillFilePreview,
  AgentSkillImportInput,
  AgentSkillImportTask,
  AgentSkillSource,
  AgentUpdateMCPServerInput,
  RuntimeFailure,
  RuntimePage,
} from '@elysian/contracts'
import { AGENT_MCP_PROTOCOL_VERSION } from '@elysian/contracts'
import type { AgentExtensionsAdapter } from '../../../contracts/adapters'
import { parseAgentMCPServer, parseAgentSkill } from './agentExtensionParse'
import {
  agentPathPart,
  agentQueryString,
  assertRequestId,
  parseAgentPage,
  readAgentResponse,
  requestAgentJson,
} from './agentShared'
import { fetchWithSession } from '../unauthorized'
import { withRequestDeadline } from '../requestDeadline'

/*
 * 技能与 MCP 域 HTTP 适配器。端点与请求体形状以服务端为准（extensions_routes.go）：
 * - 查询参数只发送各端点白名单内的键，逐个 encodeURIComponent；
 * - 技能删除与启停、MCP 更新的 expectedRevision 分别走查询参数、JSON 体（服务端声明）；
 * - 技能导入 JSON 体与 multipart（仅 metadata+archive 两段，服务端在导入被接受前
 *   拒绝多余部分）二选一，ZIP 上传与 multipart 组包不经 requestAgentJson（它强制
 *   application/json），但同样经 withRequestDeadline 与 401/{error,code} 透传；
 * - requestId 只出现在技能导入输入体（服务端 ImportInput 声明），其余写端点一律不带；
 * - probe 请求体仅 {revision}，返回目录投影（别名映射由服务端计算）。
 */

const SKILL_ARCHIVE_LIMIT_BYTES = 64 * 1024 * 1024
/** multipart 上传 64 MiB 需要远超 JSON 写时限的预算；服务端自身 5 分钟收尾。 */
const IMPORT_UPLOAD_TIMEOUT_MS = 600_000
/** stdio 探测可能拉起执行容器（生命周期上限 300 秒），客户端预算略高于它。 */
const MCP_PROBE_TIMEOUT_MS = 330_000

const SKILL_IMPORT_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function optionalString(value: unknown, message: string): string | undefined {
  return value === undefined ? undefined : string(value, message)
}

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, message)
}

function stringRecord(value: unknown, message: string): Readonly<Record<string, string>> {
  const row = object(value, message)
  for (const entry of Object.values(row)) {
    if (typeof entry !== 'string') throw new Error(message)
  }
  return row as Readonly<Record<string, string>>
}

function jsonSchema(value: unknown, message: string): AgentJSONSchema {
  if (typeof value === 'boolean') return value
  object(value, message)
  return value as AgentJSONSchema
}

/** 导入任务与技能共用的来源形状（commit 只由服务端解析回填）。 */
function parseSkillSource(value: unknown, message: string): AgentSkillSource {
  const row = object(value, message)
  if (row.kind !== 'directory' && row.kind !== 'zip' && row.kind !== 'git') throw new Error(message)
  return {
    kind: row.kind,
    path: optionalString(row.path, message),
    url: optionalString(row.url, message),
    ref: optionalString(row.ref, message),
    subdirectory: optionalString(row.subdirectory, message),
    commit: optionalString(row.commit, message),
  }
}

function parseFailure(value: unknown, message: string): RuntimeFailure | undefined {
  if (value === undefined) return undefined
  const row = object(value, message)
  return { code: string(row.code, message), message: string(row.message, message) }
}

function optionalPositiveInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

/** GET /skills/imports/{id} 与列表页共用的任务形状校验。 */
export function parseSkillImportTask(value: unknown): AgentSkillImportTask {
  const message = 'Agent 技能导入任务响应无效'
  const row = object(value, message)
  if (typeof row.id !== 'string' || typeof row.requestId !== 'string' ||
    !SKILL_IMPORT_STATES.includes(row.state as AgentSkillImportTask['state']) ||
    typeof row.createdAt !== 'string') throw new Error(message)
  return {
    id: row.id,
    requestId: row.requestId,
    state: row.state as AgentSkillImportTask['state'],
    source: parseSkillSource(row.source, 'Agent 技能导入任务来源无效'),
    createdAt: row.createdAt,
    startedAt: optionalString(row.startedAt, message),
    endedAt: optionalString(row.endedAt, message),
    cancelRequestedAt: optionalString(row.cancelRequestedAt, message),
    skillId: optionalString(row.skillId, message),
    revision: optionalPositiveInteger(row.revision, message),
    error: parseFailure(row.error, 'Agent 技能导入任务错误无效'),
  }
}

export function parseSkillImportPage(value: unknown): RuntimePage<AgentSkillImportTask> {
  return parseAgentPage(value, parseSkillImportTask, '技能导入分页')
}

/** GET /skills：技能目录列表，逐项复用共享 parseAgentSkill。 */
export function parseSkillList(value: unknown): readonly AgentSkill[] {
  if (!Array.isArray(value)) throw new Error('Agent 技能列表响应无效')
  return value.map(parseAgentSkill)
}

export function parseSkillFilePreview(value: unknown): AgentSkillFilePreview {
  const message = 'Agent 技能文件预览响应无效'
  const row = object(value, message)
  const revision = optionalPositiveInteger(row.revision, message)
  if (revision === undefined || typeof row.previewable !== 'boolean') throw new Error(message)
  if (row.previewable && typeof row.content !== 'string') throw new Error(message)
  if (!row.previewable && row.reason !== 'binary' && row.reason !== 'too-large') throw new Error(message)
  return {
    skillId: string(row.skillId, message), revision, path: string(row.path, message),
    previewable: row.previewable,
    ...(row.previewable ? { content: row.content as string } : { reason: row.reason as 'binary' | 'too-large' }),
  }
}

export function parseCapabilityRevocationPage(value: unknown): AgentCapabilityRevocationPage {
  const message = 'Agent 能力撤销记录响应无效'
  const row = object(value, message)
  if (!Array.isArray(row.items)) throw new Error(message)
  const items = row.items.map((value) => {
    const entry = object(value, message)
    if (entry.kind !== 'skill' && entry.kind !== 'mcp' && entry.kind !== 'execution-profile' && entry.kind !== 'grant') throw new Error(message)
    if (typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision) || entry.revision < 0) throw new Error(message)
    return {
      cursor: string(entry.cursor, message), kind: entry.kind as AgentCapabilityKind,
      id: string(entry.id, message), revision: entry.revision,
      reason: string(entry.reason, message), createdAt: string(entry.createdAt, message),
    }
  })
  return { items, nextCursor: string(row.nextCursor, message), hasMore: boolean(row.hasMore, message) }
}

/** GET /mcp-servers：公开 MCP 服务列表（不含凭据与环境变量）。 */
export function parseMCPServerList(value: unknown): readonly AgentMCPServer[] {
  if (!Array.isArray(value)) throw new Error('Agent MCP 服务列表响应无效')
  return value.map(parseAgentMCPServer)
}

/** probe 与 catalog 共用的目录投影：目录 + 三组别名映射 + digest/fetchedAt。 */
export function parseMCPCatalogProjection(value: unknown): AgentMCPCatalogProjection {
  const message = 'Agent MCP 目录投影响应无效'
  const row = object(value, message)
  if (row.protocolVersion !== AGENT_MCP_PROTOCOL_VERSION) throw new Error('Agent MCP 目录协议版本无效')
  const caps = object(row.capabilities, message)
  if (typeof caps.tools !== 'boolean' || typeof caps.resources !== 'boolean' || typeof caps.prompts !== 'boolean') {
    throw new Error(message)
  }
  const tools = Array.isArray(row.tools) ? row.tools.map((item) => {
    const tool = object(item, 'Agent MCP 工具目录无效')
    return {
      name: string(tool.name, 'Agent MCP 工具目录无效'),
      title: optionalString(tool.title, 'Agent MCP 工具目录无效'),
      description: optionalString(tool.description, 'Agent MCP 工具目录无效'),
      inputSchema: jsonSchema(tool.inputSchema, 'Agent MCP 工具目录无效'),
      outputSchema: tool.outputSchema === undefined ? undefined : jsonSchema(tool.outputSchema, 'Agent MCP 工具目录无效'),
      annotations: tool.annotations === undefined ? undefined : object(tool.annotations, 'Agent MCP 工具目录无效') as AgentMCPCatalogProjection['tools'][number]['annotations'],
    }
  }) : []
  const resources = Array.isArray(row.resources) ? row.resources.map((item) => {
    const resource = object(item, 'Agent MCP 资源目录无效')
    return {
      uri: string(resource.uri, 'Agent MCP 资源目录无效'),
      name: string(resource.name, 'Agent MCP 资源目录无效'),
      title: optionalString(resource.title, 'Agent MCP 资源目录无效'),
      description: optionalString(resource.description, 'Agent MCP 资源目录无效'),
      mimeType: optionalString(resource.mimeType, 'Agent MCP 资源目录无效'),
    }
  }) : []
  const prompts = Array.isArray(row.prompts) ? row.prompts.map((item) => {
    const prompt = object(item, 'Agent MCP 提示目录无效')
    return {
      name: string(prompt.name, 'Agent MCP 提示目录无效'),
      title: optionalString(prompt.title, 'Agent MCP 提示目录无效'),
      description: optionalString(prompt.description, 'Agent MCP 提示目录无效'),
      arguments: prompt.arguments === undefined ? undefined : (Array.isArray(prompt.arguments) ? prompt.arguments.map((argument) => {
        const entry = object(argument, 'Agent MCP 提示参数无效')
        return {
          name: string(entry.name, 'Agent MCP 提示参数无效'),
          description: optionalString(entry.description, 'Agent MCP 提示参数无效'),
          required: optionalBoolean(entry.required, 'Agent MCP 提示参数无效'),
        }
      }) : undefined),
    }
  }) : []
  return {
    protocolVersion: row.protocolVersion,
    capabilities: { tools: caps.tools, resources: caps.resources, prompts: caps.prompts },
    tools,
    resources,
    prompts,
    digest: string(row.digest, message),
    fetchedAt: string(row.fetchedAt, message),
    modelAliases: stringRecord(row.modelAliases, 'Agent MCP 模型别名无效'),
    resourceAliases: stringRecord(row.resourceAliases, 'Agent MCP 资源别名无效'),
    promptAliases: stringRecord(row.promptAliases, 'Agent MCP 提示别名无效'),
  }
}

/** 导入输入体：只输出服务端 skillImportBody 声明的字段，undefined 键不发送。 */
function skillImportRequestBody(input: AgentSkillImportInput): Record<string, unknown> {
  return {
    requestId: input.requestId,
    ...(input.skillId !== undefined && input.skillId !== '' ? { skillId: input.skillId } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    source: {
      kind: input.source.kind,
      ...(input.source.path !== undefined ? { path: input.source.path } : {}),
      ...(input.source.url !== undefined ? { url: input.source.url } : {}),
      ...(input.source.ref !== undefined ? { ref: input.source.ref } : {}),
      ...(input.source.subdirectory !== undefined ? { subdirectory: input.source.subdirectory } : {}),
    },
    enabled: input.enabled,
    ...(input.credential !== undefined && input.credential !== '' ? { credential: input.credential } : {}),
  }
}

/** 发起前的中文预检：来源三类各自必填、ZIP 段数（构造即两段）与容量上限。 */
export function assertSkillImportInput(input: AgentSkillImportInput, archive?: Blob): void {
  assertRequestId(input.requestId)
  const hasSkillId = input.skillId !== undefined && input.skillId !== ''
  if (input.expectedRevision !== undefined && !hasSkillId) {
    throw new Error('更新既有技能时必须同时提供技能编号与预期修订')
  }
  if (hasSkillId && (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new Error('更新既有技能时必须同时提供技能编号与预期修订')
  }
  const source = input.source
  if (source.kind === 'directory') {
    if (!source.path?.startsWith('/')) throw new Error('本地目录来源必须是宿主绝对路径')
    if (source.url !== undefined || source.ref !== undefined) throw new Error('本地目录来源不能携带 Git 地址或引用')
    if (archive !== undefined) throw new Error('本地目录来源不接受 ZIP 上传')
  } else if (source.kind === 'git') {
    let parsed: URL
    try {
      parsed = new URL(source.url ?? '')
    } catch {
      throw new Error('Git 来源必须是有效的 HTTPS 地址')
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('Git 来源必须是不含凭据、查询参数或片段的 HTTPS 地址')
    }
    if (!source.ref?.trim()) throw new Error('Git 来源必须显式指定分支、标签或提交')
    if (archive !== undefined) throw new Error('Git 来源不接受 ZIP 上传')
  } else {
    if (source.path !== undefined || source.url !== undefined || source.ref !== undefined || source.subdirectory !== undefined) {
      throw new Error('ZIP 来源只接受上传内容，不能携带目录、Git 地址或引用')
    }
    if (archive === undefined) throw new Error('ZIP 导入必须选择上传文件')
  }
  if (archive !== undefined && archive.size > SKILL_ARCHIVE_LIMIT_BYTES) {
    throw new Error(`技能 ZIP 上传超过容量限额（上限 64 MiB，当前 ${Math.ceil(archive.size / (1024 * 1024))} MiB）`)
  }
}

/** multipart 组包：仅 metadata、archive 两段，两段都不带 filename（服务端要求）。 */
function buildSkillImportBody(input: AgentSkillImportInput, archive: Blob): { body: Blob; contentType: string } {
  const metadata = JSON.stringify(skillImportRequestBody(input))
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`
  const boundary = `elysianagentskill${random}`
  const encoder = new TextEncoder()
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="metadata"\r\n' +
    'Content-Type: application/json\r\n' +
    '\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="archive"\r\n' +
    'Content-Type: application/zip\r\n' +
    '\r\n',
  )
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
  return {
    body: new Blob([prefix, archive, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/** 自定义 Content-Type 的请求出口（当前仅技能导入 multipart 使用）。 */
async function requestAgentContentType(
  url: string,
  init: RequestInit,
  contentType: string,
  timeoutMs?: number,
): Promise<unknown> {
  return withRequestDeadline(init, async (bounded) => {
    const headers = new Headers(init.headers)
    headers.set('content-type', contentType)
    let response: Response
    try {
      response = await fetchWithSession(url, { ...init, headers, cache: 'no-store', signal: bounded.signal })
    } catch (error) {
      if (bounded.signal?.aborted) throw error
      throw new Error('Agent 请求网络失败')
    }
    return readAgentResponse(response)
  }, timeoutMs)
}

function positiveRevision(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}必须是正整数`)
  }
  return value
}

const nonNegativeInteger = (value: unknown, label: string): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`); return value }

function parseProbeRequest(value: unknown): AgentMCPProbeRequest {
  const r = object(value, 'MCP 探测申请无效')
  if (!['waiting', 'preparing', 'running', 'completed', 'denied', 'failed', 'unknown', 'cancelled'].includes(String(r.state))) throw new Error('MCP 探测状态无效')
  const e = r.environment === undefined ? undefined : object(r.environment, 'MCP 探测环境无效')
  const p = r.progress === undefined ? undefined : object(r.progress, 'MCP 探测进度无效')
  if (p && p.state !== 'pulling' && p.state !== 'ready') throw new Error('MCP 探测进度无效')
  if (e && typeof e.requiresDownload !== 'boolean') throw new Error('MCP 探测环境无效')
  const access = parseRuntimeAccess(r.access)
  if (access.sessionAllowed) throw new Error('MCP 探测不能使用会话授权')
  return { id: string(r.id, '探测编号'), version: positiveRevision(Number(r.version), '申请版本'), requestId: string(r.requestId, '请求编号'), serverId: string(r.serverId, '服务编号'), serverRevision: positiveRevision(Number(r.serverRevision), '服务修订'), serverName: string(r.serverName, '服务名称'), state: r.state as AgentMCPProbeRequest['state'], digest: string(r.digest, '申请摘要'), createdAt: string(r.createdAt, '创建时间'), access,
    command: Array.isArray(r.command) ? r.command.map(item => string(item, '启动命令')) : [],
    ...(e ? { environment: { profile: parseProfile(e.profile), version: string(e.version, '环境版本'), platform: string(e.platform, '环境架构'), requiresDownload: e.requiresDownload as boolean } } : {}),
    ...(p ? { progress: { state: p.state as 'pulling' | 'ready', ...(p.current === undefined ? {} : { current: nonNegativeInteger(p.current, '下载进度') }), ...(p.total === undefined ? {} : { total: nonNegativeInteger(p.total, '下载总量') }) } } : {}),
    ...(r.error === undefined ? {} : { error: string(r.error, '探测错误') }), ...(r.catalog === undefined ? {} : { catalog: parseMCPCatalogProjection(r.catalog) }) }
}

/** MCP 输入体：只输出服务端 mcp.Input（+PUT 的 expectedRevision）声明的字段。 */
function mcpServerRequestBody(input: AgentMCPServerInput | AgentUpdateMCPServerInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    transport: input.transport,
    ...(input.transport === 'streamable-http' && input.url !== undefined ? { url: input.url } : {}),
    ...(input.stdio !== undefined ? {
      stdio: {
        ...(input.stdio.requestedAccess === undefined ? {} : { requestedAccess: input.stdio.requestedAccess }),
        image: input.stdio.image,
        command: input.stdio.command,
        ...(input.stdio.grantId !== undefined && input.stdio.grantId !== '' ? { grantId: input.stdio.grantId } : {}),
        ...(input.stdio.grantRevision !== undefined ? { grantRevision: input.stdio.grantRevision } : {}),
        ...(input.stdio.environment !== undefined ? { environment: input.stdio.environment } : {}),
      },
    } : {}),
    active: input.active,
    revoked: input.revoked,
    ...(input.credential !== undefined ? { credential: input.credential } : {}),
  }
  if ('expectedRevision' in input) body.expectedRevision = input.expectedRevision
  return body
}

export function createHttpAgentExtensionsAdapter(baseUrl = '/api/agent'): AgentExtensionsAdapter {
  const skillsUrl = (id: string) => `${baseUrl}/skills/${agentPathPart(id, '技能标识')}`
  const importsUrl = (id: string) => `${baseUrl}/skills/imports/${agentPathPart(id, '导入任务标识')}`
  const mcpUrl = (id: string) => `${baseUrl}/mcp-servers/${agentPathPart(id, 'MCP 服务标识')}`
  return {
    async listSkills(signal) {
      return parseSkillList(await requestAgentJson(`${baseUrl}/skills`, { signal }))
    },
    async getSkill(skillId, revision, signal) {
      if (revision !== undefined) positiveRevision(revision, '技能修订')
      const query = agentQueryString({ revision })
      return parseAgentSkill(await requestAgentJson(`${skillsUrl(skillId)}${query ? `?${query}` : ''}`, { signal }))
    },
    async getSkillFile(skillId, revision, path, signal) {
      positiveRevision(revision, '技能修订')
      if (path === '') throw new Error('必须指定技能文件路径')
      return parseSkillFilePreview(await requestAgentJson(`${skillsUrl(skillId)}/files?${agentQueryString({ revision, path })}`, { signal }))
    },
    async listCapabilityRevocations(query, signal) {
      const search = agentQueryString({ kind: query?.kind, id: query?.id, cursor: query?.cursor, limit: query?.limit })
      return parseCapabilityRevocationPage(await requestAgentJson(`${baseUrl}/capability-revocations${search ? `?${search}` : ''}`, { signal }))
    },
    async setSkillEnabled(skillId, expectedRevision, enabled) {
      positiveRevision(expectedRevision, '技能修订')
      // 服务端 enabledInput：仅 expectedRevision 与 enabled，无 requestId。
      return parseAgentSkill(await requestAgentJson(skillsUrl(skillId), {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision, enabled }),
      }))
    },
    async deleteSkill(skillId, revision) {
      positiveRevision(revision, '技能修订')
      // revision 走查询参数（服务端 extensionRevision 必填）。
      await parseAgentSkill(await requestAgentJson(`${skillsUrl(skillId)}?${agentQueryString({ revision })}`, {
        method: 'DELETE',
      }))
    },
    async listSkillImports(query, signal) {
      const search = agentQueryString({ cursor: query?.cursor, limit: query?.limit })
      return parseSkillImportPage(await requestAgentJson(`${baseUrl}/skills/imports${search ? `?${search}` : ''}`, { signal }))
    },
    async createSkillImport(input, archive) {
      assertSkillImportInput(input, archive)
      const metadata = JSON.stringify(skillImportRequestBody(input))
      if (archive === undefined) {
        return parseSkillImportTask(await requestAgentJson(`${baseUrl}/skills/imports`, {
          method: 'POST',
          body: metadata,
        }))
      }
      const { body, contentType } = buildSkillImportBody(input, archive)
      return parseSkillImportTask(await requestAgentContentType(`${baseUrl}/skills/imports`, {
        method: 'POST',
        body: body as unknown as BodyInit,
      }, contentType, IMPORT_UPLOAD_TIMEOUT_MS))
    },
    async getSkillImport(importId, signal) {
      return parseSkillImportTask(await requestAgentJson(importsUrl(importId), { signal }))
    },
    async cancelSkillImport(importId) {
      // 取消无请求体、无 requestId；202 受理或 200 已终态，回读任务为准。
      return parseSkillImportTask(await requestAgentJson(importsUrl(importId) + '/cancel', { method: 'POST' }))
    },
    async deleteSkillImportRecord(importId) {
      // 仅终态记录可删；响应是被删记录，解析后按 void 丢弃。
      await parseSkillImportTask(await requestAgentJson(importsUrl(importId), { method: 'DELETE' }))
    },
    async listMcpServers(signal) {
      return parseMCPServerList(await requestAgentJson(`${baseUrl}/mcp-servers`, { signal }))
    },
    async createMcpServer(input) {
      return parseAgentMCPServer(await requestAgentJson(`${baseUrl}/mcp-servers`, {
        method: 'POST',
        body: JSON.stringify(mcpServerRequestBody(input)),
      }))
    },
    async getMcpServer(serverId, revision, signal) {
      positiveRevision(revision, 'MCP 服务修订')
      return parseAgentMCPServer(await requestAgentJson(`${mcpUrl(serverId)}?${agentQueryString({ revision })}`, { signal }))
    },
    async updateMcpServer(serverId, input) {
      positiveRevision(input.expectedRevision, 'MCP 服务修订')
      return parseAgentMCPServer(await requestAgentJson(mcpUrl(serverId), {
        method: 'PUT',
        body: JSON.stringify(mcpServerRequestBody(input)),
      }))
    },
    async createMcpProbeRequest(serverId, input) { const request = parseProbeRequest(await requestAgentJson(`${mcpUrl(serverId)}/probe-request`, { method: 'POST', body: JSON.stringify(input) })); if (request.serverId !== serverId || request.serverRevision !== input.revision || request.requestId !== input.requestId) throw new Error('MCP 探测申请不匹配'); return request },
    async getMcpProbeRequest(id, signal) { const request = parseProbeRequest(await requestAgentJson(`${baseUrl}/mcp-probe-requests/${agentPathPart(id)}`, { signal })); if (request.id !== id) throw new Error('MCP 探测申请不匹配'); return request },
    async decideMcpProbeRequest(id, input) { const request = parseProbeRequest(await requestAgentJson(`${baseUrl}/mcp-probe-requests/${agentPathPart(id)}/decision`, { method: 'POST', body: JSON.stringify(input) })); if (request.id !== id) throw new Error('MCP 探测申请不匹配'); return request },
    async cancelMcpProbeRequest(id, input) { const request = parseProbeRequest(await requestAgentJson(`${baseUrl}/mcp-probe-requests/${agentPathPart(id)}/cancel`, { method: 'POST', body: JSON.stringify(input) })); if (request.id !== id) throw new Error('MCP 探测申请不匹配'); return request },
    async probeMcpServer(serverId, revision) {
      positiveRevision(revision, 'MCP 服务修订')
      // 请求体仅 {revision}，无 requestId（服务端只声明 Revision 一个字段）。
      return parseMCPCatalogProjection(await requestAgentJson(`${mcpUrl(serverId)}/probe`, {
        method: 'POST',
        body: JSON.stringify({ revision }),
      }, { timeoutMs: MCP_PROBE_TIMEOUT_MS }))
    },
    async getMcpCatalog(serverId, revision, digest, signal) {
      positiveRevision(revision, 'MCP 服务修订')
      const query = agentQueryString({ revision, digest })
      return parseMCPCatalogProjection(await requestAgentJson(`${mcpUrl(serverId)}/catalog?${query}`, { signal }))
    },
  }
}

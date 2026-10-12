import type {
  AgentCreateMemoryExtractionInput,
  AgentEmbeddingProfile,
  AgentEmbeddingProfileInput,
  AgentEmbeddingRequest,
  AgentMemoryChecks,
  AgentMemoryExtraction,
  AgentMemoryExport,
  AgentMemoryIndexInput,
  AgentMemoryIndexStatus,
  AgentMemoryPage,
  AgentMemoryPageInput,
  AgentMemoryProposal,
  AgentMemoryProposalDecisionInput,
  AgentMemoryProposalStatus,
  AgentMemorySearchResult,
  AgentMemorySpace,
  AgentMemorySpaceInput,
  AgentUpdateEmbeddingProfileInput,
  RuntimeFailure,
  RuntimeRunStatus,
} from '@elysian/contracts'
import {
  AGENT_MEMORY_PAGE_KINDS,
  AGENT_MEMORY_PROPOSAL_STATUSES,
  RUNTIME_RUN_STATUSES,
} from '@elysian/contracts'
import type { AgentMemoryAdapter, AgentPageQuery } from '../../../contracts/adapters'
import {
  agentPathPart,
  agentQueryString,
  assertRequestId,
  parseAgentPage,
  requestAgentJson,
} from './agentShared'

/*
 * 长期记忆域 HTTP 适配器。原 Wiki 只读接缝（agentWikiReadHttpAdapter.ts）的读取
 * 逻辑在此落地并继续有效；写方法按服务端事实对齐（memory_routes.go）：
 * - 页面 PUT 的 expectedRevision 在页面 Input 体内；DELETE 的 expectedRevision
 *   在 JSON body {expectedRevision}——与工作区/skills 的查询参数习惯不同，不得挪动；
 * - 建页/改页/撤回/空间增改/候选决定/Embedding 配置均无 requestId（body 多带字段即 400）；
 * - 提炼创建（WikiExtractionInput）与索引重建（WikiIndexInput）带 requestId 幂等；
 * - 索引状态是数组（每条 Embedding 配置一行），重建 202 返回 kind=embedding 任务。
 */

const WIKI_PAGE_BYTES = 16 * 1024
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

const encoder = new TextEncoder()

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/**
 * 页面提交的前端侧校验（镜像服务端 validateWikiInput，wiki_store.go:30-67）。
 * 编辑器与 HTTP 适配器共用：16 KiB 正文、slug 形状、证据 ≤32、来源 ≤64 等在
 * 发出前拦截，错误文案与服务端一致。
 */
export function validateMemoryPageInput(input: AgentMemoryPageInput): void {
  const slug = input.slug ?? ''
  const markdown = input.markdown ?? ''
  const title = input.title ?? ''
  if (!SLUG_PATTERN.test(slug) || slug.includes('..') || slug.includes('//') ||
    title.trim() === '' || title.length > 512 || title.includes('\x00') ||
    encoder.encode(markdown).length > WIKI_PAGE_BYTES || markdown.includes('\x00')) {
    throw new Error('Wiki 页面 slug、标题或正文无效')
  }
  const kind = input.kind ?? 'reference'
  if (!AGENT_MEMORY_PAGE_KINDS.includes(kind as AgentMemoryPage['kind'])) {
    throw new Error('Wiki 页面类型无效')
  }
  const evidence = input.evidence ?? []
  const sources = input.sources ?? []
  if (evidence.length > 32 || sources.length > 64) {
    throw new Error('Wiki 证据或来源数量超过限额')
  }
  for (const item of evidence) {
    if (item.text.trim() === '' || item.text.length > 2048 || (item.uri?.length ?? 0) > 2048 ||
      item.id.length > 128 || item.kind.length > 64) {
      throw new Error('Wiki 证据摘录无效或超过限额')
    }
  }
  for (const values of [input.tags ?? [], input.aliases ?? []]) {
    if (values.length > 32) throw new Error('Wiki 标签和别名各最多 32 项')
    for (const value of values) {
      if (value.trim() === '' || value.length > 128 || value.includes('\x00')) throw new Error('Wiki 标签或别名无效')
    }
  }
  if (input.expiresAt !== undefined && input.expiresAt !== '' && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error('Wiki 有效期必须为 RFC3339 时间')
  }
}

/** 服务端公开空间列表；拒绝形状漂移，避免未来界面把错误体当作空列表。 */
export function parseWikiSpaces(value: unknown): readonly AgentMemorySpace[] {
  if (!Array.isArray(value)) throw new Error('Wiki 空间列表响应无效')
  return value.map((item) => parseWikiSpace(item))
}

export function parseWikiSpace(value: unknown): AgentMemorySpace {
  const row = object(value, 'Wiki 空间响应无效')
  if (typeof row.id !== 'string' || !positiveInteger(row.revision) ||
    typeof row.name !== 'string' || (row.kind !== 'business' && row.kind !== 'global') ||
    typeof row.createdAt !== 'string') throw new Error('Wiki 空间响应无效')
  return row as AgentMemorySpace
}

/** 页面详情、列表项、历史修订及搜索命中使用相同公开结构。 */
export function parseWikiPage(value: unknown): AgentMemoryPage {
  const row = object(value, 'Wiki 页面响应无效')
  if (typeof row.id !== 'string' || typeof row.spaceId !== 'string' ||
    typeof row.slug !== 'string' || !positiveInteger(row.revision) ||
    typeof row.title !== 'string' || typeof row.markdown !== 'string' ||
    !AGENT_MEMORY_PAGE_KINDS.includes(row.kind as AgentMemoryPage['kind']) ||
    (row.status !== 'active' && row.status !== 'withdrawn') ||
    typeof row.digest !== 'string' || typeof row.createdAt !== 'string' ||
    typeof row.updatedAt !== 'string' || !Array.isArray(row.evidence) ||
    !Array.isArray(row.sources) || !strings(row.links) ||
    (row.expiresAt !== undefined && typeof row.expiresAt !== 'string') ||
    (row.withdrawnAt !== undefined && typeof row.withdrawnAt !== 'string') ||
    (row.tags !== undefined && !strings(row.tags)) ||
    (row.aliases !== undefined && !strings(row.aliases))) throw new Error('Wiki 页面响应无效')
  if (!row.evidence.every((item: unknown) => {
    const evidence = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    return evidence && typeof evidence.id === 'string' && typeof evidence.kind === 'string' &&
      typeof evidence.text === 'string' && typeof evidence.createdAt === 'string' &&
      typeof evidence.digest === 'string' && typeof evidence.originalCleared === 'boolean' &&
      (evidence.runId === undefined || typeof evidence.runId === 'string') &&
      (evidence.eventSeq === undefined || typeof evidence.eventSeq === 'string') &&
      (evidence.uri === undefined || typeof evidence.uri === 'string')
  }) || !row.sources.every((item: unknown) => {
    const source = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    return source && typeof source.pageId === 'string' && positiveInteger(source.revision) && typeof source.digest === 'string'
  })) throw new Error('Wiki 页面响应无效')
  return row as AgentMemoryPage
}

export function parseWikiPages(value: unknown): readonly AgentMemoryPage[] {
  if (!Array.isArray(value)) throw new Error('Wiki 页面列表响应无效')
  return value.map(parseWikiPage)
}

export function parseWikiSearchResult(value: unknown): AgentMemorySearchResult {
  const row = object(value, 'Wiki 搜索响应无效')
  if (!Array.isArray(row.items) || typeof row.degraded !== 'boolean' ||
    (row.reason !== undefined && typeof row.reason !== 'string')) throw new Error('Wiki 搜索响应无效')
  const items = row.items.map((item: unknown) => {
    const hit = object(item, 'Wiki 搜索命中响应无效')
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score) ||
      (hit.method !== 'sqlite-text' && hit.method !== 'hybrid-rrf')) throw new Error('Wiki 搜索命中响应无效')
    return { page: parseWikiPage(hit.page), score: hit.score, method: hit.method as 'sqlite-text' | 'hybrid-rrf' }
  })
  return { items, degraded: row.degraded, ...(row.reason === undefined ? {} : { reason: row.reason as string }) }
}

/** 候选（WikiCandidate）的公开结构：page 是待发布的页面 Input。 */
export function parseWikiProposal(value: unknown): AgentMemoryProposal {
  const row = object(value, 'Wiki 候选响应无效')
  if (typeof row.id !== 'string' || typeof row.spaceId !== 'string' ||
    !AGENT_MEMORY_PROPOSAL_STATUSES.includes(row.status as AgentMemoryProposalStatus) ||
    typeof row.originKind !== 'string' || typeof row.originId !== 'string' || typeof row.createdAt !== 'string' ||
    (row.pageId !== undefined && typeof row.pageId !== 'string') ||
    (row.decidedAt !== undefined && typeof row.decidedAt !== 'string') ||
    row.page === undefined || row.page === null || typeof row.page !== 'object') throw new Error('Wiki 候选响应无效')
  const page = row.page as Record<string, unknown>
  if ((page.expectedRevision !== undefined && !nonNegativeInteger(page.expectedRevision)) ||
    typeof page.slug !== 'string' || typeof page.title !== 'string' || typeof page.markdown !== 'string' ||
    (page.kind !== undefined && !AGENT_MEMORY_PAGE_KINDS.includes(page.kind as AgentMemoryPage['kind'])) ||
    (page.expiresAt !== undefined && !optionalString(page.expiresAt)) ||
    (page.evidence !== undefined && !Array.isArray(page.evidence)) ||
    (page.sources !== undefined && !Array.isArray(page.sources)) ||
    (page.tags !== undefined && !strings(page.tags)) ||
    (page.aliases !== undefined && !strings(page.aliases))) throw new Error('Wiki 候选响应无效')
  return row as unknown as AgentMemoryProposal
}

export function parseWikiProposals(value: unknown): readonly AgentMemoryProposal[] {
  if (!Array.isArray(value)) throw new Error('Wiki 候选列表响应无效')
  return value.map(parseWikiProposal)
}

export function parseWikiChecks(value: unknown): AgentMemoryChecks {
  const row = object(value, 'Wiki 检查报告响应无效')
  if (!strings(row.orphanPages) || !strings(row.brokenLinks) ||
    !strings(row.expiredPages) || !strings(row.invalidSources)) throw new Error('Wiki 检查报告响应无效')
  return row as AgentMemoryChecks
}

export function parseWikiExport(value: unknown): AgentMemoryExport {
  const row = object(value, 'Wiki 导出响应无效')
  const files = row.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new Error('Wiki 导出响应无效')
  for (const fileValue of Object.values(files as Record<string, unknown>)) {
    if (typeof fileValue !== 'string') throw new Error('Wiki 导出响应无效')
  }
  return { files: files as Record<string, string> }
}

export function parseEmbeddingProfile(value: unknown): AgentEmbeddingProfile {
  const row = object(value, 'Embedding 配置响应无效')
  if (typeof row.id !== 'string' || !positiveInteger(row.revision) || typeof row.name !== 'string' ||
    typeof row.baseUrl !== 'string' || typeof row.model !== 'string' ||
    typeof row.dimensions !== 'number' || !Number.isSafeInteger(row.dimensions) ||
    typeof row.active !== 'boolean' || typeof row.hasCredential !== 'boolean') {
    throw new Error('Embedding 配置响应无效')
  }
  return row as AgentEmbeddingProfile
}

export function parseEmbeddingProfiles(value: unknown): readonly AgentEmbeddingProfile[] {
  if (!Array.isArray(value)) throw new Error('Embedding 配置列表响应无效')
  return value.map(parseEmbeddingProfile)
}

/** 索引状态数组：每条 Embedding 配置一行；无配置时为空数组。 */
export function parseWikiIndexStatuses(value: unknown): readonly AgentMemoryIndexStatus[] {
  if (!Array.isArray(value)) throw new Error('Wiki 索引状态响应无效')
  return value.map((item) => {
    const row = object(item, 'Wiki 索引状态响应无效')
    if (!nonNegativeInteger(row.pages) || !nonNegativeInteger(row.indexedPages) ||
      (row.status !== 'ready' && row.status !== 'stale')) throw new Error('Wiki 索引状态响应无效')
    return { profile: parseEmbeddingProfile(row.profile), pages: row.pages as number, indexedPages: row.indexedPages as number, status: row.status as 'ready' | 'stale' }
  })
}

function parseFailure(value: unknown, message: string): RuntimeFailure {
  const row = object(value, message)
  if (typeof row.code !== 'string' || typeof row.message !== 'string') throw new Error(message)
  return row as RuntimeFailure
}

function parseUsage(value: unknown): AgentMemoryExtraction['usage'] {
  const row = object(value, '长期记忆任务用量响应无效')
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const) {
    if (row[field] !== undefined && !nonNegativeInteger(row[field])) throw new Error('长期记忆任务用量响应无效')
  }
  return row as AgentMemoryExtraction['usage']
}

function parseModelProfile(value: unknown): AgentMemoryExtraction['model'] {
  const row = object(value, '长期记忆任务模型响应无效')
  const capabilities = object(row.capabilities, '长期记忆任务模型响应无效')
  if (typeof row.id !== 'string' || !nonNegativeInteger(row.revision) || typeof row.name !== 'string' ||
    typeof row.baseUrl !== 'string' || typeof row.model !== 'string' ||
    !nonNegativeInteger(row.contextTokens) || !nonNegativeInteger(row.outputTokens) ||
    typeof capabilities.text !== 'boolean' || typeof capabilities.tools !== 'boolean' ||
    typeof capabilities.source !== 'string' || typeof row.active !== 'boolean' ||
    typeof row.hasCredential !== 'boolean') throw new Error('长期记忆任务模型响应无效')
  return row as AgentMemoryExtraction['model']
}

function parseWikiRefs(value: unknown): AgentMemoryExtraction['sources'] {
  if (!Array.isArray(value)) throw new Error('长期记忆任务来源响应无效')
  return value.map((item) => {
    const row = object(item, '长期记忆任务来源响应无效')
    if (typeof row.pageId !== 'string' || !positiveInteger(row.revision) || typeof row.digest !== 'string') {
      throw new Error('长期记忆任务来源响应无效')
    }
    return row as AgentMemoryExtraction['sources'][number]
  })
}

/** 提炼/索引任务（WikiJob）公开结构；model 在索引任务上为零值对象（服务端事实）。 */
export function parseWikiExtraction(value: unknown): AgentMemoryExtraction {
  const row = object(value, '长期记忆任务响应无效')
  if (typeof row.id !== 'string' || (row.kind !== 'extraction' && row.kind !== 'embedding') ||
    typeof row.originKind !== 'string' || typeof row.originId !== 'string' || typeof row.spaceId !== 'string' ||
    !RUNTIME_RUN_STATUSES.includes(row.status as RuntimeRunStatus) ||
    !nonNegativeInteger(row.generation) || typeof row.createdAt !== 'string' ||
    !strings(row.candidateIds) || !nonNegativeInteger(row.estimatedTokens)) throw new Error('长期记忆任务响应无效')
  if ((row.memoryStatus !== undefined && (typeof row.memoryStatus !== 'string' || !['unchanged', 'updated', 'stale', 'invalidated'].includes(row.memoryStatus))) ||
    !optionalString(row.taskId) || !optionalString(row.runId) || !optionalString(row.workflowId) ||
    !optionalString(row.startedAt) || !optionalString(row.endedAt) ||
    (row.embeddingProfile !== undefined && row.embeddingProfile !== null && typeof row.embeddingProfile !== 'object') ||
    (row.error !== undefined && row.error !== null && typeof row.error !== 'object') ||
    (row.usage === undefined || row.usage === null || typeof row.usage !== 'object')) {
    throw new Error('长期记忆任务响应无效')
  }
  const embeddingProfile = row.embeddingProfile === undefined || row.embeddingProfile === null
    ? undefined
    : parseEmbeddingProfile(row.embeddingProfile)
  const error = row.error === undefined || row.error === null ? undefined : parseFailure(row.error, '长期记忆任务响应无效')
  const job: AgentMemoryExtraction = {
    id: row.id,
    kind: row.kind,
    originKind: row.originKind,
    originId: row.originId,
    spaceId: row.spaceId,
    status: row.status as RuntimeRunStatus,
    ...(row.memoryStatus === undefined ? {} : { memoryStatus: row.memoryStatus as AgentMemoryExtraction['memoryStatus'] }),
    ...(row.taskId === undefined ? {} : { taskId: row.taskId as string }),
    ...(row.runId === undefined || row.runId === '' ? {} : { runId: row.runId as string }),
    ...(row.workflowId === undefined || row.workflowId === '' ? {} : { workflowId: row.workflowId as string }),
    generation: row.generation as number,
    ...(embeddingProfile === undefined ? {} : { embeddingProfile }),
    model: parseModelProfile(row.model),
    createdAt: row.createdAt as string,
    ...(row.startedAt === undefined || row.startedAt === '' ? {} : { startedAt: row.startedAt as string }),
    ...(row.endedAt === undefined || row.endedAt === '' ? {} : { endedAt: row.endedAt as string }),
    usage: parseUsage(row.usage),
    estimatedTokens: row.estimatedTokens as number,
    ...(error === undefined ? {} : { error }),
    candidateIds: row.candidateIds as string[],
    sources: parseWikiRefs(row.sources),
  }
  return job
}

export function parseEmbeddingRequest(value: unknown): AgentEmbeddingRequest {
  const row = object(value, 'Embedding 用量响应无效')
  if (typeof row.id !== 'string' || typeof row.profileId !== 'string' || !positiveInteger(row.profileRevision) ||
    (row.purpose !== 'index' && row.purpose !== 'query') ||
    (typeof row.status !== 'string' || !['running', 'succeeded', 'failed', 'interrupted'].includes(row.status)) ||
    !nonNegativeInteger(row.inputBytes) || typeof row.inputDigest !== 'string' ||
    !nonNegativeInteger(row.estimatedTokens) || typeof row.startedAt !== 'string' ||
    (row.endedAt !== undefined && typeof row.endedAt !== 'string') ||
    (row.jobId !== undefined && typeof row.jobId !== 'string')) throw new Error('Embedding 用量响应无效')
  const page = row.page === undefined || row.page === null ? undefined : parseWikiRefs([row.page])[0]
  const error = row.error === undefined || row.error === null ? undefined : parseFailure(row.error, 'Embedding 用量响应无效')
  return {
    id: row.id,
    profileId: row.profileId,
    profileRevision: row.profileRevision as number,
    purpose: row.purpose as 'index' | 'query',
    ...(row.jobId === undefined ? {} : { jobId: row.jobId as string }),
    ...(page === undefined ? {} : { page }),
    status: row.status as AgentEmbeddingRequest['status'],
    inputBytes: row.inputBytes as number,
    inputDigest: row.inputDigest as string,
    estimatedTokens: row.estimatedTokens as number,
    usage: parseUsage(row.usage),
    startedAt: row.startedAt as string,
    ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt as string }),
    ...(error === undefined ? {} : { error }),
  }
}

function assertSpaceName(name: string): string {
  if (name.trim() === '' || name.length > 120 || name.includes('\x00')) throw new Error('Wiki 空间名称无效')
  return name
}

function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return requestAgentJson(url, { method: 'POST', body: JSON.stringify(body), signal })
}

function putJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return requestAgentJson(url, { method: 'PUT', body: JSON.stringify(body), signal })
}

export function createHttpAgentMemoryAdapter(baseUrl = '/api/agent'): AgentMemoryAdapter {
  const spaceBase = (spaceId: string) => `${baseUrl}/memory-spaces/${agentPathPart(spaceId, '空间标识')}`
  const pageBase = (spaceId: string, pageId: string) =>
    `${spaceBase(spaceId)}/pages/${agentPathPart(pageId, '页面标识')}`
  return {
    available: true,
    async listSpaces(signal) {
      return parseWikiSpaces(await requestAgentJson(`${baseUrl}/memory-spaces`, { signal }))
    },
    async createSpace(input: AgentMemorySpaceInput): Promise<AgentMemorySpace> {
      assertSpaceName(input.name)
      return parseWikiSpace(await postJson(`${baseUrl}/memory-spaces`, { name: input.name, kind: input.kind }))
    },
    async renameSpace(spaceId: string, expectedRevision: number, name: string): Promise<AgentMemorySpace> {
      if (!positiveInteger(expectedRevision)) throw new Error('记忆空间修订必须是正整数')
      assertSpaceName(name)
      return parseWikiSpace(await putJson(`${spaceBase(spaceId)}`, { expectedRevision, name }))
    },
    async listPages(spaceId, includeWithdrawn = false, signal) {
      const suffix = includeWithdrawn ? '?includeWithdrawn=1' : ''
      return parseWikiPages(await requestAgentJson(`${spaceBase(spaceId)}/pages${suffix}`, { signal }))
    },
    async createPage(spaceId, input) {
      validateMemoryPageInput(input)
      return parseWikiPage(await postJson(`${spaceBase(spaceId)}/pages`, input))
    },
    async getPage(spaceId, pageId, signal) {
      return parseWikiPage(await requestAgentJson(pageBase(spaceId, pageId), { signal }))
    },
    async updatePage(spaceId, pageId, input) {
      if (!nonNegativeInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1) {
        throw new Error('Wiki 页面修订必须是正整数')
      }
      validateMemoryPageInput(input)
      return parseWikiPage(await putJson(pageBase(spaceId, pageId), input))
    },
    async withdrawPage(spaceId, pageId, expectedRevision) {
      if (!positiveInteger(expectedRevision)) throw new Error('Wiki 页面修订必须是正整数')
      // 服务端事实：DELETE 的 expectedRevision 在 JSON body，绝不能放查询参数（memory_routes.go:108-122）。
      return parseWikiPage(await requestAgentJson(pageBase(spaceId, pageId), {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision }),
      }))
    },
    async getPageRevision(spaceId, pageId, revision, signal) {
      if (!positiveInteger(revision)) throw new Error('Wiki 修订必须是正整数')
      return parseWikiPage(await requestAgentJson(`${pageBase(spaceId, pageId)}/revisions/${revision}`, { signal }))
    },
    async search(spaceId, query, limit = 8, signal) {
      if (!query.trim() || new TextEncoder().encode(query).length > 256) throw new Error('Wiki 搜索内容不能为空或超过 256 字节')
      if (!positiveInteger(limit) || limit > 200) throw new Error('Wiki 搜索条数必须是 1 到 200 的整数')
      const params = agentQueryString({ q: query, limit })
      return parseWikiSearchResult(await requestAgentJson(`${spaceBase(spaceId)}/search?${params}`, { signal }))
    },
    async importPages(spaceId, files) {
      const names = Object.keys(files)
      if (names.length === 0 || names.length > 64) throw new Error('一次导入必须包含 1 至 64 个文件')
      return parseWikiProposals(await postJson(`${spaceBase(spaceId)}/imports`, { files }))
    },
    async exportSpace(spaceId, signal) {
      return parseWikiExport(await requestAgentJson(`${spaceBase(spaceId)}/export`, { signal }))
    },
    async checkSpace(spaceId, signal) {
      return parseWikiChecks(await requestAgentJson(`${spaceBase(spaceId)}/checks`, { signal }))
    },
    async indexStatus(spaceId, signal) {
      return parseWikiIndexStatuses(await requestAgentJson(`${spaceBase(spaceId)}/indexes`, { signal }))
    },
    async rebuildIndex(spaceId, input: AgentMemoryIndexInput) {
      assertRequestId(input.requestId)
      if (!positiveInteger(input.profileRevision)) throw new Error('Embedding 配置修订必须是正整数')
      return parseWikiExtraction(await postJson(`${spaceBase(spaceId)}/indexes`, {
        requestId: input.requestId,
        profileId: input.profileId,
        profileRevision: input.profileRevision,
      }))
    },
    async listProposals(query, signal) {
      const params = agentQueryString({ spaceId: query.spaceId, status: query.status })
      const suffix = params === '' ? '' : `?${params}`
      return parseWikiProposals(await requestAgentJson(`${baseUrl}/memory-proposals${suffix}`, { signal }))
    },
    async decideProposal(proposalId, input: AgentMemoryProposalDecisionInput) {
      if (input.decision !== 'approved' && input.decision !== 'rejected') {
        throw new Error('候选决定必须为 approved 或 rejected')
      }
      return parseWikiProposal(await postJson(
        `${baseUrl}/memory-proposals/${agentPathPart(proposalId, '候选标识')}/decision`,
        { decision: input.decision },
      ))
    },
    async listExtractions(query: AgentPageQuery | undefined, signal) {
      const params = agentQueryString({ cursor: query?.cursor, limit: query?.limit })
      const suffix = params === '' ? '' : `?${params}`
      const body = await requestAgentJson(`${baseUrl}/memory-extractions${suffix}`, { signal })
      return parseAgentPage(body, parseWikiExtraction, '提炼任务分页')
    },
    async createExtraction(input: AgentCreateMemoryExtractionInput) {
      assertRequestId(input.requestId)
      if ((input.runId ?? '') === '' === ((input.workflowId ?? '') === '')) {
        throw new Error('手动提炼必须提供请求标识及唯一的成功运行或工作流编号')
      }
      return parseWikiExtraction(await postJson(`${baseUrl}/memory-extractions`, {
        requestId: input.requestId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      }))
    },
    async getExtraction(extractionId, signal) {
      return parseWikiExtraction(await requestAgentJson(
        `${baseUrl}/memory-extractions/${agentPathPart(extractionId, '任务标识')}`, { signal }))
    },
    async listEmbeddingProfiles(signal) {
      return parseEmbeddingProfiles(await requestAgentJson(`${baseUrl}/embedding-profiles`, { signal }))
    },
    async createEmbeddingProfile(input: AgentEmbeddingProfileInput) {
      return parseEmbeddingProfile(await postJson(`${baseUrl}/embedding-profiles`, input))
    },
    async updateEmbeddingProfile(profileId, input: AgentUpdateEmbeddingProfileInput) {
      if (!positiveInteger(input.expectedRevision)) throw new Error('Embedding 配置修订必须是正整数')
      return parseEmbeddingProfile(await putJson(
        `${baseUrl}/embedding-profiles/${agentPathPart(profileId, '配置标识')}`,
        input,
      ))
    },
    async listEmbeddingRequests(query: AgentPageQuery | undefined, signal) {
      const params = agentQueryString({ cursor: query?.cursor, limit: query?.limit })
      const suffix = params === '' ? '' : `?${params}`
      const body = await requestAgentJson(`${baseUrl}/embedding-requests${suffix}`, { signal })
      return parseAgentPage(body, parseEmbeddingRequest, 'Embedding 用量分页')
    },
  }
}

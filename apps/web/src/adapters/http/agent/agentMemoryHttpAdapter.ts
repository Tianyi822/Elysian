import { AGENT_MEMORY_PAGE_KINDS, AGENT_MEMORY_PROPOSAL_STATUSES, RUNTIME_RUN_STATUSES } from '@elysian/contracts'
import type { AgentMemoryPage, AgentMemoryProposal, AgentMemoryExtraction, AgentMemorySpace, AgentWikiRef, AgentMemorySpaceSelection } from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../../contracts/agentMemory'
import { agentPathPart, parseAgentPage, requestAgentJson } from './agentShared'
import { parseAgentModelProfile } from './agentCatalogParse'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wiki 响应无效')
  return value as Record<string, unknown>
}
function string(value: unknown): string { if (typeof value !== 'string') throw new Error('Wiki 文本字段无效'); return value }
function integer(value: unknown, min = 1): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('Wiki 修订字段无效'); return value }
function array<T>(value: unknown, parser: (v: unknown) => T): T[] { if (!Array.isArray(value)) throw new Error('Wiki 列表响应无效'); return value.map(parser) }
const strings = (value: unknown) => array(value, string)
export function parseWikiRef(value: unknown): AgentWikiRef { const row = object(value); return { pageId: string(row.pageId), revision: integer(row.revision), digest: string(row.digest) } }
export function parseMemorySpace(value: unknown): AgentMemorySpace {
  const row = object(value)
  if (row.kind !== 'business' && row.kind !== 'global') throw new Error('Wiki 空间类型无效')
  return { id: string(row.id), revision: integer(row.revision), name: string(row.name), kind: row.kind, createdAt: string(row.createdAt) }
}
export function parseMemoryPage(value: unknown): AgentMemoryPage {
  const row = object(value)
  if (!AGENT_MEMORY_PAGE_KINDS.includes(row.kind as AgentMemoryPage['kind']) || (row.status !== 'active' && row.status !== 'withdrawn')) throw new Error('Wiki 页面类型或状态无效')
  if (row.maintenance !== undefined && row.maintenance !== 'manual' && row.maintenance !== 'automatic') throw new Error('Wiki 维护方式无效')
  return {
    id: string(row.id), spaceId: string(row.spaceId), slug: string(row.slug), revision: integer(row.revision), title: string(row.title), markdown: string(row.markdown), kind: row.kind as AgentMemoryPage['kind'], status: row.status, digest: string(row.digest), createdAt: string(row.createdAt), updatedAt: string(row.updatedAt),
    maintenance: row.maintenance ?? 'manual',
    ...(row.expiresAt === undefined ? {} : { expiresAt: string(row.expiresAt) }), ...(row.withdrawnAt === undefined ? {} : { withdrawnAt: string(row.withdrawnAt) }),
    evidence: array(row.evidence ?? [], value => { const e = object(value); if (typeof e.originalCleared !== 'boolean') throw new Error('Wiki 来源状态无效'); return { id: string(e.id), kind: string(e.kind), text: string(e.text), createdAt: string(e.createdAt), digest: string(e.digest), originalCleared: e.originalCleared, ...(e.runId === undefined ? {} : { runId: string(e.runId) }), ...(e.eventSeq === undefined ? {} : { eventSeq: string(e.eventSeq) }), ...(e.uri === undefined ? {} : { uri: string(e.uri) }) } }),
    sources: array(row.sources ?? [], parseWikiRef), links: strings(row.links ?? []), ...(row.tags === undefined ? {} : { tags: strings(row.tags) }), ...(row.aliases === undefined ? {} : { aliases: strings(row.aliases) }),
  }
}
function parseProposal(value: unknown): AgentMemoryProposal {
  const row = object(value), page = object(row.page)
  if (!AGENT_MEMORY_PROPOSAL_STATUSES.includes(row.status as AgentMemoryProposal['status'])) throw new Error('Wiki 待确认状态无效')
  if (page.maintenance !== undefined && page.maintenance !== 'manual' && page.maintenance !== 'automatic') throw new Error('Wiki 维护方式无效')
  if (page.kind !== undefined && !AGENT_MEMORY_PAGE_KINDS.includes(page.kind as AgentMemoryPage['kind'])) throw new Error('Wiki 页面类型无效')
  const currentPage = row.currentPage === undefined ? undefined : parseMemoryPage(row.currentPage)
  if (currentPage && (currentPage.id !== row.pageId || currentPage.spaceId !== row.spaceId)) throw new Error('Wiki 待确认当前页面不匹配')
  return { ...(currentPage === undefined ? {} : { currentPage }), id: string(row.id), spaceId: string(row.spaceId), status: row.status as AgentMemoryProposal['status'], originKind: string(row.originKind), originId: string(row.originId), createdAt: string(row.createdAt), ...(row.reason === undefined ? {} : { reason: string(row.reason) }), ...(row.pageId === undefined ? {} : { pageId: string(row.pageId) }), ...(row.decidedAt === undefined ? {} : { decidedAt: string(row.decidedAt) }), page: { slug: string(page.slug), title: string(page.title), markdown: string(page.markdown), ...(page.expectedRevision === undefined ? {} : { expectedRevision: integer(page.expectedRevision, 0) }), ...(page.kind === undefined ? {} : { kind: page.kind as AgentMemoryPage['kind'] }), ...(page.maintenance === undefined ? {} : { maintenance: page.maintenance }), ...(page.sources === undefined ? {} : { sources: array(page.sources ?? [], parseWikiRef) }) } }
}
function parseExtraction(value: unknown): AgentMemoryExtraction {
  const row = object(value), usage = object(row.usage)
  const statuses: readonly string[] = RUNTIME_RUN_STATUSES
  if (!statuses.includes(string(row.status)) || (row.kind !== 'extraction' && row.kind !== 'embedding')) throw new Error('Wiki 整理任务状态无效')
  for (const [key, value] of Object.entries(usage)) if (key.endsWith('Tokens') && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Wiki 用量无效')
  if (row.strategy !== undefined && row.strategy !== 'navigation/v1') throw new Error('Wiki 整理策略无效')
  const error = row.error === undefined ? undefined : object(row.error)
  return { id: string(row.id), kind: row.kind, originKind: string(row.originKind), originId: string(row.originId), spaceId: string(row.spaceId), status: row.status as AgentMemoryExtraction['status'], generation: integer(row.generation, 0), model: parseAgentModelProfile(row.model), createdAt: string(row.createdAt), estimatedTokens: integer(row.estimatedTokens, 0), usage, candidateIds: strings(row.candidateIds ?? []), sources: array(row.sources ?? [], parseWikiRef), ...(row.publishedRefs === undefined ? {} : { publishedRefs: array(row.publishedRefs, parseWikiRef) }), ...(row.strategy === undefined ? {} : { strategy: row.strategy }), ...(row.startedAt === undefined ? {} : { startedAt: string(row.startedAt) }), ...(row.taskId === undefined ? {} : { taskId: string(row.taskId) }), ...(row.runId === undefined ? {} : { runId: string(row.runId) }), ...(row.workflowId === undefined ? {} : { workflowId: string(row.workflowId) }), ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt) }), ...(error === undefined ? {} : { error: { code: string(error.code), message: string(error.message) } }) }
}
function parseSelection(value: unknown): AgentMemorySpaceSelection {
  const row = object(value)
  if (typeof row.includeGlobal !== 'boolean') throw new Error('Wiki 会话选择无效')
  return { spaceId: string(row.spaceId), includeGlobal: row.includeGlobal }
}

export function createHttpAgentMemoryAdapter(baseUrl = '/api/agent'): AgentMemoryAdapter {
  const space = (id: string) => `${baseUrl}/memory-spaces/${agentPathPart(id)}`
  const page = (spaceId: string, id: string) => `${space(spaceId)}/pages/${agentPathPart(id)}`
  const json = (url: string, method: string, body: unknown) => requestAgentJson(url, { method, body: JSON.stringify(body) })
  return {
    listSpaces: async signal => array(await requestAgentJson(`${baseUrl}/memory-spaces`, { signal }), parseMemorySpace),
    createSpace: async input => parseMemorySpace(await json(`${baseUrl}/memory-spaces`, 'POST', input)),
    listPages: async (id, signal) => array(await requestAgentJson(`${space(id)}/pages?includeWithdrawn=1`, { signal }), parseMemoryPage),
    getPage: async (sid, id, signal) => parseMemoryPage(await requestAgentJson(page(sid, id), { signal })),
    createPage: async (sid, input) => parseMemoryPage(await json(`${space(sid)}/pages`, 'POST', input)),
    updatePage: async (sid, id, input) => parseMemoryPage(await json(page(sid, id), 'PUT', input)),
    withdrawPage: async (sid, id, expectedRevision) => parseMemoryPage(await json(page(sid, id), 'DELETE', { expectedRevision })),
    listRevisions: async (sid, id, signal) => array(await requestAgentJson(`${page(sid, id)}/revisions`, { signal }), parseMemoryPage),
    getReference: async (ref, signal) => { const result = parseMemoryPage(await requestAgentJson(`${baseUrl}/memory-pages/${agentPathPart(ref.pageId)}/revisions/${ref.revision}`, { signal })); if (result.id !== ref.pageId || result.revision !== ref.revision || result.digest !== ref.digest) throw new Error('Wiki 来源修订或摘要不匹配'); return result },
    getRevision: async (sid, id, revision, signal) => { const result = parseMemoryPage(await requestAgentJson(`${page(sid, id)}/revisions/${revision}`, { signal })); if (result.id !== id || result.spaceId !== sid || result.revision !== revision) throw new Error('Wiki 页面修订不匹配'); return result },
    search: async (sid, query, signal) => { const row = object(await requestAgentJson(`${space(sid)}/search?q=${encodeURIComponent(query)}&limit=50`, { signal })); if (typeof row.degraded !== 'boolean') throw new Error('Wiki 搜索状态无效'); return { items: array(row.items, value => { const hit = object(value); if (typeof hit.score !== 'number' || (hit.method !== 'sqlite-text' && hit.method !== 'hybrid-rrf')) throw new Error('Wiki 搜索结果无效'); return { page: parseMemoryPage(hit.page), score: hit.score, method: hit.method } }), degraded: row.degraded, ...(row.reason === undefined ? {} : { reason: string(row.reason) }) } },
    listProposals: async (sid, signal) => array(await requestAgentJson(`${baseUrl}/memory-proposals?spaceId=${encodeURIComponent(sid)}&status=pending`, { signal }), parseProposal),
    decideProposal: async (id, decision, expectedRevision) => { const result = parseProposal(await json(`${baseUrl}/memory-proposals/${agentPathPart(id)}/decision`, 'POST', { decision, ...(expectedRevision === undefined ? {} : { expectedRevision }) })); if (result.id !== id || result.status !== decision) throw new Error('Wiki 决定回执不匹配，请重新读取待确认记录'); return result },
    listExtractions: async (cursor, signal) => parseAgentPage(await requestAgentJson(`${baseUrl}/memory-extractions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }), parseExtraction),
    getExtraction: async (id, signal) => parseExtraction(await requestAgentJson(`${baseUrl}/memory-extractions/${agentPathPart(id)}`, { signal })),
    importSource: async (sid, input) => { const row = object(await json(`${space(sid)}/sources`, 'POST', input)); return { source: parseMemoryPage(row.source), job: parseExtraction(row.job) } },
    getSelection: async (id, signal) => parseSelection(await requestAgentJson(`${baseUrl}/sessions/${agentPathPart(id)}/memory`, { signal })),
    setSelection: async (id, selection) => parseSelection(await json(`${baseUrl}/sessions/${agentPathPart(id)}/memory-space`, 'PUT', selection)),
  }
}

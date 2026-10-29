import { AGENT_MEMORY_PAGE_KINDS } from '@elysian/contracts'
import type { AgentMemoryPage, AgentMemorySpace, AgentWikiRef } from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../../contracts/agentMemory'
import { agentPathPart, requestAgentJson } from './agentShared'

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
export function createHttpAgentMemoryAdapter(baseUrl = '/api/agent'): AgentMemoryAdapter {
  const space = (id: string) => `${baseUrl}/memory-spaces/${agentPathPart(id)}`
  const page = (spaceId: string, id: string) => `${space(spaceId)}/pages/${agentPathPart(id)}`
  const json = (url: string, method: string, body: unknown) => requestAgentJson(url, { method, body: JSON.stringify(body) })
  return {
    listSpaces: async signal => array(await requestAgentJson(`${baseUrl}/memory-spaces`, { signal }), parseMemorySpace),
    listPages: async (id, signal) => array(await requestAgentJson(`${space(id)}/pages?includeWithdrawn=1`, { signal }), parseMemoryPage),
    getPage: async (sid, id, signal) => parseMemoryPage(await requestAgentJson(page(sid, id), { signal })),
    updatePage: async (sid, id, input) => parseMemoryPage(await json(page(sid, id), 'PUT', input)),
    getReference: async (ref, signal) => { const result = parseMemoryPage(await requestAgentJson(`${baseUrl}/memory-pages/${agentPathPart(ref.pageId)}/revisions/${ref.revision}`, { signal })); if (result.id !== ref.pageId || result.revision !== ref.revision || result.digest !== ref.digest) throw new Error('Wiki 来源修订或摘要不匹配'); return result },
    getRevision: async (sid, id, revision, signal) => { const result = parseMemoryPage(await requestAgentJson(`${page(sid, id)}/revisions/${revision}`, { signal })); if (result.id !== id || result.spaceId !== sid || result.revision !== revision) throw new Error('Wiki 页面修订不匹配'); return result },
  }
}

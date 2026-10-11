import type { AgentMemoryPage, AgentMemorySearchResult, AgentMemorySpace } from '@elysian/contracts'
import { AGENT_MEMORY_PAGE_KINDS } from '@elysian/contracts'
import type { AgentWikiReadAdapter } from '../../contracts/adapters'
import { withRequestDeadline } from './requestDeadline'
import { reportUnauthorized } from './unauthorized'

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

/** 服务端公开空间列表；拒绝形状漂移，避免未来界面把错误体当作空列表。 */
export function parseWikiSpaces(value: unknown): readonly AgentMemorySpace[] {
  if (!Array.isArray(value)) throw new Error('Wiki 空间列表响应无效')
  return value.map((item) => {
    const row = object(item, 'Wiki 空间响应无效')
    if (typeof row.id !== 'string' || !positiveInteger(row.revision) ||
      typeof row.name !== 'string' || (row.kind !== 'business' && row.kind !== 'global') ||
      typeof row.createdAt !== 'string') throw new Error('Wiki 空间响应无效')
    return row as AgentMemorySpace
  })
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

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return withRequestDeadline({ signal }, async (init) => {
    let response: Response
    try {
      response = await fetch(url, { cache: 'no-store', signal: init.signal })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error('Wiki 读取网络失败')
    }
    if (!response.ok) {
      if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
      const body = await response.json().catch(() => null)
      const detail = body !== null && typeof body === 'object' && !Array.isArray(body) &&
        typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error.slice(0, 200) : null
      throw new Error(detail || `Wiki 读取失败：HTTP ${response.status}`)
    }
    try {
      return await response.json()
    } catch {
      throw new Error('Wiki 响应不是有效 JSON')
    }
  })
}

function pathPart(value: string): string {
  if (!value) throw new Error('Wiki 标识不能为空')
  return encodeURIComponent(value)
}

export function createHttpAgentWikiReadAdapter(baseUrl = '/api/agent/memory-spaces'): AgentWikiReadAdapter {
  const pageBase = (spaceId: string, pageId: string) => `${baseUrl}/${pathPart(spaceId)}/pages/${pathPart(pageId)}`
  return {
    available: true,
    async listSpaces(signal) {
      return parseWikiSpaces(await readJson(baseUrl, signal))
    },
    async listPages(spaceId, includeWithdrawn = false, signal) {
      const suffix = includeWithdrawn ? '?includeWithdrawn=1' : ''
      return parseWikiPages(await readJson(`${baseUrl}/${pathPart(spaceId)}/pages${suffix}`, signal))
    },
    async getPage(spaceId, pageId, signal) {
      return parseWikiPage(await readJson(pageBase(spaceId, pageId), signal))
    },
    async getPageRevision(spaceId, pageId, revision, signal) {
      if (!positiveInteger(revision)) throw new Error('Wiki 修订必须是正整数')
      return parseWikiPage(await readJson(`${pageBase(spaceId, pageId)}/revisions/${revision}`, signal))
    },
    async search(spaceId, query, limit = 8, signal) {
      if (!query.trim() || new TextEncoder().encode(query).length > 256) throw new Error('Wiki 搜索内容不能为空或超过 256 字节')
      if (!positiveInteger(limit) || limit > 200) throw new Error('Wiki 搜索条数必须是 1 到 200 的整数')
      const params = new URLSearchParams({ q: query, limit: String(limit) })
      return parseWikiSearchResult(await readJson(`${baseUrl}/${pathPart(spaceId)}/search?${params}`, signal))
    },
  }
}

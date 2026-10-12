import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMemoryPage } from '@elysian/contracts'
import { runAgentMemoryAdapterContract } from '../../agentMemoryAdapterContract'
import {
  createHttpAgentMemoryAdapter,
  parseWikiPage,
  parseWikiSearchResult,
  parseWikiSpaces,
} from './agentMemoryHttpAdapter'
import { stubAgentJsonFetch } from '../../../test/agentTestUtils'

afterEach(() => vi.unstubAllGlobals())

/*
 * HTTP 适配器测试分两层（沿 agentCapabilitiesHttpAdapter.test.ts 先例）：
 * 1. 契约断言：跑在与 mock 同一套 runAgentMemoryAdapterContract 上，fetch 换成
 *    有状态假服务（模拟 Go 路由的 CAS/撤回传播/幂等/校验语义），验证「mock 可替换」；
 * 2. 接线断言：静态路由 stub 检查请求落到精确路径、方法与查询串——重点：
 *    DELETE 撤回的 expectedRevision 在 JSON body 而非查询参数、PUT 的
 *    expectedRevision 在页面 Input 体内、无 requestId 的端点请求体绝不含 requestId。
 */

const SPACE = { id: 'space-1', revision: 3, name: '容器运维', kind: 'business', createdAt: '2026-10-10T00:00:00Z' }
const PAGE = {
  id: 'page-1', spaceId: 'space-1', slug: 'runbook/restart', revision: 2, title: '重启策略',
  markdown: '# 重启策略', kind: 'runbook', status: 'active', digest: 'page-digest',
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:01:00Z',
  evidence: [], sources: [], links: [],
}

describe('记忆域共享 parse', () => {
  it('空间列表逐项校验，形状漂移抛中文错误', () => {
    expect(parseWikiSpaces([SPACE])).toEqual([SPACE])
    expect(() => parseWikiSpaces([{ ...SPACE, kind: '未知' }])).toThrow('Wiki 空间响应无效')
    expect(() => parseWikiSpaces('不是数组')).toThrow('Wiki 空间列表响应无效')
  })

  it('页面校验证据与来源结构，修订必须为正整数', () => {
    expect(parseWikiPage(PAGE)).toEqual(PAGE)
    expect(() => parseWikiPage({ ...PAGE, revision: 0 })).toThrow('Wiki 页面响应无效')
    expect(() => parseWikiPage({ ...PAGE, sources: [{ pageId: 'p', revision: 1 }] })).toThrow('Wiki 页面响应无效')
    expect(() => parseWikiPage({ ...PAGE, evidence: [{ id: 'e', kind: 'run', text: 'x', createdAt: 't', digest: 'd', originalCleared: 'yes' }] }))
      .toThrow('Wiki 页面响应无效')
  })

  it('搜索结果带 score/method，降级原因可选', () => {
    const body = { items: [{ page: PAGE, score: 1.5, method: 'sqlite-text' }], degraded: true, reason: 'Embedding 未配置' }
    expect(parseWikiSearchResult(body)).toEqual({
      items: [{ page: PAGE, score: 1.5, method: 'sqlite-text' }], degraded: true, reason: 'Embedding 未配置',
    })
    expect(() => parseWikiSearchResult({ items: [], degraded: true, reason: 1 })).toThrow('Wiki 搜索响应无效')
    expect(() => parseWikiSearchResult({ items: [{ page: PAGE, score: 1, method: '未知' }], degraded: false })).toThrow('Wiki 搜索命中响应无效')
  })
})

type Recorded = { url: string; method: string; body: string }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function errorBody(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), { status, headers: { 'content-type': 'application/json' } })
}

const SEED_BASE = '2026-10-10T00:00:00Z'

/** 有状态假服务：实现契约断言触达的记忆域语义（种子与 mock 数据同形）。 */
function makeFakeMemoryServer(): { fetchMock: ReturnType<typeof vi.fn>; requests: Recorded[] } {
  const requests: Recorded[] = []
  let seq = 100
  const nextId = (prefix: string): string => `${prefix}-${++seq}`
  const stamp = (): string => SEED_BASE

  type FakeSpace = { id: string; revision: number; name: string; kind: string; createdAt: string }
  const spaces: FakeSpace[] = [
    { id: 'space-global', revision: 1, name: '全局运维常识', kind: 'global', createdAt: stamp() },
    { id: 'space-1', revision: 1, name: '容器运维', kind: 'business', createdAt: stamp() },
  ]
  const mkPage = (id: string, slug: string, title: string, markdown: string, kind: AgentMemoryPage['kind'], revision = 1, status: AgentMemoryPage['status'] = 'active'): AgentMemoryPage => ({
    id, spaceId: 'space-1', slug, revision, title, markdown, kind, status,
    digest: `digest-${id}-${revision}`, createdAt: stamp(), updatedAt: stamp(),
    evidence: [], sources: [], links: [], tags: [],
  })
  const pageA1 = mkPage('page-a', 'runbook/container-restart', '容器重启手册', '# 容器重启手册\n\n先核对健康状态，再按顺序重启。', 'runbook')
  const pageA2: AgentMemoryPage = { ...pageA1, revision: 2, markdown: `${pageA1.markdown}；重启后观察五分钟。相关约定见 [[page-b]]。`, links: ['page-b'] }
  const pageB = mkPage('page-b', 'reference/port-map', '端口映射约定', '# 端口映射约定\n\n面板前端固定 48100，后端固定 48101。', 'reference')
  const pageC: AgentMemoryPage = { ...mkPage('page-c', 'observation/disk-noise', '磁盘噪声观察', '# 磁盘噪声观察', 'observation', 2, 'withdrawn'), withdrawnAt: stamp() }
  const pageD = mkPage('page-d', 'observation/backup-window', '备份窗口观察', '# 备份窗口观察', 'observation')
  const pages = new Map<string, AgentMemoryPage>([['page-a', pageA2], ['page-b', pageB], ['page-c', pageC], ['page-d', pageD]])
  const pageRevisions = new Map<string, AgentMemoryPage>([
    ['page-a:1', pageA1], ['page-a:2', pageA2], ['page-b:1', pageB],
    ['page-c:1', { ...pageC, revision: 1, status: 'active', withdrawnAt: undefined }], ['page-c:2', pageC], ['page-d:1', pageD],
  ])
  // eslint 处的宽类型是有意的：假服务按运行时字段读写，不逐字面量建模。
  const proposals: Record<string, unknown>[] = [
    { id: 'prop-1', spaceId: 'space-1', status: 'pending', originKind: 'extraction', originId: 'ext-1', createdAt: stamp(), page: { slug: 'convention/naming', title: '容器命名约定', markdown: '# 容器命名约定', kind: 'convention', evidence: [], sources: [] } },
    { id: 'prop-2', spaceId: 'space-1', pageId: 'page-b', status: 'approved', originKind: 'extraction', originId: 'ext-1', createdAt: stamp(), decidedAt: stamp(), page: { expectedRevision: 0, slug: 'reference/port-map', title: '端口映射约定', markdown: '# 端口映射约定', kind: 'reference', evidence: [], sources: [] } },
    { id: 'prop-3', spaceId: 'space-1', status: 'rejected', originKind: 'markdown-import', originId: 'notes.md', createdAt: stamp(), decidedAt: stamp(), page: { slug: 'notes', title: '临时笔记', markdown: '# 临时笔记', kind: 'reference', evidence: [], sources: [] } },
  ]
  const model = { id: 'model-seed', revision: 1, name: '演示模型', baseUrl: 'https://model.example.test/v1', model: 'demo-model', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096, capabilities: { text: true, tools: true, source: 'demo' }, active: true, hasCredential: true }
  const jobs: Record<string, unknown>[] = [
    { id: 'ext-1', kind: 'extraction', originKind: 'run', originId: 'run-seed-1', spaceId: 'space-1', status: 'succeeded', memoryStatus: 'updated', taskId: 'task-seed-1', runId: 'run-seed-1', generation: 1, model, createdAt: stamp(), startedAt: stamp(), endedAt: stamp(), usage: { promptTokens: 812, totalTokens: 812 }, estimatedTokens: 700, candidateIds: ['prop-1'], sources: [{ pageId: 'page-b', revision: 1, digest: 'digest-page-b-1' }] },
    { id: 'ext-2', kind: 'extraction', originKind: 'workflow', originId: 'wf-seed-1', spaceId: 'space-1', status: 'failed', memoryStatus: 'stale', taskId: 'task-seed-2', workflowId: 'wf-seed-1', generation: 1, model, createdAt: stamp(), usage: {}, estimatedTokens: 0, candidateIds: [], sources: [], error: { code: 'memory-extraction-failed', message: '长期记忆提炼失败，已有记忆保持不变' } },
    { id: 'ext-3', kind: 'extraction', originKind: 'run', originId: 'run-seed-2', spaceId: 'space-1', status: 'interrupted', memoryStatus: 'stale', taskId: 'task-seed-3', runId: 'run-seed-2', generation: 2, model, createdAt: stamp(), usage: {}, estimatedTokens: 0, candidateIds: [], sources: [], error: { code: 'panel-restarted', message: '面板重启中断了长期记忆提炼，未自动重试' } },
  ]
  const profiles: Record<string, unknown>[] = [
    { id: 'emb-1', revision: 2, name: '通用文本向量', baseUrl: 'https://embedding.example.test/v1', model: 'text-embed-demo', dimensions: 1536, active: true, hasCredential: true },
    { id: 'emb-2', revision: 1, name: '备用向量（停用）', baseUrl: 'http://127.0.0.1:9000/v1', model: 'local-embed', dimensions: 512, active: false, hasCredential: false },
  ]
  const embeddingRequests: Record<string, unknown>[] = [
    { id: 'embed-req-1', profileId: 'emb-1', profileRevision: 2, purpose: 'index', jobId: 'job-embed-seed-1', page: { pageId: 'page-a', revision: 2, digest: 'digest-page-a-2' }, status: 'succeeded', inputBytes: 512, inputDigest: 'digest-req-1', estimatedTokens: 96, usage: { promptTokens: 96, totalTokens: 96 }, startedAt: stamp(), endedAt: stamp() },
    { id: 'embed-req-2', profileId: 'emb-1', profileRevision: 2, purpose: 'query', status: 'succeeded', inputBytes: 64, inputDigest: 'digest-req-2', estimatedTokens: 12, usage: {}, startedAt: stamp(), endedAt: stamp() },
    { id: 'embed-req-3', profileId: 'emb-2', profileRevision: 1, purpose: 'index', status: 'failed', inputBytes: 256, inputDigest: 'digest-req-3', estimatedTokens: 48, usage: {}, startedAt: stamp(), endedAt: stamp(), error: { code: 'embedding-request-failed', message: 'Embedding 服务请求失败' } },
  ]

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).href
    const [path, query = ''] = url.split('?')
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' })
    const segments = (path ?? url).replace('/api/agent/', '').split('/').map(decodeURIComponent)
    const body = method === 'GET' ? {} : JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
    const params = new URLSearchParams(query)

    if (segments[0] === 'memory-spaces' && segments.length === 1) {
      if (method === 'GET') return jsonResponse(spaces)
      // POST：建空间（global 唯一 409）
      if (body.kind === 'global' && spaces.some((space) => space.kind === 'global')) {
        return errorBody(409, 'wiki-global-exists', '全局 Wiki 空间已存在')
      }
      const name = typeof body.name === 'string' ? body.name : ''
      if (name.trim() === '' || name.length > 120) return errorBody(400, 'invalid-wiki-space', 'Wiki 空间名称无效')
      const space = { id: nextId('space'), revision: 1, name, kind: body.kind as string, createdAt: stamp() }
      spaces.push(space)
      return jsonResponse(space, 201)
    }
    if (segments[0] === 'memory-spaces' && segments.length === 2 && method === 'PUT') {
      const space = spaces.find((row) => row.id === segments[1])
      if (space === undefined) return errorBody(404, 'wiki-space-not-found', 'Wiki 空间不存在')
      if (space.revision !== body.expectedRevision) return errorBody(409, 'revision-conflict', '记忆空间版本已变化')
      space.revision += 1
      space.name = typeof body.name === 'string' ? body.name : space.name
      return jsonResponse(space)
    }
    const spaceId = segments[0] === 'memory-spaces' ? segments[1] : undefined
    const pagesOf = (includeWithdrawn: boolean): AgentMemoryPage[] =>
      [...pages.values()].filter((page) => page.spaceId === spaceId && (includeWithdrawn || page.status !== 'withdrawn'))

    if (spaceId !== undefined && segments[2] === 'pages' && segments.length === 3) {
      if (method === 'GET') return jsonResponse(pagesOf(params.get('includeWithdrawn') === '1'))
      if (method === 'POST') {
        const page: AgentMemoryPage = {
          id: nextId('page'), spaceId, revision: 1, status: 'active',
          slug: String(body.slug ?? ''), title: String(body.title ?? ''), markdown: String(body.markdown ?? ''),
          kind: (body.kind ?? 'reference') as AgentMemoryPage['kind'],
          digest: `digest-${String(body.slug ?? '')}`, createdAt: stamp(), updatedAt: stamp(),
          evidence: (body.evidence ?? []) as AgentMemoryPage['evidence'],
          sources: (body.sources ?? []) as AgentMemoryPage['sources'],
          links: [], tags: (body.tags ?? []) as AgentMemoryPage['tags'],
        }
        if (new TextEncoder().encode(String(body.markdown ?? '')).length > 16 * 1024) {
          return errorBody(400, 'invalid-wiki-page', 'Wiki 页面 slug、标题或正文无效')
        }
        pages.set(page.id, page)
        pageRevisions.set(`${page.id}:1`, page)
        return jsonResponse(page, 201)
      }
    }
    if (spaceId !== undefined && segments[2] === 'pages' && segments.length === 4) {
      const page = pages.get(segments[3] ?? '')
      if (page === undefined || page.spaceId !== spaceId) return errorBody(404, 'wiki-page-not-found', 'Wiki 页面不存在')
      if (method === 'GET') return jsonResponse(page)
      if (method === 'PUT') {
        if ((body.expectedRevision ?? 0) !== page.revision) return errorBody(409, 'revision-conflict', 'Wiki 页面版本已变化，请重新读取')
        const updated: AgentMemoryPage = { ...page, revision: page.revision + 1, title: body.title as string, markdown: body.markdown as string, kind: (body.kind ?? page.kind) as AgentMemoryPage['kind'], digest: `digest-${page.id}-${page.revision + 1}`, updatedAt: stamp(), withdrawnAt: undefined }
        pages.set(page.id, updated)
        pageRevisions.set(`${page.id}:${updated.revision}`, updated)
        return jsonResponse(updated)
      }
      if (method === 'DELETE') {
        if (body.expectedRevision !== page.revision) return errorBody(409, 'revision-conflict', 'Wiki 页面版本已变化，请重新读取')
        const withdrawn: AgentMemoryPage = { ...page, revision: page.revision + 1, status: 'withdrawn', withdrawnAt: stamp(), updatedAt: stamp() }
        pages.set(page.id, withdrawn)
        pageRevisions.set(`${page.id}:${withdrawn.revision}`, withdrawn)
        for (const proposal of proposals) {
          if (proposal.status === 'pending' && Array.isArray((proposal.page as Record<string, unknown>).sources) &&
            ((proposal.page as Record<string, unknown>).sources as { pageId?: string }[]).some((source) => source.pageId === page.id)) {
            proposal.status = 'invalidated'
          }
        }
        return jsonResponse(withdrawn)
      }
    }
    if (spaceId !== undefined && segments[2] === 'pages' && segments[4] === 'revisions' && method === 'GET') {
      const revision = Number(segments[5])
      const hit = pageRevisions.get(`${segments[3]}:${revision}`)
      if (hit === undefined || hit.spaceId !== spaceId) return errorBody(404, 'wiki-revision-not-found', 'Wiki 页面修订不存在')
      return jsonResponse(hit)
    }
    if (spaceId !== undefined && segments[2] === 'search' && method === 'GET') {
      const q = params.get('q') ?? ''
      const items = pagesOf(false)
        .filter((page) => page.status === 'active')
        .map((page) => ({ page, score: 0.5, method: 'sqlite-text' }))
        .filter(() => q.includes('端口') || q.includes('映射'))
        .slice(0, 1)
      return jsonResponse({ items, degraded: true, reason: '使用 SQLite 中文双字全文回落' })
    }
    if (spaceId !== undefined && segments[2] === 'imports' && method === 'POST') {
      const files = (body.files ?? {}) as Record<string, string>
      const names = Object.keys(files)
      if (names.length === 0 || names.length > 64) return errorBody(400, 'wiki-import-limit', '一次导入必须包含 1 至 64 个文件')
      const created = names.map((name) => ({
        id: nextId('prop'), spaceId, status: 'pending', originKind: 'markdown-import', originId: name, createdAt: stamp(),
        page: { slug: name.replace(/\.md$/, ''), title: name.replace(/\.md$/, ''), markdown: files[name] ?? '', kind: 'reference', evidence: [], sources: [] },
      }))
      proposals.unshift(...created)
      return jsonResponse(created, 202)
    }
    if (spaceId !== undefined && segments[2] === 'export' && method === 'GET') {
      const all = [...pages.values()].filter((page) => page.spaceId === spaceId)
      const files: Record<string, string> = { 'index.md': '# Wiki 索引\n', 'changelog.md': '# 修订记录\n', 'sources.json': '{}' }
      for (const page of all) files[`pages/${page.id}.md`] = `# ${page.title}\n\n${page.markdown}\n`
      return jsonResponse({ files })
    }
    if (spaceId !== undefined && segments[2] === 'checks' && method === 'GET') {
      return jsonResponse({
        orphanPages: ['page-d'], brokenLinks: ['runbook/container-restart -> page-b'],
        expiredPages: ['observation/backup-window'], invalidSources: ['observation/backup-window -> page-gone:1'],
      })
    }
    if (spaceId !== undefined && segments[2] === 'indexes' && segments.length === 3) {
      if (method === 'GET') {
        const activeCount = pagesOf(false).length
        return jsonResponse([
          { profile: profiles[0], pages: activeCount, indexedPages: Math.min(1, activeCount), status: 'stale' },
          { profile: profiles[1], pages: activeCount, indexedPages: 0, status: 'stale' },
        ])
      }
      if (method === 'POST') {
        const prior = jobs.find((job) => job.kind === 'embedding' && job.originId === body.requestId)
        if (prior !== undefined) {
          if ((prior.embeddingProfile as Record<string, unknown> | undefined)?.id !== body.profileId) {
            return errorBody(409, 'request-conflict', '索引重建请求标识已用于其他参数')
          }
          return jsonResponse(prior, 200)
        }
        const profile = profiles.find((row) => row.id === body.profileId && row.revision === body.profileRevision)
        if (profile === undefined || profile.active !== true) {
          return errorBody(400, 'embedding-profile-unavailable', 'Embedding 配置不存在、已停用或修订不可用')
        }
        const job = {
          id: nextId('job'), kind: 'embedding', originKind: 'space', originId: body.requestId, spaceId, status: 'queued',
          generation: 0, embeddingProfile: profile,
          model: { id: '', revision: 0, name: '', baseUrl: '', model: '', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 0, outputTokens: 0, capabilities: { text: false, tools: false, source: '' }, active: false, hasCredential: false },
          createdAt: stamp(), usage: {}, estimatedTokens: 0, candidateIds: [], sources: [],
        }
        jobs.unshift(job)
        return jsonResponse(job, 202)
      }
    }
    if (segments[0] === 'memory-proposals' && method === 'GET') {
      const status = params.get('status')
      const spaceFilter = params.get('spaceId')
      return jsonResponse(proposals.filter((row) =>
        (status === null || row.status === status) && (spaceFilter === null || row.spaceId === spaceFilter)))
    }
    if (segments[0] === 'memory-proposals' && segments[2] === 'decision' && method === 'POST') {
      const proposal = proposals.find((row) => row.id === segments[1])
      if (proposal === undefined) return errorBody(404, 'wiki-candidate-not-found', 'Wiki 候选不存在')
      if (proposal.status === 'invalidated') return errorBody(409, 'wiki-source-withdrawn', '候选来源已撤回，不能发布')
      if (proposal.status !== 'pending') {
        if (proposal.status === body.decision) return jsonResponse(proposal)
        return errorBody(409, 'wiki-candidate-decided', 'Wiki 候选已处理')
      }
      if (body.decision === 'approved') {
        const input = proposal.page as Record<string, unknown>
        const page: AgentMemoryPage = {
          id: nextId('page'), spaceId: proposal.spaceId as string, revision: 1, status: 'active',
          slug: String(input.slug ?? ''), title: String(input.title ?? ''), markdown: String(input.markdown ?? ''),
          kind: (input.kind ?? 'reference') as AgentMemoryPage['kind'],
          digest: `digest-${String(input.slug ?? '')}`, createdAt: stamp(), updatedAt: stamp(),
          evidence: [], sources: [], links: [], tags: [],
        }
        pages.set(page.id, page)
        pageRevisions.set(`${page.id}:1`, page)
        proposal.pageId = page.id
      }
      proposal.status = body.decision
      proposal.decidedAt = stamp()
      return jsonResponse(proposal)
    }
    if (segments[0] === 'memory-extractions') {
      if (method === 'GET' && segments.length === 1) {
        const offset = Number(params.get('cursor') ?? '0')
        const limit = Number(params.get('limit') ?? '50')
        const extractionJobs = jobs.filter((job) => job.kind === 'extraction')
        const items = extractionJobs.slice(offset, offset + limit)
        return jsonResponse({ items, nextCursor: offset + limit < extractionJobs.length ? String(offset + limit) : '', hasMore: offset + limit < extractionJobs.length })
      }
      if (method === 'POST') {
        if ((body.runId === undefined) === (body.workflowId === undefined)) {
          return errorBody(400, 'invalid-memory-extraction', '手动提炼必须提供请求标识及唯一的成功运行或工作流编号')
        }
        const prior = jobs.find((job) => job.kind === 'extraction' && job.originKind === 'manual' && job.originId === body.requestId)
        if (prior !== undefined) {
          if (prior.runId !== body.runId || prior.workflowId !== body.workflowId) {
            return errorBody(409, 'request-conflict', '提炼请求标识已用于其他来源')
          }
          return jsonResponse(prior, 200)
        }
        const originKind = body.runId !== undefined ? 'run' : 'workflow'
        const originId = (originKind === 'run' ? body.runId : body.workflowId) as string
        const snapshot = jobs.find((job) => job.kind === 'extraction' && job.originKind === originKind && job.originId === originId)
        if (snapshot === undefined) return errorBody(400, 'memory-space-unselected', '成功来源没有固定的长期记忆提炼快照，无法提炼')
        const job = { ...snapshot, id: nextId('ext'), originKind: 'manual', originId: body.requestId, status: 'queued', memoryStatus: 'unchanged', createdAt: stamp(), candidateIds: [], startedAt: undefined, endedAt: undefined }
        jobs.unshift(job)
        return jsonResponse(job, 202)
      }
      if (method === 'GET' && segments.length === 2) {
        const job = jobs.find((row) => row.id === segments[1])
        if (job === undefined) return errorBody(404, 'memory-extraction-not-found', '长期记忆提炼任务不存在')
        return jsonResponse(job)
      }
    }
    if (segments[0] === 'embedding-profiles') {
      if (method === 'GET') return jsonResponse(profiles)
      if (method === 'POST') {
        const dimensions = Number(body.dimensions)
        if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
          return errorBody(400, 'invalid-embedding-profile', 'Embedding 配置名称、模型或维度无效')
        }
        try {
          const url = new URL(String(body.baseUrl ?? ''))
          if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.search !== '' || url.hash !== '') {
            throw new Error('bad url')
          }
        } catch {
          return errorBody(400, 'invalid-embedding-profile', 'Embedding 服务地址必须是无凭据、查询参数或片段的 HTTP 地址')
        }
        const profile = { id: nextId('emb'), revision: 1, name: body.name, baseUrl: body.baseUrl, model: body.model, dimensions, active: body.active, hasCredential: typeof body.credential === 'string' && body.credential !== '' }
        profiles.push(profile)
        return jsonResponse(profile, 201)
      }
      if (method === 'PUT') {
        const profile = profiles.find((row) => row.id === segments[1])
        if (profile === undefined) return errorBody(404, 'embedding-profile-not-found', 'Embedding 配置不存在')
        if (profile.revision !== body.expectedRevision) return errorBody(409, 'revision-conflict', 'Embedding 配置已变化，请重新读取')
        profile.revision = Number(profile.revision) + 1
        profile.name = body.name
        profile.active = body.active
        return jsonResponse(profile)
      }
    }
    if (segments[0] === 'embedding-requests' && method === 'GET') {
      const offset = Number(params.get('cursor') ?? '0')
      const limit = Number(params.get('limit') ?? '50')
      const items = embeddingRequests.slice(offset, offset + limit)
      return jsonResponse({ items, nextCursor: '', hasMore: false })
    }
    return errorBody(404, 'not-found', `测试未登记的 Agent 端点：${url}`)
  })

  return { fetchMock, requests }
}

describe('createHttpAgentMemoryAdapter 契约（有状态假服务）', () => {
  runAgentMemoryAdapterContract('HTTP', () => {
    vi.stubGlobal('fetch', makeFakeMemoryServer().fetchMock)
    return createHttpAgentMemoryAdapter()
  })
})

describe('createHttpAgentMemoryAdapter 接线', () => {
  it('五个只读方法落到 /api/agent 精确路径与查询串', async () => {
    const fetchMock = stubAgentJsonFetch({
      '/api/agent/memory-spaces': [SPACE],
      '/api/agent/memory-spaces/space-1/pages': [PAGE],
      '/api/agent/memory-spaces/space-1/pages/page-1': PAGE,
      '/api/agent/memory-spaces/space-1/pages/page-1/revisions/2': PAGE,
      '/api/agent/memory-spaces/space-1/search': { items: [], degraded: false },
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentMemoryAdapter()
    expect(adapter.available).toBe(true)
    await expect(adapter.listSpaces()).resolves.toEqual([SPACE])
    await expect(adapter.listPages('space-1', true)).resolves.toEqual([PAGE])
    await expect(adapter.getPage('space-1', 'page-1')).resolves.toEqual(PAGE)
    await expect(adapter.getPageRevision('space-1', 'page-1', 2)).resolves.toEqual(PAGE)
    await expect(adapter.search('space-1', '重启 策略', 5)).resolves.toEqual({ items: [], degraded: false })
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/agent/memory-spaces',
      '/api/agent/memory-spaces/space-1/pages?includeWithdrawn=1',
      '/api/agent/memory-spaces/space-1/pages/page-1',
      '/api/agent/memory-spaces/space-1/pages/page-1/revisions/2',
      '/api/agent/memory-spaces/space-1/search?q=%E9%87%8D%E5%90%AF%20%E7%AD%96%E7%95%A5&limit=5',
    ])
  })

  it('搜索内容为空或超 256 字节在发出前拒绝；修订非正整数在发出前拒绝', async () => {
    const fetchMock = stubAgentJsonFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentMemoryAdapter()
    await expect(adapter.search('space-1', '   ')).rejects.toThrow('Wiki 搜索内容不能为空或超过 256 字节')
    await expect(adapter.search('space-1', '检查'.repeat(200))).rejects.toThrow('Wiki 搜索内容不能为空或超过 256 字节')
    await expect(adapter.getPageRevision('space-1', 'page-1', 0)).rejects.toThrow('Wiki 修订必须是正整数')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('撤回的 expectedRevision 在 JSON body、绝不在查询参数；PUT 的 expectedRevision 在 Input 体内', async () => {
    const { fetchMock, requests } = makeFakeMemoryServer()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentMemoryAdapter()
    await adapter.withdrawPage('space-1', 'page-b', 1)
    await adapter.updatePage('space-1', 'page-b', { slug: 'reference/port-map', title: '端口映射约定', markdown: '# x', kind: 'reference', expectedRevision: 2 })
    const withdraw = requests.find((row) => row.method === 'DELETE')
    expect(withdraw).toBeDefined()
    expect(withdraw?.url).not.toContain('?')
    expect(withdraw?.url).toBe('/api/agent/memory-spaces/space-1/pages/page-b')
    expect(JSON.parse(withdraw?.body ?? '{}')).toEqual({ expectedRevision: 1 })
    const update = requests.find((row) => row.method === 'PUT')
    expect(JSON.parse(update?.body ?? '{}')).toMatchObject({ expectedRevision: 2, slug: 'reference/port-map' })
  })

  it('无 requestId 字段的写端点：请求体绝不含 requestId', async () => {
    const { fetchMock, requests } = makeFakeMemoryServer()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentMemoryAdapter()
    await adapter.createSpace({ name: '接线空间', kind: 'business' })
    await adapter.renameSpace('space-1', 1, '改名')
    await adapter.createPage('space-1', { slug: 'wiring/create', title: '接线建页', markdown: '# 接线', kind: 'reference' })
    await adapter.withdrawPage('space-1', 'page-d', 1)
    await adapter.decideProposal('prop-1', { decision: 'approved' })
    await adapter.importPages('space-1', { 'notes/wiring.md': '# 接线导入' })
    await adapter.createEmbeddingProfile({ name: '接线向量', baseUrl: 'https://embedding.example.test/v1', model: 'm', dimensions: 8, active: false })
    await adapter.updateEmbeddingProfile('emb-1', { expectedRevision: 2, name: '通用文本向量', baseUrl: 'https://embedding.example.test/v1', model: 'text-embed-demo', dimensions: 1536, active: true })
    const writeBodies = requests.filter((row) => row.method !== 'GET').map((row) => JSON.parse(row.body === '' ? '{}' : row.body))
    for (const body of writeBodies) {
      expect(Object.hasOwn(body, 'requestId')).toBe(false)
    }
  })

  it('白名单端点：提炼创建与索引重建的 requestId 进请求体；列表查询串逐项编码', async () => {
    const { fetchMock, requests } = makeFakeMemoryServer()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentMemoryAdapter()
    await adapter.createExtraction({ requestId: 'wiring-ext-1', runId: 'run-seed-1' })
    await adapter.rebuildIndex('space-1', { requestId: 'wiring-index-1', profileId: 'emb-1', profileRevision: 2 })
    await adapter.listProposals({ spaceId: 'space-1', status: 'pending' })
    await adapter.listExtractions({ cursor: '3', limit: 10 })
    const extraction = requests.find((row) => row.url.endsWith('/memory-extractions') && row.method === 'POST')
    expect(JSON.parse(extraction?.body ?? '{}')).toEqual({ requestId: 'wiring-ext-1', runId: 'run-seed-1' })
    const index = requests.find((row) => row.url.endsWith('/indexes') && row.method === 'POST')
    expect(JSON.parse(index?.body ?? '{}')).toEqual({ requestId: 'wiring-index-1', profileId: 'emb-1', profileRevision: 2 })
    expect(requests.some((row) => row.url.includes('/memory-proposals?spaceId=space-1&status=pending'))).toBe(true)
    expect(requests.some((row) => row.url.includes('/memory-extractions?cursor=3&limit=10'))).toBe(true)
  })

  it('服务端错误体透传中文 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorBody(409, 'wiki-global-exists', '全局 Wiki 空间已存在')))
    const adapter = createHttpAgentMemoryAdapter()
    await expect(adapter.createSpace({ name: '全局', kind: 'global' })).rejects.toThrow('全局 Wiki 空间已存在')
  })
})

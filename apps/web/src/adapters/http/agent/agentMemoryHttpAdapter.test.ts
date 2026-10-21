import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpAgentMemoryAdapter, parseMemoryPage } from './agentMemoryHttpAdapter'
import { AgentMemoryMockAdapter } from '../../mock/agent/agentMemoryMockAdapter'
import { ModelSettingsMockAdapter } from '../../mock/agent/modelSettingsMockAdapter'

const server = () => new AgentMemoryMockAdapter(new ModelSettingsMockAdapter())
afterEach(() => vi.unstubAllGlobals())
describe('Wiki HTTP 接缝', () => {
  it('固定来源严格核验页面、修订与摘要', async () => {
    const mock = server(), page = await mock.createPage('wiki-global', { slug: 'hello', title: 'Hello', markdown: '# Source' })
    const fetch = vi.fn(async (_url: string) => Response.json(page)); vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentMemoryAdapter()
    await expect(adapter.getReference({ pageId: page.id, revision: page.revision, digest: page.digest })).resolves.toEqual(page)
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/agent/memory-pages/${page.id}/revisions/1`)
    await expect(adapter.getReference({ pageId: page.id, revision: page.revision, digest: 'changed' })).rejects.toThrow('不匹配')
    await expect(adapter.getRevision('another-space', page.id, page.revision)).rejects.toThrow('不匹配')
  })
  it('正式端点保留并发修订、导入幂等编号和会话选择', async () => {
    const mock = server(), page = await mock.createPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'old' })
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/memory-space')) return Response.json({ spaceId: 'business', includeGlobal: true })
      return Response.json({ ...page, ...JSON.parse(String(init?.body)), revision: 2 })
    }); vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentMemoryAdapter()
    await adapter.updatePage('wiki-global', page.id, { slug: page.slug, title: page.title, markdown: 'new', expectedRevision: 1, maintenance: 'manual' })
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/agent/memory-spaces/wiki-global/pages/${page.id}`)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedRevision: 1, maintenance: 'manual' })
    await adapter.setSelection('session/a', { spaceId: 'business', includeGlobal: true })
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/agent/sessions/session%2Fa/memory-space')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ spaceId: 'business', includeGlobal: true })
  })
  it('旧页面缺少维护标记时按人工维护读取，未知状态拒收', async () => {
    const mock = server(), page = await mock.createPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'old' })
    expect(parseMemoryPage({ ...page, maintenance: undefined }).maintenance).toBe('manual')
    expect(() => parseMemoryPage({ ...page, status: 'unknown' })).toThrow()
    expect(() => parseMemoryPage({ ...page, sources: [{ pageId: 'p', revision: -1, digest: 'x' }] })).toThrow()
  })
  it('真实新页候选的零基准修订和空来源切片可读取并保留原因', async () => {
    // Go WikiPageInput 会序列化 expectedRevision: 0，nil 来源切片为 null。
    const proposal = { id: 'candidate-new', spaceId: 'business', status: 'pending', reason: 'semantic-conflict', originKind: 'extraction', originId: 'job-1', createdAt: '2026-10-20T00:00:00Z', page: { maintenance: 'manual', expectedRevision: 0, slug: 'runbooks/nginx', title: 'Nginx 运维', markdown: '待确认正文', kind: 'runbook', evidence: [], sources: null } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([proposal])))
    const adapter = createHttpAgentMemoryAdapter()
    await expect(adapter.listProposals('business')).resolves.toMatchObject([{ reason: 'semantic-conflict', page: { expectedRevision: 0, sources: [] } }])
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ ...proposal, page: { ...proposal.page, expectedRevision: -1 } }])))
    await expect(adapter.listProposals('business')).rejects.toThrow('修订')
  })
  it('确认固定当前页面并提交管理员所见修订，校验决定回执', async () => {
    const mock = server(), page = await mock.createPage('wiki-global', { slug: 'guide', title: '当前页', markdown: '当前正文' })
    const proposal = { id: 'candidate-update', spaceId: 'wiki-global', pageId: page.id, status: 'pending', reason: 'revision-conflict', originKind: 'extraction', originId: 'job-1', createdAt: page.createdAt, currentPage: page, page: { expectedRevision: 0, slug: page.slug, title: '建议标题', markdown: '建议正文', kind: 'reference', evidence: [], sources: [] } }
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { ...proposal, status: 'approved', currentPage: undefined } : [proposal]))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentMemoryAdapter()
    expect((await adapter.listProposals('wiki-global'))[0]?.currentPage).toEqual(page)
    await expect(adapter.decideProposal(proposal.id, 'approved', page.revision)).resolves.toMatchObject({ id: proposal.id, status: 'approved' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ decision: 'approved', expectedRevision: page.revision })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...proposal, id: 'another-candidate', status: 'approved', currentPage: undefined })))
    await expect(adapter.decideProposal(proposal.id, 'approved', page.revision)).rejects.toThrow('回执不匹配')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...proposal, status: 'pending', currentPage: undefined })))
    await expect(adapter.decideProposal(proposal.id, 'approved', page.revision)).rejects.toThrow('回执不匹配')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ ...proposal, currentPage: { ...page, spaceId: 'another-space' } }])))
    await expect(adapter.listProposals('wiki-global')).rejects.toThrow('当前页面不匹配')
  })
})

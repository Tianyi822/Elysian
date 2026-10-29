import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpAgentMemoryAdapter, parseMemoryPage } from './agentMemoryHttpAdapter'
import { AgentMemoryMockAdapter } from '../../mock/agent/agentMemoryMockAdapter'

const server = () => new AgentMemoryMockAdapter()
afterEach(() => vi.unstubAllGlobals())
describe('Wiki HTTP 接缝', () => {
  it('固定来源严格核验页面、修订与摘要', async () => {
    const mock = server(), page = await mock.seedPage('wiki-global', { slug: 'hello', title: 'Hello', markdown: '# Source' })
    const fetch = vi.fn(async (_url: string) => Response.json(page)); vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentMemoryAdapter()
    await expect(adapter.getReference({ pageId: page.id, revision: page.revision, digest: page.digest })).resolves.toEqual(page)
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/agent/memory-pages/${page.id}/revisions/1`)
    await expect(adapter.getReference({ pageId: page.id, revision: page.revision, digest: 'changed' })).rejects.toThrow('不匹配')
    await expect(adapter.getRevision('another-space', page.id, page.revision)).rejects.toThrow('不匹配')
  })
  it('正式端点保留人工编辑并发修订', async () => {
    const mock = server(), page = await mock.seedPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'old' })
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/memory-space')) return Response.json({ spaceId: 'business', includeGlobal: true })
      return Response.json({ ...page, ...JSON.parse(String(init?.body)), revision: 2 })
    }); vi.stubGlobal('fetch', fetch)
    const adapter = createHttpAgentMemoryAdapter()
    await adapter.updatePage('wiki-global', page.id, { slug: page.slug, title: page.title, markdown: 'new', expectedRevision: 1, maintenance: 'manual' })
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/agent/memory-spaces/wiki-global/pages/${page.id}`)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedRevision: 1, maintenance: 'manual' })
  })
  it('旧页面缺少维护标记时按人工维护读取，未知状态拒收', async () => {
    const mock = server(), page = await mock.seedPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'old' })
    expect(parseMemoryPage({ ...page, maintenance: undefined }).maintenance).toBe('manual')
    expect(() => parseMemoryPage({ ...page, status: 'unknown' })).toThrow()
    expect(() => parseMemoryPage({ ...page, sources: [{ pageId: 'p', revision: -1, digest: 'x' }] })).toThrow()
  })


})

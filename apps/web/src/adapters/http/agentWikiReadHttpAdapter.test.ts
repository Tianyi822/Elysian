import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../../packages/foundation/contracts/fixtures/agent-memory-resources.json'
import {
  createHttpAgentWikiReadAdapter,
  parseWikiPage,
  parseWikiPages,
  parseWikiSearchResult,
  parseWikiSpaces,
} from './agentWikiReadHttpAdapter'
import { setUnauthorizedListener } from './unauthorized'

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedListener(() => {})
})

describe('Agent Wiki 只读 HTTP adapter', () => {
  it('逐一读取空间、页面、详情、精确修订和搜索；参数编码且禁用缓存', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/search?q=%E5%AE%B9%E5%99%A8+A%26B&limit=3')) return response(fixture.search)
      if (url.endsWith('/revisions/2')) return response(fixture.page)
      if (url.endsWith('/pages/page%3Fone')) return response(fixture.page)
      if (url.endsWith('/pages?includeWithdrawn=1')) return response([fixture.page])
      if (url.endsWith('/memory-spaces')) return response([fixture.space])
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWikiReadAdapter()

    expect(adapter.available).toBe(true)
    expect(await adapter.listSpaces()).toEqual([fixture.space])
    expect(await adapter.listPages('space/one', true)).toEqual([fixture.page])
    expect(await adapter.getPage('space/one', 'page?one')).toEqual(fixture.page)
    expect(await adapter.getPageRevision('space/one', 'page?one', 2)).toEqual(fixture.page)
    expect(await adapter.search('space/one', '容器 A&B', 3)).toEqual(fixture.search)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/agent/memory-spaces',
      '/api/agent/memory-spaces/space%2Fone/pages?includeWithdrawn=1',
      '/api/agent/memory-spaces/space%2Fone/pages/page%3Fone',
      '/api/agent/memory-spaces/space%2Fone/pages/page%3Fone/revisions/2',
      '/api/agent/memory-spaces/space%2Fone/search?q=%E5%AE%B9%E5%99%A8+A%26B&limit=3',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual({ cache: 'no-store', signal: expect.any(AbortSignal) })
    }
  })

  it('可按默认参数读取页面列表和搜索，传递取消信号', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.includes('/search')
      ? response({ items: [], degraded: false }) : response([]))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWikiReadAdapter()
    const controller = new AbortController()
    expect(await adapter.listPages('space-one', false, controller.signal)).toEqual([])
    expect(await adapter.search('space-one', 'check')).toEqual({ items: [], degraded: false })
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/agent/memory-spaces/space-one/pages',
      '/api/agent/memory-spaces/space-one/search?q=check&limit=8',
    ])
  })

  it('401 通知共享会话失效处理，其他错误保留安全的服务端文案', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: '会话已失效' }, 401)))
    await expect(createHttpAgentWikiReadAdapter().listSpaces()).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledOnce()

    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Wiki 空间不存在' }, 404)))
    await expect(createHttpAgentWikiReadAdapter().listPages('missing')).rejects.toThrow('Wiki 空间不存在')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('响应和输入无效时明确报错，不把错误体伪装成数据', async () => {
    expect(() => parseWikiSpaces({ error: 'oops' })).toThrow('Wiki 空间列表响应无效')
    expect(() => parseWikiSpaces([{ ...fixture.space, revision: '1' }])).toThrow('Wiki 空间响应无效')
    expect(() => parseWikiSpaces([{ ...fixture.space, kind: ['business'] }])).toThrow('Wiki 空间响应无效')
    expect(() => parseWikiPage({ ...fixture.page, sources: null })).toThrow('Wiki 页面响应无效')
    expect(() => parseWikiPages({ items: [] })).toThrow('Wiki 页面列表响应无效')
    expect(() => parseWikiSearchResult({ items: [{ page: fixture.page, score: 1, method: 'other' }], degraded: false })).toThrow('Wiki 搜索命中响应无效')
    const adapter = createHttpAgentWikiReadAdapter()
    await expect(adapter.getPageRevision('space', 'page', 0)).rejects.toThrow('Wiki 修订必须是正整数')
    await expect(adapter.search('space', ' ')).rejects.toThrow('Wiki 搜索内容不能为空')
    await expect(adapter.search('space', '容'.repeat(86))).rejects.toThrow('超过 256 字节')
    await expect(adapter.search('space', 'check', 201)).rejects.toThrow('Wiki 搜索条数必须是 1 到 200 的整数')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json')))
    await expect(adapter.listSpaces()).rejects.toThrow('Wiki 响应不是有效 JSON')
  })
})

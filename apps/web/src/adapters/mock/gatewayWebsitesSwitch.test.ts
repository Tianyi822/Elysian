import { describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { MockWebsitesAdapter } from './mockAdapters'

/*
 * gateway 的网站片分流断言：缺省与 'mock' 装内存演示实现，'http' 换成
 * 同源 /api/websites 的 HTTP adapter 且不影响既有各片。事件流固定 'memory'，
 * 不创建指向不存在端点的 EventSource。
 */

describe('createMockGateway 网站片分流', () => {
  it('缺省装配：网站片是内存演示实现', () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.websites).toBeInstanceOf(MockWebsitesAdapter)
  })

  it("显式 websites: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', websites: 'mock' })
    expect(gateway.websites).toBeInstanceOf(MockWebsitesAdapter)
  })

  it("websites: 'http' 只把网站片换成 HTTP adapter，文件管理片不受影响", () => {
    const gateway = createMockGateway({ eventStream: 'memory', websites: 'http' })
    expect(gateway.websites).not.toBeInstanceOf(MockWebsitesAdapter)
  })

  it("websites: 'http' 的列表请求落到同源 /api/websites 端点并解析报告", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projects: [],
            proxy: { state: 'active', detail: null },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', websites: 'http' })
    const report = await gateway.websites.list()
    expect(fetchMock).toHaveBeenCalledWith('/api/websites', { cache: 'no-store', signal: expect.any(AbortSignal) })
    expect(report).toEqual({ projects: [], proxy: { state: 'active', detail: null } })
    vi.unstubAllGlobals()
  })
})

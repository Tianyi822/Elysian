import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'

afterEach(() => vi.unstubAllGlobals())

describe('Gateway Agent Wiki 只读接线', () => {
  it('演示模式明确为空，不会虚构 Wiki 详情', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.wiki.available).toBe(false)
    expect(await gateway.wiki.listSpaces()).toEqual([])
    expect(await gateway.wiki.listPages('space')).toEqual([])
    expect(await gateway.wiki.search('space', 'check')).toEqual({
      items: [], degraded: true, reason: '演示模式暂无 Wiki 数据',
    })
    await expect(gateway.wiki.getPage('space', 'page')).rejects.toThrow('演示模式暂无 Wiki 数据')
    await expect(gateway.wiki.getPageRevision('space', 'page', 1)).rejects.toThrow('演示模式暂无 Wiki 数据')
  })

  it('显式 HTTP 接线请求同源 Agent API', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', wiki: 'http' })
    expect(gateway.wiki.available).toBe(true)
    expect(await gateway.wiki.listSpaces()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/memory-spaces', {
      cache: 'no-store', signal: expect.any(AbortSignal),
    })
  })
})

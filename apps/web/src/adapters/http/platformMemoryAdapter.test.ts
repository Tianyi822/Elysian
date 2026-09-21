import { describe, expect, it, vi } from 'vitest'
import { fetchPlatformMemory } from './platformMemoryAdapter'

describe('fetchPlatformMemory', () => {
  it('把合法 JSON 读成采样', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ rssMb: 80, heapUsedMb: 40, heapTotalMb: 50 }))),
    )
    await expect(fetchPlatformMemory()).resolves.toEqual({
      rssMb: 80,
      heapUsedMb: 40,
      heapTotalMb: 50,
    })
    vi.unstubAllGlobals()
  })

  it('网络失败抛中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await expect(fetchPlatformMemory()).rejects.toThrow('平台内存采集失败')
    vi.unstubAllGlobals()
  })

  it('非 2xx 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(fetchPlatformMemory()).rejects.toThrow('平台内存采集失败')
    vi.unstubAllGlobals()
  })
})

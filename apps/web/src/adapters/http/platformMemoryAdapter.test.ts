import { describe, expect, it, vi } from 'vitest'
import { fetchPlatformMemory } from './platformMemoryAdapter'
import { platformMemorySample } from '../../test/platformMemorySample'

describe('fetchPlatformMemory', () => {
  it('把合法 JSON 读成采样', async () => {
    const sample = platformMemorySample()
    const fetch = vi.fn(async () => new Response(JSON.stringify(sample)))
    vi.stubGlobal(
      'fetch',
      fetch,
    )
    const signal = new AbortController().signal
    await expect(fetchPlatformMemory('/api/platform/memory', signal)).resolves.toEqual(sample)
    expect(fetch).toHaveBeenCalledWith('/api/platform/memory', { cache: 'no-store', signal: expect.any(AbortSignal) })
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

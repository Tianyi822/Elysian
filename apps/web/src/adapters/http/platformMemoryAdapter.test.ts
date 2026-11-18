import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPlatformMemoryAdapter } from './platformMemoryAdapter'
import { advanceAuthGeneration, setUnauthorizedListener } from './unauthorized'
import { platformMemorySample } from '../../test/platformMemorySample'

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedListener(() => {})
})

describe('createHttpPlatformMemoryAdapter', () => {
  it('把合法 JSON 读成采样', async () => {
    const sample = platformMemorySample()
    const fetch = vi.fn(async () => new Response(JSON.stringify(sample)))
    vi.stubGlobal(
      'fetch',
      fetch,
    )
    const signal = new AbortController().signal
    await expect(createHttpPlatformMemoryAdapter().read(signal)).resolves.toEqual(sample)
    expect(fetch).toHaveBeenCalledWith('/api/platform/memory', { cache: 'no-store', signal: expect.any(AbortSignal) })
  })

  it('网络失败抛中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await expect(createHttpPlatformMemoryAdapter().read()).rejects.toThrow('平台内存采集失败')
  })

  it('非 2xx 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(createHttpPlatformMemoryAdapter().read()).rejects.toThrow('平台内存采集失败')
  })

  it('取消读取时中止传给 fetch 的信号', async () => {
    const fetch = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const pending = createHttpPlatformMemoryAdapter().read(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it.each([false, true])('仅当前会话代次上报 401（已换代：%s）', async (stale) => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    let respond!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
    const pending = createHttpPlatformMemoryAdapter().read()
    if (stale) advanceAuthGeneration()
    respond(new Response(null, { status: 401 }))
    await expect(pending).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(stale ? 0 : 1)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { withRequestDeadline } from './requestDeadline'
import { createHttpFirewallAdapter } from './firewallHttpAdapter'
import { createHttpSshAdapter } from './sshHttpAdapter'
import { createHttpUsersAdapter } from './usersHttpAdapter'
import { createHttpSessionAdapter } from './sessionHttpAdapter'
import { fetchPlatformMemory } from './platformMemoryAdapter'
import { setUnauthorizedListener } from './unauthorized'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setUnauthorizedListener(() => {}) })

describe('有界 JSON 请求接缝', () => {
  it.each(['连接', '响应体'] as const)('%s 卡住时在 15 秒结束并允许重试', async (phase) => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementationOnce(() => phase === '连接'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }))
      .mockResolvedValue(new Response(JSON.stringify({ users: [] })))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpUsersAdapter()
    const result = expect(api.list()).rejects.toThrow('读取超时')
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true)
    // 使用同一接缝重试，不保留失效的控制器。
    await expect(api.list()).resolves.toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    () => createHttpFirewallAdapter().list(),
    () => createHttpSshAdapter().overview(),
    () => createHttpUsersAdapter().list(),
    () => createHttpSessionAdapter().status(),
    () => fetchPlatformMemory(),
  ])('安全、会话及顶栏读取共用 15 秒时限', async (read) => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const result = expect(read()).rejects.toThrow('读取超时')
    await vi.advanceTimersByTimeAsync(15_000); await result
  })
  it('写请求 60 秒后提示未确认，不自动重放', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher)
    const result = expect(createHttpFirewallAdapter().syncFromSystem()).rejects.toThrow('操作结果尚未确认')
    await vi.advanceTimersByTimeAsync(59_999); expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); await result; expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('外部取消也终止响应体，不遗留时限', async () => {
    vi.useFakeTimers(); const abort = new AbortController()
    const result = expect(withRequestDeadline({ signal: abort.signal }, () => new Promise(() => {}))).rejects.toThrow('请求已取消')
    abort.abort(); await result; expect(vi.getTimerCount()).toBe(0)
  })
  it('401 及时上报会话失效，不等待可能卡住的错误响应体', async () => {
    const listener = vi.fn(); setUnauthorizedListener(listener)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: () => new Promise(() => {}) })))
    await expect(createHttpUsersAdapter().list()).rejects.toThrow('登录状态已失效')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

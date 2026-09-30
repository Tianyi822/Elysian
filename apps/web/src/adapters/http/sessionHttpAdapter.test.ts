import { afterEach, describe, expect, it, vi } from 'vitest'
import { setUnauthorizedListener } from './unauthorized'
import { createHttpSessionAdapter, parseSessionStatus } from './sessionHttpAdapter'

/*
 * 会话 HTTP adapter 的请求形状与错误解析：三个端点全部落到同源 /api/auth/*；
 * 登录失败透传服务端中文文案（401 是业务结果，不触发全局 401 监听——监听 spy 断言未被调）。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedListener(() => {})
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseSessionStatus', () => {
  it('合法响应还原 authenticated 与 devAccount，mode 固定为 real', () => {
    expect(parseSessionStatus({ authenticated: true, devAccount: false })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
    })
  })

  it('形状漂移（非对象、缺字段、类型错）抛中文错误', () => {
    expect(() => parseSessionStatus(null)).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: true })).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: 'yes', devAccount: false })).toThrow(
      '登录状态响应无效',
    )
  })
})

describe('createHttpSessionAdapter', () => {
  it('status 落到 GET /api/auth/session 并带 no-store', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ authenticated: false, devAccount: true }))
    vi.stubGlobal('fetch', fetchMock)
    const status = await createHttpSessionAdapter().status()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' })
    expect(status).toEqual({ mode: 'real', authenticated: false, devAccount: true })
  })

  it('canView 跟随 status 的 authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ authenticated: false, devAccount: false })),
    )
    await expect(createHttpSessionAdapter().canView('dashboard')).resolves.toBe(false)
  })

  it('login 落到 POST /api/auth/login，体为 JSON 的用户名与密码', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await createHttpSessionAdapter().login('admin', 'secret')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    })
  })

  it('login 的 401 透传服务端文案且不触发全局 401 监听', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: '用户名或密码错误' }, 401)),
    )
    await expect(createHttpSessionAdapter().login('admin', 'wrong')).rejects.toThrow(
      '用户名或密码错误',
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('login 的 429 透传限流文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: '登录尝试过于频繁，请稍后再试' }, 429)),
    )
    await expect(createHttpSessionAdapter().login('admin', 'x')).rejects.toThrow(
      '登录尝试过于频繁，请稍后再试',
    )
  })

  it('logout 落到 POST /api/auth/logout，非 2xx 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    await expect(createHttpSessionAdapter().logout()).resolves.toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'x' }, 503)))
    await expect(createHttpSessionAdapter().logout()).rejects.toThrow('退出登录失败：HTTP 503')
  })

  it('服务不可达时三个端点都抛中文错误（不裸抛 TypeError）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const adapter = createHttpSessionAdapter()
    await expect(adapter.status()).rejects.toThrow('登录状态检查失败：面板服务不可达')
    await expect(adapter.login('a', 'b')).rejects.toThrow('登录请求失败：面板服务不可达')
    await expect(adapter.logout()).rejects.toThrow('退出登录失败：面板服务不可达')
  })

  it('status 响应不是有效 JSON 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(createHttpSessionAdapter().status()).rejects.toThrow('登录状态响应不是有效 JSON')
  })
})

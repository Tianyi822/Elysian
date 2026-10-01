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

  it('服务端回答 returnTo 时原样保留；缺键时不含该字段', () => {
    expect(parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'http://127.0.0.1:5173/x' })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: 'http://127.0.0.1:5173/x',
    })
    expect(parseSessionStatus({ authenticated: true, devAccount: false, returnTo: null })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: null,
    })
    expect(parseSessionStatus({ authenticated: true, devAccount: false })).not.toHaveProperty('returnTo')
  })

  it('returnTo 形状漂移（数字、数组）抛「登录状态响应无效」', () => {
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 1 })).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: ['x'] })).toThrow('登录状态响应无效')
  })

  // 良构校验拦的是版本错配（新前端配旧容器）下的畸形值，不是重新裁决——只看能否解析为绝对 http/https URL。
  it('returnTo 是非 URL 字符串抛「登录状态响应无效」', () => {
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'not-a-url' })).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: '/projects/42' })).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: '//127.0.0.1:5173/x' })).toThrow('登录状态响应无效')
  })

  it('returnTo 是非 http/https 协议（javascript:、data:）抛「登录状态响应无效」', () => {
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'javascript:alert(1)' })).toThrow('登录状态响应无效')
    expect(() => parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'data:text/html,hi' })).toThrow('登录状态响应无效')
  })

  it('returnTo 是合法绝对 http/https URL 时原样通过（良构校验不改动值）', () => {
    expect(parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'http://127.0.0.1:5173/projects/42' })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: 'http://127.0.0.1:5173/projects/42',
    })
    expect(parseSessionStatus({ authenticated: true, devAccount: false, returnTo: 'https://localhost:48100/x' })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: 'https://localhost:48100/x',
    })
  })

  it('returnTo 为 null（被拦截）与缺键（未回答）仍是合法线格式，不被良构校验误伤', () => {
    expect(parseSessionStatus({ authenticated: true, devAccount: false, returnTo: null })).toEqual({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: null,
    })
    expect(parseSessionStatus({ authenticated: true, devAccount: false })).not.toHaveProperty('returnTo')
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

  it('status 带 returnTo 时以编码后的查询串请求，未带或空串时 URL 不含问号', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ authenticated: true, devAccount: false, returnTo: 'http://127.0.0.1:5173/x' }))
    vi.stubGlobal('fetch', fetchMock)
    const status = await createHttpSessionAdapter().status('http://127.0.0.1:5173/x')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fx', { cache: 'no-store' })
    expect(status.returnTo).toBe('http://127.0.0.1:5173/x')

    const plain = vi.fn(async () => jsonResponse({ authenticated: false, devAccount: false }))
    vi.stubGlobal('fetch', plain)
    await createHttpSessionAdapter().status()
    expect(plain).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' })

    const blank = vi.fn(async () => jsonResponse({ authenticated: false, devAccount: false }))
    vi.stubGlobal('fetch', blank)
    await createHttpSessionAdapter().status('')
    expect(blank).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' })
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

/*
 * 设置页三方法（listSessions / changePassword / logoutOtherSessions）：与既有三端点
 * 不同，它们的 401 是「登录后的管理端点会话失效」，须经共享 401 拦截上报——
 * 是接线差异的回归锚（login/logout/session 的 401 是业务结果，不经共享拦截）。
 */
describe('createHttpSessionAdapter 设置页三方法', () => {
  const changeInput = { currentPassword: 'old-password', newPassword: 'brand-new-password', confirmNewPassword: 'brand-new-password' }

  it('listSessions 落到 GET /api/auth/sessions 并带 no-store，逐行透传三字段', async () => {
    const rows = [{ createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-02T00:00:00.000Z', current: true }]
    const fetchMock = vi.fn(async () => jsonResponse({ sessions: rows }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpSessionAdapter().listSessions()).resolves.toEqual(rows)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sessions', { cache: 'no-store' })
  })

  it('changePassword 落到 POST /api/auth/password，体为三个口令字段；400 透传服务端中文文案', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpSessionAdapter().changePassword(changeInput)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changeInput),
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '当前密码不正确' }, 400)))
    await expect(createHttpSessionAdapter().changePassword(changeInput)).rejects.toThrow('当前密码不正确')
  })

  it('changePassword 的 400 无 error 字段时回落 HTTP 状态码文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 400)))
    await expect(createHttpSessionAdapter().changePassword(changeInput)).rejects.toThrow('修改密码失败：HTTP 400')
  })

  it('logoutOtherSessions 落到 POST /api/auth/sessions/logout-others（无体）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpSessionAdapter().logoutOtherSessions()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sessions/logout-others', { method: 'POST' })
  })

  it('三个新方法的 401 上报全局监听并抛「登录状态已失效，请重新登录」', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '未登录或会话已过期' }, 401)))
    const adapter = createHttpSessionAdapter()
    await expect(adapter.listSessions()).rejects.toThrow('登录状态已失效，请重新登录')
    await expect(adapter.changePassword(changeInput)).rejects.toThrow('登录状态已失效，请重新登录')
    await expect(adapter.logoutOtherSessions()).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('listSessions 响应形状漂移（外层缺 sessions、行缺字段、类型错）抛「会话列表响应无效」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ nope: [] })))
    await expect(createHttpSessionAdapter().listSessions()).rejects.toThrow('会话列表响应无效')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sessions: [{ createdAt: 'x', lastUsedAt: 'y' }] })))
    await expect(createHttpSessionAdapter().listSessions()).rejects.toThrow('会话列表响应无效')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sessions: [{ createdAt: 1, lastUsedAt: 'y', current: true }] })))
    await expect(createHttpSessionAdapter().listSessions()).rejects.toThrow('会话列表响应无效')
  })

  it('listSessions 响应不是有效 JSON 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(createHttpSessionAdapter().listSessions()).rejects.toThrow('会话列表响应不是有效 JSON')
  })

  it('三个新方法服务不可达都抛中文错误（不裸抛 TypeError）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const adapter = createHttpSessionAdapter()
    await expect(adapter.listSessions()).rejects.toThrow('会话列表获取失败：面板服务不可达')
    await expect(adapter.changePassword(changeInput)).rejects.toThrow('修改密码失败：面板服务不可达')
    await expect(adapter.logoutOtherSessions()).rejects.toThrow('退出其他会话失败：面板服务不可达')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSessionAdapterContract } from './sessionAdapterContract'
import { createHttpSessionAdapter } from './http/sessionHttpAdapter'
import { MockSessionAdapter } from './mock/mockAdapters'

/*
 * 契约断言集合的双实现复跑：mock（演示会话列表 + 真校验再如实失败）与 http（真实
 * /api/auth，fetch 升级为微型行为桩——按请求路径与体回应 200/400/列表两行）跑同一套
 * 断言。未来换真实 gateway 实现时对同一套断言再跑一次。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 微型行为桩：模拟「校验通过 200、两次不一致 400、长度不足 400、列表返回两行」的最小服务端行为。 */
async function stubAuthServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (method === 'GET' && url === '/api/auth/session') return json({ authenticated: true, devAccount: false })
  if (method === 'GET' && url === '/api/auth/sessions') {
    return json({
      sessions: [
        { createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-02T00:00:00.000Z', current: true },
        { createdAt: '2025-12-30T00:00:00.000Z', lastUsedAt: '2025-12-31T00:00:00.000Z', current: false },
      ],
    })
  }
  if (method === 'POST' && url === '/api/auth/login') return json({ ok: true })
  if (method === 'POST' && url === '/api/auth/logout') return json({ ok: true })
  if (method === 'POST' && url === '/api/auth/sessions/logout-others') return json({ ok: true })
  if (method === 'POST' && url === '/api/auth/password') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { newPassword?: string; confirmNewPassword?: string }
    if (body.newPassword !== body.confirmNewPassword) return json({ error: '两次输入的密码不一致' }, 400)
    if ((body.newPassword ?? '').length < 8) return json({ error: '密码至少需要 8 位' }, 400)
    return json({ ok: true })
  }
  return json({ error: `未知端点：${method} ${url}` }, 404)
}

describe('MockSessionAdapter', () => {
  runSessionAdapterContract(() => new MockSessionAdapter(), 'demo')

  it('实现特有行为：校验通过即如实抛「演示模式不支持修改面板密码」（不伪装成功）', async () => {
    await expect(
      new MockSessionAdapter().changePassword({
        currentPassword: 'whatever',
        newPassword: 'long-enough',
        confirmNewPassword: 'long-enough',
      }),
    ).rejects.toThrow('演示模式不支持修改面板密码')
  })

  it('实现特有行为：logoutOtherSessions 后 listSessions 只剩当前行', async () => {
    const adapter = new MockSessionAdapter()
    await adapter.logoutOtherSessions()
    const rows = await adapter.listSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.current).toBe(true)
  })
})

describe('createHttpSessionAdapter', () => {
  runSessionAdapterContract(() => {
    vi.stubGlobal('fetch', vi.fn(stubAuthServer))
    return createHttpSessionAdapter()
  }, 'real')
})

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { HostUser, UserAdapter } from '@elysian/contracts'
import { invalidRequest } from '../middleware/guard.ts'
import { USERS_MOUNT, createUsersApp, type UsersAppDeps } from './usersRoutes'

/*
 * 用户管理路由的行为测试：fake service 注入，app.request 驱动，不执行任何真实命令。
 * 守卫用例与防火墙/SSH 端点同源（跨源 403 先于读体、415、413 双拦、大小写归一放行）；
 * 断言集合与中文文案继承自端点时代的 api.test.ts，逐字保留。
 */

const SAMPLE_USER: HostUser = {
  id: 'ubuntu',
  name: 'ubuntu',
  isAdmin: true,
  loginMethod: 'password',
  status: 'active',
  note: 'Ubuntu User',
  createdAt: null,
}

function createFakeService(overrides: Partial<UserAdapter> = {}): UserAdapter {
  return {
    list: async () => [SAMPLE_USER],
    create: async (input) => ({ ...SAMPLE_USER, id: input.name, name: input.name, note: input.note }),
    update: async (userId, input) => ({ ...SAMPLE_USER, id: userId, name: userId, ...input, createdAt: null }),
    remove: async () => undefined,
    syncFromSystem: async () => ({ total: 1 }),
    ...overrides,
  }
}

const SAME_ORIGIN_HEADERS = {
  // 同源合法头：Origin 与 Host 一致；带体请求声明 JSON 与真实长度。
  host: 'localhost:5173',
  origin: 'http://localhost:5173',
}

/** 构造直连子应用的请求（守卫头齐全；带体时补 JSON 声明与真实长度）。 */
function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: {
      ...SAME_ORIGIN_HEADERS,
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

/** 构造原始体的请求：body 是未序列化的原文（守卫用例里故意给坏 JSON）。 */
function rawReq(method: string, path: string, payload: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: { ...SAME_ORIGIN_HEADERS, ...headers },
    body: payload,
  })
}

/** 挂到 strict:false 父应用的形态（app.ts 的真实挂载方式），锚定挂载后行为。 */
function mountedApp(deps: UsersAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.route(USERS_MOUNT, createUsersApp(deps))
  return parent
}

const AVAILABLE: UsersAppDeps = { available: true, service: createFakeService() }

describe('createUsersApp', () => {
  it('不可用时一律 503（容器边界保护，含未知路径）', async () => {
    const app = createUsersApp({ available: false })
    for (const [method, path] of [
      ['GET', '/'],
      ['POST', '/'],
      ['PUT', '/ubuntu'],
      ['DELETE', '/ubuntu'],
      ['POST', '/sync'],
      ['GET', '/nowhere'],
    ] as const) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', loginMethod: 'key', status: 'active', isAdmin: false, note: null }
      const res = await app.request(req(method, path, body))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
    }
  })

  it('GET / 返回账号列表；POST /sync 返回总数', async () => {
    const app = createUsersApp(AVAILABLE)
    const list = await app.request(req('GET', '/'))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ users: [SAMPLE_USER] })

    const sync = await app.request(req('POST', '/sync', {}))
    expect(await sync.json()).toEqual({ total: 1 })
  })

  it('POST / 透传创建输入（含密码字段）；PUT /:id 透传修改输入与解码后的 id', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      create: async (input) => {
        calls.push(['create', input])
        return SAMPLE_USER
      },
      update: async (userId, input) => {
        calls.push(['update', userId, input])
        return SAMPLE_USER
      },
    })
    const app = createUsersApp({ available: true, service })

    await app.request(req('POST', '/', { name: 'newops', loginMethod: 'password', status: 'active', isAdmin: true, note: '值班', password: 'Elysian#2026Strong' }))
    await app.request(
      req('PUT', `/${encodeURIComponent('ubuntu')}`, { loginMethod: 'key', status: 'disabled', isAdmin: false, note: null }),
    )

    expect(calls).toEqual([
      ['create', { name: 'newops', loginMethod: 'password', status: 'active', isAdmin: true, note: '值班', password: 'Elysian#2026Strong' }],
      ['update', 'ubuntu', { loginMethod: 'key', status: 'disabled', isAdmin: false, note: null }],
    ])
  })

  it('修改不携带 password 字段时透传的输入里也没有它', async () => {
    let seenInput: unknown
    const service = createFakeService({
      update: async (_userId, input) => {
        seenInput = input
        return SAMPLE_USER
      },
    })
    const app = createUsersApp({ available: true, service })
    await app.request(req('PUT', '/ubuntu', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }))
    expect(seenInput).not.toHaveProperty('password')
  })

  it('DELETE /:id 传递解码后的 id，响应 ok', async () => {
    const removed: string[] = []
    const service = createFakeService({
      remove: async (userId) => {
        removed.push(userId)
      },
    })
    const app = createUsersApp({ available: true, service })
    const res = await app.request(req('DELETE', '/ubuntu'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(removed).toEqual(['ubuntu'])
  })

  it('形状不对的请求体以中文错误返回 400', async () => {
    const app = createUsersApp(AVAILABLE)
    const noName = await app.request(req('POST', '/', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }))
    expect(noName.status).toBe(400)
    expect(((await noName.json()) as { error: string }).error).toBe('用户名请求体无效')

    const badMethod = await app.request(req('POST', '/', { name: 'x', loginMethod: '随便', status: 'active', isAdmin: false, note: null }))
    expect(((await badMethod.json()) as { error: string }).error).toBe('无效的登录方式：随便')

    const badStatus = await app.request(req('PUT', '/x', { loginMethod: 'key', status: '冻结', isAdmin: false, note: null }))
    expect(((await badStatus.json()) as { error: string }).error).toBe('无效的账号状态：冻结')

    const badAdmin = await app.request(req('PUT', '/x', { loginMethod: 'key', status: 'active', isAdmin: '是', note: null }))
    expect(((await badAdmin.json()) as { error: string }).error).toBe('管理员归属需为布尔值')

    const badNote = await app.request(req('PUT', '/x', { loginMethod: 'key', status: 'active', isAdmin: false, note: 42 }))
    expect(((await badNote.json()) as { error: string }).error).toBe('备注需为字符串或 null')

    const badPassword = await app.request(req('POST', '/', { name: 'x', loginMethod: 'password', status: 'active', isAdmin: false, note: null, password: 123 }))
    expect(((await badPassword.json()) as { error: string }).error).toBe('密码需为字符串')
  })

  it('请求被拒（校验不通过）按 400 返回，系统侧失败才是 500', async () => {
    const rejected = createUsersApp({
      available: true,
      service: createFakeService({
        update: async () => {
          throw invalidRequest('当前密码已锁定，请填写新密码后再启用密码登录')
        },
      }),
    })
    const rejectedResponse = await rejected.request(
      req('PUT', '/ubuntu', { loginMethod: 'password', status: 'active', isAdmin: false, note: null }),
    )
    expect(rejectedResponse.status).toBe(400)
    expect(await rejectedResponse.json()).toEqual({ error: '当前密码已锁定，请填写新密码后再启用密码登录' })

    const broken = createUsersApp({
      available: true,
      service: createFakeService({
        remove: async () => {
          throw new Error('删除未生效：系统里仍存在账号 ubuntu')
        },
      }),
    })
    const brokenResponse = await broken.request(req('DELETE', '/ubuntu'))
    expect(brokenResponse.status).toBe(500)
    expect(await brokenResponse.json()).toEqual({ error: '删除未生效：系统里仍存在账号 ubuntu' })
  })

  it('未知端点返回 404', async () => {
    const res = await createUsersApp(AVAILABLE).request(req('GET', '/nowhere'))
    expect(res.status).toBe(404)
  })

  it('跨源 PUT 在读体之前返回 403', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      update: async (userId, input) => {
        calls.push([userId, input])
        return SAMPLE_USER
      },
    })
    const app = createUsersApp({ available: true, service })
    // 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 500 的解析错误而非 403。
    const res = await app.request(
      rawReq('PUT', '/ubuntu', 'not-json', { origin: 'http://evil.example', 'content-type': 'application/json' }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
    expect(calls).toEqual([])
  })

  it('text/plain 的写请求返回 415', async () => {
    const app = createUsersApp(AVAILABLE)
    const res = await app.request(rawReq('PUT', '/ubuntu', '{}', { 'content-type': 'text/plain' }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('请求体超过 64 KiB 返回 413（申报与实读都拦）', async () => {
    const app = createUsersApp(AVAILABLE)

    // 申报即超限：不看流直接拒。
    const declared = new Request('http://localhost:5173/ubuntu', {
      method: 'PUT',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
    })
    const declaredRes = await app.request(declared)
    expect(declaredRes.status).toBe(413)

    // 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const lied = new Request('http://localhost:5173/ubuntu', {
      method: 'PUT',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        'content-type': 'application/json',
        'content-length': '2',
      },
      body: oversized,
    })
    const liedRes = await app.request(lied)
    expect(liedRes.status).toBe(413)
    expect(await liedRes.json()).toEqual({ error: '请求体过大' })
  })

  it('同源 application/json 写请求正常通过守卫；大小写归一放行', async () => {
    const app = createUsersApp(AVAILABLE)
    const res = await app.request(req('PUT', '/ubuntu', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }))
    expect(res.status).toBe(200)

    // 大小写归一：Host 大小写不同仍视为同源；带 charset 的 Content-Type 前缀匹配放行。
    const relaxed = await app.request(
      rawReq('PUT', '/ubuntu', '{"loginMethod":"key","status":"active","isAdmin":false,"note":null}', {
        host: 'LOCALHOST:5173',
        'content-type': 'application/json; charset=utf-8',
      }),
    )
    expect(relaxed.status).toBe(200)
  })
})

describe('挂载后行为（app.ts 以 strict:false 父应用挂到 USERS_MOUNT）', () => {
  it('根路径带/无尾斜杠双形式都命中列表端点（浏览器 adapter 两种请求形都有效）', async () => {
    const app = mountedApp(AVAILABLE)
    const noSlash = await app.request(req('GET', '/api/security/users'))
    expect(noSlash.status).toBe(200)
    expect(await noSlash.json()).toEqual({ users: [SAMPLE_USER] })

    const trailingSlash = await app.request(req('GET', '/api/security/users/'))
    expect(trailingSlash.status).toBe(200)
    expect(await trailingSlash.json()).toEqual({ users: [SAMPLE_USER] })
  })

  it('未知端点 404 文案剥掉挂载前缀：相对路径与端点时代逐字一致', async () => {
    const app = mountedApp(AVAILABLE)
    const res = await app.request(req('GET', '/api/security/users/nowhere'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知用户管理端点：GET /nowhere' })

    const deeper = await app.request(req('POST', '/api/security/users/nope/deeper', {}))
    expect(deeper.status).toBe(404)
    expect(await deeper.json()).toEqual({ error: '未知用户管理端点：POST /nope/deeper' })
  })

  it('路径参数完成 URL 解码后再交给 service（与端点时代的 decodeURIComponent 语义一致）', async () => {
    const updated: string[] = []
    const service = createFakeService({
      update: async (userId) => {
        updated.push(userId)
        return SAMPLE_USER
      },
    })
    const app = mountedApp({ available: true, service })
    const res = await app.request(
      req('PUT', '/api/security/users/%E8%BF%90%E7%BB%B4', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }),
    )
    expect(res.status).toBe(200)
    expect(updated).toEqual(['运维'])
  })

  it('不可用时挂载后同样整片 503，未知路径不漏成 404', async () => {
    const app = mountedApp({ available: false })
    const res = await app.request(req('GET', '/api/security/users/nowhere'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
  })
})

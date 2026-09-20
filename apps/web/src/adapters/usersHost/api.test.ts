import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { HostUser } from '@elysian/contracts'
import { createUsersApiHandler, type UsersApiDeps } from './api'
import type { UserAdapter } from '../../contracts/adapters'

/*
 * 用户管理端点 handler 的行为测试：fake service 不执行任何真实命令。
 * 守卫用例与防火墙/SSH 端点同源（跨源 403 先于读体、415、413 双拦、大小写归一放行）。
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

async function readResponse(handler: (req: IncomingMessage, res: ServerResponse) => void, req: IncomingMessage) {
  let statusCode = 0
  let body = ''
  const res = {
    writeHead(status: number) {
      statusCode = status
    },
    end(text?: string) {
      body = text ?? ''
    },
    setHeader() {},
  } as unknown as ServerResponse
  handler(req, res)
  // handler 内部异步：让微任务队列跑完再读响应。
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { statusCode, body: JSON.parse(body) as unknown }
}

async function fakeReq(method: string, url: string, body?: unknown): Promise<IncomingMessage> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  return Object.assign(stream, {
    method,
    url,
    headers: {
      // 同源合法头：Origin 与 Host 一致；带体请求声明 JSON 与真实长度。
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      ...(payload
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
    },
  }) as unknown as IncomingMessage
}

const AVAILABLE: UsersApiDeps = { available: true, service: createFakeService() }

describe('createUsersApiHandler', () => {
  it('不可用时一律 503（容器边界保护）', async () => {
    const handler = createUsersApiHandler({ available: false })
    for (const [method, url] of [
      ['GET', '/'],
      ['POST', '/'],
      ['PUT', '/ubuntu'],
      ['DELETE', '/ubuntu'],
      ['POST', '/sync'],
    ] as const) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', loginMethod: 'key', status: 'active', isAdmin: false, note: null }
      const { statusCode, body: responseBody } = await readResponse(handler, await fakeReq(method, url, body))
      expect(statusCode).toBe(503)
      expect(responseBody).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
    }
  })

  it('GET / 返回账号列表；POST /sync 返回总数', async () => {
    const handler = createUsersApiHandler(AVAILABLE)
    const list = await readResponse(handler, await fakeReq('GET', '/'))
    expect(list.statusCode).toBe(200)
    expect(list.body).toEqual({ users: [SAMPLE_USER] })

    const sync = await readResponse(handler, await fakeReq('POST', '/sync', {}))
    expect(sync.body).toEqual({ total: 1 })
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
    const handler = createUsersApiHandler({ available: true, service })

    await readResponse(
      handler,
      await fakeReq('POST', '/', { name: 'newops', loginMethod: 'password', status: 'active', isAdmin: true, note: '值班', password: 'Elysian#2026Strong' }),
    )
    await readResponse(
      handler,
      await fakeReq('PUT', `/${encodeURIComponent('ubuntu')}`, { loginMethod: 'key', status: 'disabled', isAdmin: false, note: null }),
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
    const handler = createUsersApiHandler({ available: true, service })
    await readResponse(handler, await fakeReq('PUT', '/ubuntu', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }))
    expect(seenInput).not.toHaveProperty('password')
  })

  it('DELETE /:id 传递解码后的 id，响应 ok', async () => {
    const removed: string[] = []
    const service = createFakeService({
      remove: async (userId) => {
        removed.push(userId)
      },
    })
    const handler = createUsersApiHandler({ available: true, service })
    const { statusCode, body } = await readResponse(handler, await fakeReq('DELETE', '/ubuntu'))
    expect(statusCode).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(removed).toEqual(['ubuntu'])
  })

  it('形状不对的请求体以中文错误返回 500', async () => {
    const handler = createUsersApiHandler(AVAILABLE)
    const noName = await readResponse(handler, await fakeReq('POST', '/', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }))
    expect(noName.statusCode).toBe(500)
    expect((noName.body as { error: string }).error).toBe('用户名请求体无效')

    const badMethod = await readResponse(handler, await fakeReq('POST', '/', { name: 'x', loginMethod: '随便', status: 'active', isAdmin: false, note: null }))
    expect((badMethod.body as { error: string }).error).toBe('无效的登录方式：随便')

    const badStatus = await readResponse(handler, await fakeReq('PUT', '/x', { loginMethod: 'key', status: '冻结', isAdmin: false, note: null }))
    expect((badStatus.body as { error: string }).error).toBe('无效的账号状态：冻结')

    const badAdmin = await readResponse(handler, await fakeReq('PUT', '/x', { loginMethod: 'key', status: 'active', isAdmin: '是', note: null }))
    expect((badAdmin.body as { error: string }).error).toBe('管理员归属需为布尔值')

    const badNote = await readResponse(handler, await fakeReq('PUT', '/x', { loginMethod: 'key', status: 'active', isAdmin: false, note: 42 }))
    expect((badNote.body as { error: string }).error).toBe('备注需为字符串或 null')

    const badPassword = await readResponse(handler, await fakeReq('POST', '/', { name: 'x', loginMethod: 'password', status: 'active', isAdmin: false, note: null, password: 123 }))
    expect((badPassword.body as { error: string }).error).toBe('密码需为字符串')
  })

  it('业务失败以中文错误返回 500', async () => {
    const service = createFakeService({
      update: async () => {
        throw new Error('当前密码已锁定，请填写新密码后再启用密码登录')
      },
    })
    const handler = createUsersApiHandler({ available: true, service })
    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('PUT', '/ubuntu', { loginMethod: 'password', status: 'active', isAdmin: false, note: null }),
    )
    expect(statusCode).toBe(500)
    expect(body).toEqual({ error: '当前密码已锁定，请填写新密码后再启用密码登录' })
  })

  it('未知端点返回 404', async () => {
    const { statusCode } = await readResponse(createUsersApiHandler(AVAILABLE), await fakeReq('GET', '/nowhere'))
    expect(statusCode).toBe(404)
  })

  it('跨源 PUT 在读体之前返回 403', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      update: async (userId, input) => {
        calls.push([userId, input])
        return SAMPLE_USER
      },
    })
    const handler = createUsersApiHandler({ available: true, service })
    // 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 500 的解析错误而非 403。
    const stream = Readable.from([Buffer.from('not-json', 'utf8')])
    const req = Object.assign(stream, {
      method: 'PUT',
      url: '/ubuntu',
      headers: { host: 'localhost:5173', origin: 'http://evil.example', 'content-type': 'application/json' },
    }) as unknown as IncomingMessage

    const { statusCode, body } = await readResponse(handler, req)
    expect(statusCode).toBe(403)
    expect(body).toEqual({ error: '请求来源不允许' })
    expect(calls).toEqual([])
  })

  it('text/plain 的写请求返回 415', async () => {
    const handler = createUsersApiHandler(AVAILABLE)
    const stream = Readable.from([Buffer.from('{}', 'utf8')])
    const req = Object.assign(stream, {
      method: 'PUT',
      url: '/ubuntu',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'text/plain' },
    }) as unknown as IncomingMessage

    const { statusCode, body } = await readResponse(handler, req)
    expect(statusCode).toBe(415)
    expect(body).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('请求体超过 64 KiB 返回 413（申报与实读都拦）', async () => {
    const handler = createUsersApiHandler(AVAILABLE)

    // 申报即超限：不看流直接拒。
    const declared = Object.assign(Readable.from([]), {
      method: 'PUT',
      url: '/ubuntu',
      headers: {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
    }) as unknown as IncomingMessage
    const declaredRes = await readResponse(handler, declared)
    expect(declaredRes.statusCode).toBe(413)

    // 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const lied = Object.assign(Readable.from([Buffer.from(oversized, 'utf8')]), {
      method: 'PUT',
      url: '/ubuntu',
      headers: {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'content-length': '2',
      },
    }) as unknown as IncomingMessage
    const liedRes = await readResponse(handler, lied)
    expect(liedRes.statusCode).toBe(413)
    expect(liedRes.body).toEqual({ error: '请求体过大' })
  })

  it('同源 application/json 写请求正常通过守卫；大小写归一放行', async () => {
    const handler = createUsersApiHandler(AVAILABLE)
    const { statusCode } = await readResponse(
      handler,
      await fakeReq('PUT', '/ubuntu', { loginMethod: 'key', status: 'active', isAdmin: false, note: null }),
    )
    expect(statusCode).toBe(200)

    // 大小写归一：Host 大小写不同仍视为同源；带 charset 的 Content-Type 前缀匹配放行。
    const stream = Readable.from([Buffer.from('{"loginMethod":"key","status":"active","isAdmin":false,"note":null}', 'utf8')])
    const req = Object.assign(stream, {
      method: 'PUT',
      url: '/ubuntu',
      headers: {
        host: 'LOCALHOST:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json; charset=utf-8',
      },
    }) as unknown as IncomingMessage
    const relaxed = await readResponse(handler, req)
    expect(relaxed.statusCode).toBe(200)
  })
})

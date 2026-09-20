import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Connect } from 'vite'
import { createSecurityUsersMiddleware, resolveUsersAvailability } from './api.node'
import type { UsersHostDeps } from './usersService'

/*
 * 容器硬边界的测试锚定：可用性的推导（ELSYIAN_DOCKER=1 且 /.dockerenv 存在）与
 * 中间件接线在这里钉住——改坏判定会让用例变红，而不是静默漏到宿主机执行
 * useradd/usermod/userdel/gpasswd/chpasswd 这类系统修改命令。
 * 全部用注入的环境与 fake deps 驱动，不依赖宿主机状态、不执行任何真实命令。
 */

/**
 * 只够 list() 读通的最小 fake：getent 走内存数据，任何写命令被调用即抛错。
 * 若硬边界被改坏，503 用例会变成 500 而立刻失败。
 */
function createListOnlyDeps(): UsersHostDeps {
  const fail = (name: string) => () => {
    throw new Error(`测试内不得执行真实命令：${name}`)
  }
  return {
    runGetent: async (args) => {
      if (args[0] === 'passwd') return 'ubuntu:x:1000:1000:Ubuntu User:/home/ubuntu:/bin/bash\n'
      if (args[0] === 'shadow') return 'ubuntu:$6$hash:20000:0:99999:7:::\n'
      if (args[0] === 'group' && args[1] === 'sudo') return 'sudo:x:27:ubuntu\n'
      throw new Error(`测试内不支持的 getent 调用：${args.join(' ')}`)
    },
    runUseradd: fail('useradd'),
    runUsermod: fail('usermod'),
    runUserdel: fail('userdel'),
    runGpasswd: fail('gpasswd'),
    runChpasswd: fail('chpasswd'),
    readText: fail('readText'),
    exists: async () => false,
    nowIso: () => '2026-09-20T12:00:00.000Z',
  }
}

async function readResponse(
  middleware: Connect.NextHandleFunction,
  req: IncomingMessage,
): Promise<{ statusCode: number; body: unknown }> {
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
  middleware(req, res, () => undefined)
  // 中间件内部异步：让微任务队列跑完再读响应。
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
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      ...(payload
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
    },
  }) as unknown as IncomingMessage
}

describe('resolveUsersAvailability', () => {
  it('两项条件同时满足才可用：环境声明 Docker 编排 + /.dockerenv 证明真的在容器内', () => {
    expect(resolveUsersAvailability({ ELSYIAN_DOCKER: '1' }, true)).toBe(true)
    expect(resolveUsersAvailability({ ELSYIAN_DOCKER: '1' }, false)).toBe(false)
    expect(resolveUsersAvailability({ ELSYIAN_DOCKER: '0' }, true)).toBe(false)
    expect(resolveUsersAvailability({}, true)).toBe(false)
  })
})

describe('createSecurityUsersMiddleware 硬边界', () => {
  it('环境未声明 Docker（即使 /.dockerenv 存在，如在容器里手动起 dev）：一律 503，不触达真实命令', async () => {
    const middleware = createSecurityUsersMiddleware({ env: {}, dockerenvExists: true, deps: createListOnlyDeps() })
    for (const [method, url] of [
      ['GET', '/'],
      ['POST', '/'],
      ['PUT', '/ubuntu'],
      ['DELETE', '/ubuntu'],
      ['POST', '/sync'],
    ] as const) {
      const body =
        method === 'POST' && url === '/'
          ? { name: 'x', loginMethod: 'key', status: 'active', isAdmin: false, note: null }
          : method === 'PUT'
            ? { loginMethod: 'key', status: 'active', isAdmin: false, note: null }
            : method === 'POST'
              ? {}
              : undefined
      const { statusCode, body: responseBody } = await readResponse(middleware, await fakeReq(method, url, body))
      expect(statusCode).toBe(503)
      expect(responseBody).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
    }
  })

  it('声明了 Docker 但进程不在容器内（/.dockerenv 缺失，宿主机 dev/preview）：一律 503', async () => {
    const middleware = createSecurityUsersMiddleware({
      env: { ELSYIAN_DOCKER: '1' },
      dockerenvExists: false,
      deps: createListOnlyDeps(),
    })
    const { statusCode, body } = await readResponse(middleware, await fakeReq('GET', '/'))
    expect(statusCode).toBe(503)
    expect(body).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
  })

  it('两项条件满足时挂真实 handler：请求经同源守卫到达 service（注入 fake deps，宿主机零副作用）', async () => {
    const middleware = createSecurityUsersMiddleware({
      env: { ELSYIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createListOnlyDeps(),
    })
    const { statusCode, body } = await readResponse(middleware, await fakeReq('GET', '/'))
    expect(statusCode).toBe(200)
    expect(body).toMatchObject({
      users: [{ id: 'ubuntu', name: 'ubuntu', isAdmin: true, loginMethod: 'password', createdAt: null }],
    })
  })
})

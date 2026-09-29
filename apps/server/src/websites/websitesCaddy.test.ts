import { describe, expect, it } from 'vitest'
import {
  caddyAdminListen,
  createWebsiteCaddy,
  resolveCaddySocketPath,
  CaddyChannelError,
  type CaddySocketRequest,
} from './websitesCaddy.ts'

/*
 * 注入 requestImpl 的 socket 客户端测试：不起真实 socket，断言请求形状与
 * 错误映射。连接类错误（ENOENT/EACCES/ECONNREFUSED）整体归类为 unavailable，
 * 中文 detail 统一为「宿主未提供 Caddy 管理通道」。
 */

function channel(handler: (input: CaddySocketRequest) => Promise<{ status: number; json: unknown }>) {
  const calls: CaddySocketRequest[] = []
  const caddy = createWebsiteCaddy({
    socketPath: '/run/caddy/admin.sock',
    requestImpl: async (input) => {
      calls.push(input)
      return handler(input)
    },
  })
  return { caddy, calls }
}

function connectionErrorOf(code: string): Error {
  const error = new Error(`connect ${code} /run/caddy/admin.sock`) as NodeJS.ErrnoException
  error.code = code
  return error
}

it('socket 路径解析：缺省 /run/caddy/admin.sock，ELYSIAN_CADDY_SOCKET 可覆盖，admin listen 同步', () => {
  expect(resolveCaddySocketPath({})).toBe('/run/caddy/admin.sock')
  expect(resolveCaddySocketPath({ ELYSIAN_CADDY_SOCKET: '/tmp/other.sock' })).toBe('/tmp/other.sock')
  expect(caddyAdminListen('/run/caddy/admin.sock')).toBe('unix//run/caddy/admin.sock')
  const caddy = createWebsiteCaddy({
    socketPath: '/run/caddy/admin.sock',
    requestImpl: async () => ({ status: 200, json: {} }),
  })
  expect(caddy.adminListen).toBe('unix//run/caddy/admin.sock')
})

describe('load（POST /load）', () => {
  it('以 application/json 整配置下发，路径与请求体形状正确', async () => {
    const { caddy, calls } = channel(async () => ({ status: 200, json: null }))
    await caddy.load({ admin: { listen: 'unix//run/caddy/admin.sock' } })
    expect(calls).toEqual([{ method: 'POST', path: '/load', body: { admin: { listen: 'unix//run/caddy/admin.sock' } } }])
  })

  it('非 2xx 抛引擎侧通道错误，消息取引擎 message、缺省回 HTTP 状态', async () => {
    const { caddy } = channel(async () => ({ status: 400, json: { message: 'invalid config' } }))
    await expect(caddy.load({})).rejects.toMatchObject({ unavailable: false, message: 'invalid config' })
    const bare = channel(async () => ({ status: 500, json: null }))
    await expect(bare.caddy.load({})).rejects.toMatchObject({ unavailable: false, message: 'HTTP 500' })
  })
})

describe('currentConfig（GET /config/）', () => {
  it('成功返回完整配置对象', async () => {
    const { caddy, calls } = channel(async () => ({ status: 200, json: { apps: {} } }))
    await expect(caddy.currentConfig()).resolves.toEqual({ apps: {} })
    expect(calls).toEqual([{ method: 'GET', path: '/config/' }])
  })

  it('连接类错误（ENOENT/EACCES/ECONNREFUSED）整体归类为 unavailable', async () => {
    for (const code of ['ENOENT', 'EACCES', 'ECONNREFUSED']) {
      const error = connectionErrorOf(code)
      const { caddy } = channel(async () => { throw error })
      await expect(caddy.currentConfig()).rejects.toBeInstanceOf(CaddyChannelError)
      await expect(caddy.currentConfig()).rejects.toMatchObject({ unavailable: true })
    }
  })

  it('非连接类错误不归类为 unavailable（消息保留原始原因）', async () => {
    const { caddy } = channel(async () => { throw new Error('Caddy 请求超时') })
    await expect(caddy.currentConfig()).rejects.toMatchObject({ unavailable: false, message: 'Caddy 请求超时' })
  })
})

describe('probe 状态探测', () => {
  it('成功映射 active，detail 为 null', async () => {
    const { caddy } = channel(async () => ({ status: 200, json: {} }))
    await expect(caddy.probe()).resolves.toEqual({ state: 'active', detail: null })
  })

  it('连接类失败映射 unavailable + 固定中文 detail', async () => {
    const error = connectionErrorOf('ENOENT')
    const { caddy } = channel(async () => { throw error })
    await expect(caddy.probe()).resolves.toEqual({ state: 'unavailable', detail: '宿主未提供 Caddy 管理通道' })
  })

  it('引擎侧失败映射 unavailable + 引擎消息', async () => {
    const { caddy } = channel(async () => ({ status: 500, json: { message: 'boom' } }))
    await expect(caddy.probe()).resolves.toEqual({ state: 'unavailable', detail: 'boom' })
  })
})

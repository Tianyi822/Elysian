import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  ALLOWED_HOSTNAMES,
  EndpointGuardError,
  endpointErrorHandler,
  isSameOrigin,
  readJsonBody,
  sameOriginGuard,
  sendError,
  sendJson,
} from './guard'

/*
 * 端点守卫的单元测试：函数级直接驱动守卫函数，中间件级用 Hono 的 app.request 驱动，
 * 不起真实监听，不经任何业务路由，不执行任何真实命令。防火墙、SSH 与用户管理端点
 * 复用同一模块，这里的断言集合就是三个端点共享的行为契约。
 */

/** 无副作用请求（GET/HEAD）或写请求的形状桩：Host 头必须显式给，Request 不会从 URL 推导。 */
function req(method: string, headers: Record<string, string>): Request {
  return new Request('http://localhost:5173/thing', { method, headers })
}

function bodyReq(method: string, headers: Record<string, string>, payload?: string): Request {
  return new Request('http://localhost:5173/thing', {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  })
}

/** 挂了同源守卫的最小应用：守卫通过后落到回显路由，失败即 403。 */
function guardApp() {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  app.use('*', sameOriginGuard())
  app.put('/thing', () => sendJson(200, { ok: true }))
  return app
}

const SAME_ORIGIN = { host: 'localhost:5173', origin: 'http://localhost:5173' }

describe('isSameOrigin', () => {
  it('GET/HEAD 无副作用不校验：缺 Origin 也放行', () => {
    expect(isSameOrigin(req('GET', { host: 'localhost:5173' }))).toBe(true)
    expect(isSameOrigin(req('HEAD', { host: 'localhost:5173' }))).toBe(true)
  })

  it('写请求跨源一律拒绝（Request 会把方法规范化为大写，小写写法由中间件链兜住）', async () => {
    const res = await guardApp().request('/thing', {
      method: 'PUT',
      headers: { host: 'localhost:5173', origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('写请求缺 Origin 或缺 Host 一律拒绝', () => {
    expect(isSameOrigin(req('PUT', { host: 'localhost:5173' }))).toBe(false)
    expect(isSameOrigin(req('PUT', { origin: 'http://localhost:5173' }))).toBe(false)
  })

  it('Origin host 与 Host 一致才放行，host 大小写归一', () => {
    expect(isSameOrigin(req('PUT', SAME_ORIGIN))).toBe(true)
    expect(isSameOrigin(req('PUT', { host: 'LOCALHOST:5173', origin: 'http://localhost:5173' }))).toBe(true)
    expect(isSameOrigin(req('PUT', { host: 'localhost:5173', origin: 'http://evil.example' }))).toBe(false)
  })

  it('Origin 不是合法 URL 视为不匹配', () => {
    expect(isSameOrigin(req('PUT', { host: 'localhost:5173', origin: 'not-a-url' }))).toBe(false)
  })

  it('Host 允许名单集中定义且只含本机地址', () => {
    expect(ALLOWED_HOSTNAMES).toEqual(['127.0.0.1', 'localhost', '[::1]'])
  })

  it('本机地址（含 IPv6 与大小写归一）的写请求放行', () => {
    expect(isSameOrigin(req('PUT', { host: 'localhost:5173', origin: 'http://localhost:5173' }))).toBe(true)
    expect(isSameOrigin(req('PUT', { host: 'LOCALHOST:5173', origin: 'http://LOCALHOST:5173' }))).toBe(true)
    expect(isSameOrigin(req('PUT', { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }))).toBe(true)
    expect(isSameOrigin(req('PUT', { host: '[::1]:5173', origin: 'http://[::1]:5173' }))).toBe(true)
  })

  it('Origin 与 Host 一致但不在允许名单：DNS rebinding 域名也拒绝', () => {
    // 攻击者让 rebinding 域名先后解析到本机与攻击机，Origin 与 Host 都是它自己也过不了名单。
    expect(isSameOrigin(req('PUT', { host: 'evil.example:5173', origin: 'http://evil.example:5173' }))).toBe(false)
    expect(isSameOrigin(req('PUT', { host: '127.0.0.1.evil.example', origin: 'http://127.0.0.1.evil.example' }))).toBe(false)
    expect(
      isSameOrigin(req('PUT', { host: 'localhost.evil.example:5173', origin: 'http://localhost.evil.example:5173' })),
    ).toBe(false)
  })

  it('Host 头畸形到解析不出 hostname 时拒绝', () => {
    expect(isSameOrigin(req('PUT', { host: 'http://localhost:5173', origin: 'http://localhost:5173' }))).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('Content-Type 非 application/json 抛 415 守卫错误', async () => {
    const request = bodyReq('POST', { ...SAME_ORIGIN, 'content-type': 'text/plain' }, '{}')
    await expect(readJsonBody(request)).rejects.toMatchObject({
      status: 415,
      message: 'Content-Type 必须为 application/json',
    })
  })

  it('带 charset 的 Content-Type 前缀匹配放行', async () => {
    const request = bodyReq('POST', { ...SAME_ORIGIN, 'content-type': 'application/json; charset=utf-8' }, '{"a":1}')
    await expect(readJsonBody(request)).resolves.toEqual({ a: 1 })
  })

  it('申报 content-length 超过 64 KiB 直接抛 413，不消费流', async () => {
    const request = bodyReq(
      'POST',
      { ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
      '{}',
    )
    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 413, message: '请求体过大' })
  })

  it('谎报 content-length 时实读累计字节数兜底抛 413', async () => {
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const request = bodyReq(
      'POST',
      { ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': '2' },
      oversized,
    )
    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 413, message: '请求体过大' })
  })

  it('空请求体抛中文错误', async () => {
    const request = bodyReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' })
    await expect(readJsonBody(request)).rejects.toThrow('请求体不能为空')
  })

  it('请求体不是有效 JSON 抛中文错误', async () => {
    const request = bodyReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' }, 'not-json')
    await expect(readJsonBody(request)).rejects.toThrow('请求体不是有效 JSON')
  })

  it('合法 JSON 解析为值', async () => {
    const request = bodyReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' }, '{"enabled":true}')
    await expect(readJsonBody(request)).resolves.toEqual({ enabled: true })
  })
})

describe('sameOriginGuard（中间件）', () => {
  it('同源写请求放行到路由，响应头与体由 sendJson 写出', async () => {
    const res = await guardApp().request('/thing', { method: 'PUT', headers: SAME_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('跨源写请求 403，中文文案原样', async () => {
    const res = await guardApp().request('/thing', {
      method: 'PUT',
      headers: { host: 'localhost:5173', origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })

  it('写请求缺 Origin 同样 403', async () => {
    const res = await guardApp().request('/thing', { method: 'PUT', headers: { host: 'localhost:5173' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })
})

describe('sendJson / sendError', () => {
  it('sendJson 写 JSON 头并序列化响应体', async () => {
    const res = sendJson(200, { ok: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('sendError 对 Error 取 message，对非 Error 走 String', async () => {
    const errRes = sendError(500, new Error('端口规则已存在：tcp 8080（ipv4）'))
    expect(await errRes.json()).toEqual({ error: '端口规则已存在：tcp 8080（ipv4）' })

    const rawRes = sendError(500, '裸字符串')
    expect(await rawRes.json()).toEqual({ error: '裸字符串' })
  })
})

describe('endpointErrorHandler', () => {
  it('带状态码的守卫/校验错误按自带 status 返回，其余一律 500', async () => {
    const app = new Hono()
    app.onError(endpointErrorHandler)
    app.get('/guard', () => {
      throw new EndpointGuardError(413, '请求体过大')
    })
    app.get('/system', () => {
      throw new Error('系统侧故障')
    })
    const guardRes = await app.request('/guard')
    expect(guardRes.status).toBe(413)
    expect(await guardRes.json()).toEqual({ error: '请求体过大' })
    const systemRes = await app.request('/system')
    expect(systemRes.status).toBe(500)
    expect(await systemRes.json()).toEqual({ error: '系统侧故障' })
  })
})

describe('EndpointGuardError', () => {
  it('是 Error 且保留状态码，供 handler 按判别映射响应', () => {
    const error = new EndpointGuardError(413, '请求体过大')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(EndpointGuardError)
    expect(error.status).toBe(413)
    expect(error.message).toBe('请求体过大')
  })
})

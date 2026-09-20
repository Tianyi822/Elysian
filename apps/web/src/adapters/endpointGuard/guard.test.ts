import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { EndpointGuardError, isSameOrigin, readJsonBody, sendError, sendJson } from './guard'

/*
 * 端点守卫的单元测试：直接驱动守卫函数，不经任何端点 handler，不执行任何真实命令。
 * 防火墙与 SSH 端点复用同一模块，这里的断言集合就是两个端点共享的行为契约。
 */

function fakeReq(method: string, headers: Record<string, string>, payload: string = ''): IncomingMessage {
  return Object.assign(Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []), {
    method,
    headers,
  }) as unknown as IncomingMessage
}

function fakeRes() {
  let statusCode = 0
  let headers: Record<string, string | string[]> = {}
  let body = ''
  const res = {
    writeHead(status: number, header?: Record<string, string>) {
      statusCode = status
      headers = header ?? {}
    },
    setHeader() {},
    end(text?: string) {
      body = text ?? ''
    },
  } as unknown as ServerResponse
  return {
    res,
    read: () => ({ statusCode, headers, body }),
  }
}

const SAME_ORIGIN = { host: 'localhost:5173', origin: 'http://localhost:5173' }

describe('isSameOrigin', () => {
  it('GET/HEAD 无副作用不校验：缺 Origin 也放行', () => {
    expect(isSameOrigin(fakeReq('GET', { host: 'localhost:5173' }))).toBe(true)
    expect(isSameOrigin(fakeReq('HEAD', { host: 'localhost:5173' }))).toBe(true)
  })

  it('方法大小写归一：小写 put 仍按写请求校验', () => {
    expect(isSameOrigin(fakeReq('put', { host: 'localhost:5173', origin: 'http://evil.example' }))).toBe(false)
  })

  it('写请求缺 Origin 或缺 Host 一律拒绝', () => {
    expect(isSameOrigin(fakeReq('PUT', { host: 'localhost:5173' }))).toBe(false)
    expect(isSameOrigin(fakeReq('PUT', { origin: 'http://localhost:5173' }))).toBe(false)
  })

  it('Origin host 与 Host 一致才放行，host 大小写归一', () => {
    expect(isSameOrigin(fakeReq('PUT', SAME_ORIGIN))).toBe(true)
    expect(isSameOrigin(fakeReq('PUT', { host: 'LOCALHOST:5173', origin: 'http://localhost:5173' }))).toBe(true)
    expect(isSameOrigin(fakeReq('PUT', { host: 'localhost:5173', origin: 'http://evil.example' }))).toBe(false)
  })

  it('Origin 不是合法 URL 视为不匹配', () => {
    expect(isSameOrigin(fakeReq('PUT', { host: 'localhost:5173', origin: 'not-a-url' }))).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('Content-Type 非 application/json 抛 415 守卫错误', async () => {
    const req = fakeReq('POST', { ...SAME_ORIGIN, 'content-type': 'text/plain' }, '{}')
    await expect(readJsonBody(req)).rejects.toMatchObject({
      status: 415,
      message: 'Content-Type 必须为 application/json',
    })
  })

  it('带 charset 的 Content-Type 前缀匹配放行', async () => {
    const req = fakeReq('POST', { ...SAME_ORIGIN, 'content-type': 'application/json; charset=utf-8' }, '{"a":1}')
    await expect(readJsonBody(req)).resolves.toEqual({ a: 1 })
  })

  it('申报 content-length 超过 64 KiB 直接抛 413，不消费流', async () => {
    const req = fakeReq(
      'POST',
      { ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
    )
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413, message: '请求体过大' })
  })

  it('谎报 content-length 时实读累计字节数兜底抛 413', async () => {
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const req = fakeReq(
      'POST',
      { ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': '2' },
      oversized,
    )
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413, message: '请求体过大' })
  })

  it('空请求体抛中文错误', async () => {
    const req = fakeReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' })
    await expect(readJsonBody(req)).rejects.toThrow('请求体不能为空')
  })

  it('请求体不是有效 JSON 抛中文错误', async () => {
    const req = fakeReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' }, 'not-json')
    await expect(readJsonBody(req)).rejects.toThrow('请求体不是有效 JSON')
  })

  it('合法 JSON 解析为值', async () => {
    const req = fakeReq('PUT', { ...SAME_ORIGIN, 'content-type': 'application/json' }, '{"enabled":true}')
    await expect(readJsonBody(req)).resolves.toEqual({ enabled: true })
  })
})

describe('sendJson / sendError', () => {
  it('sendJson 写 JSON 头并序列化响应体', () => {
    const { res, read } = fakeRes()
    sendJson(res, 200, { ok: true })
    expect(read().statusCode).toBe(200)
    expect(read().headers).toEqual({ 'content-type': 'application/json; charset=utf-8' })
    expect(JSON.parse(read().body)).toEqual({ ok: true })
  })

  it('sendError 对 Error 取 message，对非 Error 走 String', () => {
    const errRes = fakeRes()
    sendError(errRes.res, 500, new Error('端口规则已存在：tcp 8080（ipv4）'))
    expect(JSON.parse(errRes.read().body)).toEqual({ error: '端口规则已存在：tcp 8080（ipv4）' })

    const rawRes = fakeRes()
    sendError(rawRes.res, 500, '裸字符串')
    expect(JSON.parse(rawRes.read().body)).toEqual({ error: '裸字符串' })
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

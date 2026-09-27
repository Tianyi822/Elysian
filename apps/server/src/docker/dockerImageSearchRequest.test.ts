import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request: mockRequest }))

import {
  CATALOG_MAX_BYTES, CATALOG_TIMEOUT_MS, TAGS_MAX_BYTES,
  requestDockerHubToken, requestRegistryCatalog, requestRegistryTags,
} from './dockerImageSearch.ts'

type FakeResponse = EventEmitter & { statusCode: number }

function fakeHttps(statusCode: number, chunks: readonly Buffer[] = [], timeout = false) {
  mockRequest.mockImplementation((_url: URL, _options: unknown, onResponse: (response: FakeResponse) => void) => {
    const request = Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => {
          if (timeout) { request.emit('timeout'); return }
          const response = Object.assign(new EventEmitter(), { statusCode })
          onResponse(response)
          for (const chunk of chunks) response.emit('data', chunk)
          response.emit('end')
        })
      },
      destroy(error: Error) { request.emit('error', error) },
    })
    return request
  })
}

describe('自定义镜像源 HTTPS 请求边界', () => {
  const target = { host: 'mirror.example.com:5000', addresses: ['1.2.3.4'] }
  beforeEach(() => mockRequest.mockClear())

  it('只发送无凭证 GET，DNS 查询固定到校验 IP，重定向不跟随', async () => {
    fakeHttps(302)
    await expect(requestRegistryCatalog(target, '/v2/_catalog?n=100')).resolves.toEqual({ status: 302, json: null })
    expect(mockRequest).toHaveBeenCalledTimes(1)
    const [url, options] = mockRequest.mock.calls[0]! as [URL, { method: string; headers: Record<string, string>; timeout: number; lookup: (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void }]
    expect(url.href).toBe('https://mirror.example.com:5000/v2/_catalog?n=100')
    expect(options).toMatchObject({ method: 'GET', headers: { accept: 'application/json' }, timeout: CATALOG_TIMEOUT_MS })
    expect(options.headers).not.toHaveProperty('authorization')
    const lookupResult = vi.fn()
    options.lookup('mirror.example.com', { all: false }, lookupResult)
    expect(lookupResult).toHaveBeenCalledWith(null, '1.2.3.4', 4)
  })

  it('超时和超出响应大小上限时立即中断请求', async () => {
    fakeHttps(200, [], true)
    await expect(requestRegistryCatalog(target, '/v2/_catalog')).rejects.toThrow('镜像源目录查询超时')
    fakeHttps(200, [Buffer.alloc(CATALOG_MAX_BYTES + 1)])
    await expect(requestRegistryCatalog(target, '/v2/_catalog')).rejects.toThrow('镜像源目录响应超过大小上限')
  })

  it('标签请求只向目标 HTTPS 主机发送官方令牌，禁止重定向并限制响应大小', async () => {
    fakeHttps(302)
    await expect(requestRegistryTags(target, '/v2/library/redis/tags/list', 'public-token'))
      .resolves.toEqual({ status: 302, json: null })
    const [url, options] = mockRequest.mock.calls[0]! as [URL, { headers: Record<string, string>; lookup: (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void }]
    expect(url.href).toBe('https://mirror.example.com:5000/v2/library/redis/tags/list')
    expect(options.headers.authorization).toBe('Bearer public-token')
    const lookupResult = vi.fn()
    options.lookup('mirror.example.com', { all: false }, lookupResult)
    expect(lookupResult).toHaveBeenCalledWith(null, '1.2.3.4', 4)
    fakeHttps(200, [Buffer.alloc(TAGS_MAX_BYTES + 1)])
    await expect(requestRegistryTags(target, '/v2/library/redis/tags/list'))
      .rejects.toThrow('镜像源标签响应超过大小上限')
  })

  it('官方令牌只从固定 auth.docker.io 主机无凭证获取', async () => {
    fakeHttps(200, [Buffer.from(JSON.stringify({ token: 'public-token' }))])
    await expect(requestDockerHubToken('library/redis')).resolves.toBe('public-token')
    const [url, options] = mockRequest.mock.calls[0]! as [URL, { headers: Record<string, string> }]
    expect(url.href).toBe('https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fredis%3Apull')
    expect(options.headers).not.toHaveProperty('authorization')
  })
})

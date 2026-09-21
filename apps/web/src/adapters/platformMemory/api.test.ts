import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createPlatformMemoryHandler } from './api'

const MB = 1024 * 1024

function stub(method = 'GET', url = '/') {
  const req = { method, url, headers: {} } as unknown as IncomingMessage
  let statusCode = 0
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead(status: number, hdrs?: Record<string, string>) {
      statusCode = status
      Object.assign(headers, hdrs ?? {})
    },
    end(chunk?: string) {
      if (chunk !== undefined) body = chunk
    },
    setHeader(key: string, value: string) {
      headers[key] = value
    },
  } as unknown as ServerResponse
  return {
    req,
    res,
    get statusCode() {
      return statusCode
    },
    get headers() {
      return headers
    },
    getBody: () => body,
  }
}

describe('GET /api/platform/memory', () => {
  it('返回注入的进程内存，字节换成 MB', () => {
    const handler = createPlatformMemoryHandler(() => ({
      rss: 80 * MB,
      heapUsed: 40 * MB,
      heapTotal: 50 * MB,
    }))
    const http = stub()
    handler(http.req, http.res)

    expect(http.statusCode).toBe(200)
    expect(http.headers['content-type']).toContain('application/json')
    expect(JSON.parse(http.getBody())).toEqual({ rssMb: 80, heapUsedMb: 40, heapTotalMb: 50 })
  })

  it('非 GET 返回 405', () => {
    const handler = createPlatformMemoryHandler(() => ({ rss: 1, heapUsed: 1, heapTotal: 1 }))
    const http = stub('POST')
    handler(http.req, http.res)
    expect(http.statusCode).toBe(405)
    expect(JSON.parse(http.getBody())).toEqual({ error: '只允许 GET' })
  })
})

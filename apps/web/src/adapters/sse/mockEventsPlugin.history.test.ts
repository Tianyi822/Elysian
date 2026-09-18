import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { ResourceSamplePoint } from '../../contracts/adapters'
import { createResourceHistoryHandler, parseHistoryRangeParam } from './mockEventsPlugin'

function createHistoryStub(url: string) {
  const req = {
    method: 'GET',
    url,
    headers: {},
  } as unknown as IncomingMessage

  let statusCode = 200
  const headers: Record<string, string | number> = {}
  let body = ''

  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(code: number) {
      statusCode = code
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code
      Object.assign(headers, hdrs)
    },
    setHeader(key: string, value: string) {
      headers[key] = value
    },
    end(chunk?: string) {
      if (chunk !== undefined) body = chunk
    },
  } as unknown as ServerResponse

  return { req, res, headers, getBody: () => body }
}

describe('parseHistoryRangeParam', () => {
  it('接受 TIME_RANGES 内的取值', () => {
    expect(parseHistoryRangeParam('5m')).toBe('5m')
    expect(parseHistoryRangeParam('7d')).toBe('7d')
  })

  it('非法 range 返回 undefined', () => {
    expect(parseHistoryRangeParam('30d')).toBeUndefined()
    expect(parseHistoryRangeParam('')).toBeUndefined()
  })
})

describe('GET /api/resources/history 处理器', () => {
  it('非 GET 返回 405', () => {
    const handler = createResourceHistoryHandler({ docker: false, nowMs: () => 1_700_000_000_000 })
    const { req, res, getBody } = createHistoryStub('/api/resources/history?range=5m')
    ;(req as { method: string }).method = 'POST'
    handler(req, res)
    expect(res.statusCode).toBe(405)
    expect(getBody()).toBe('')
  })

  it('缺少或非法 range 返回 400', () => {
    const handler = createResourceHistoryHandler({ docker: false, nowMs: () => 1_700_000_000_000 })
    const bad = createHistoryStub('/api/resources/history?range=bad')
    handler(bad.req, bad.res)
    expect(bad.res.statusCode).toBe(400)
    expect(bad.getBody()).toContain('时间范围')
  })

  it('非 Docker 返回 mock 历史 JSON', () => {
    const nowMs = 1_700_000_000_000
    const handler = createResourceHistoryHandler({ docker: false, nowMs: () => nowMs })
    const { req, res, headers, getBody } = createHistoryStub('/api/resources/history?range=5m')
    handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(headers['content-type']).toContain('application/json')
    const parsed = JSON.parse(getBody()) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
  })

  it('Docker 模式从 store 查询', () => {
    const nowMs = 1_700_000_000_000
    const points: ResourceSamplePoint[] = [
      { ts: nowMs - 3_000, cpu: 5, memory: 6, networkIo: 7, diskIo: 8 },
    ]
    const handler = createResourceHistoryHandler({
      docker: true,
      store: {
        query: () => points,
      },
      nowMs: () => nowMs,
    })
    const { req, res, getBody } = createHistoryStub('/api/resources/history?range=5m')
    handler(req, res)
    const parsed = JSON.parse(getBody()) as { ts: number; cpu: number }[]
    expect(parsed.some((p) => p.cpu === 5)).toBe(true)
  })
})

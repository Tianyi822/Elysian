import { describe, expect, it } from 'vitest'
import { createPlatformMemoryApp } from './platformMemoryRoutes'

const MB = 1024 * 1024

/** 用注入的内存读数驱动路由，不依赖真实进程账，断言不随时间漂移。 */
function appWith(usage: { rss: number; heapUsed: number; heapTotal: number }) {
  return createPlatformMemoryApp(() => usage)
}

describe('GET /api/platform/memory', () => {
  it('返回注入的进程内存，字节换成 MB', async () => {
    const res = await appWith({ rss: 80 * MB, heapUsed: 40 * MB, heapTotal: 50 * MB }).request('/memory')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ rssMb: 80, heapUsedMb: 40, heapTotalMb: 50 })
  })

  it('非 GET 返回 405', async () => {
    const res = await appWith({ rss: 1, heapUsed: 1, heapTotal: 1 }).request('/memory', { method: 'POST' })
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: '只允许 GET' })
  })
})

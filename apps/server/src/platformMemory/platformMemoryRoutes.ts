import { Hono } from 'hono'
import { sampleFromUsage } from '@elysian/contracts'
import { sendJson } from '../middleware/guard.ts'

/** 注入面：与 process.memoryUsage 同形（多出的字段结构兼容，取用三项即可）。 */
export type ProcessMemoryUsage = {
  rss: number
  heapUsed: number
  heapTotal: number
}

/**
 * 平台内存路由：GET /api/platform/memory 回读当前 server 进程的 memoryUsage，
 * 换算成 MB。不依赖 Docker、不碰宿主机接口——本地与容器内都是这份真实进程账；
 * 无容器边界、无同源守卫，与 vite 端点时代的形状一致；非 GET 一律 405。
 */
export function createPlatformMemoryApp(readUsage: () => ProcessMemoryUsage = () => process.memoryUsage()): Hono {
  const app = new Hono()
  app.all('/memory', (c) => {
    if (c.req.method.toUpperCase() !== 'GET') {
      return sendJson(405, { error: '只允许 GET' })
    }
    return sendJson(200, sampleFromUsage(readUsage()))
  })
  return app
}

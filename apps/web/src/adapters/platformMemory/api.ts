import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../endpointGuard/guard'
import { sampleFromUsage } from './types'

export type ProcessMemoryUsage = {
  rss: number
  heapUsed: number
  heapTotal: number
}

/**
 * 平台内存端点：GET 回读当前 Node/Bun 进程的 memoryUsage，换算成 MB。
 * 不依赖 Docker、不碰宿主机接口——本地 bun run dev 与容器内都是这份真实进程账。
 */
export function createPlatformMemoryHandler(readUsage: () => ProcessMemoryUsage = () => process.memoryUsage()) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { error: '只允许 GET' })
      return
    }
    sendJson(res, 200, sampleFromUsage(readUsage()))
  }
}

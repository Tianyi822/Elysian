import { Hono } from 'hono'
import { endpointErrorHandler, sendJson } from '../middleware/guard.ts'
import { PLATFORM_MOUNT } from '../shared/apiMounts.ts'
import type { DependencyProber } from './dependencyProbe.ts'

/*
 * 依赖检测路由：GET /api/platform/dependencies 现场探测宿主 Docker 与 Caddy 通道
 * 并报事实（state 三值 ok/missing/error + 中文 detail）。落在 platform 域而非三域
 * 内：「Docker 缺失」这个事实恰恰要在 docker/database/websites 三域全 503 时仍拿得到。
 * 无容器边界、无同源守卫（GET 读端点豁免同源是既有设计）、无操作审计（采集中间件
 * 只记写请求）；探测纯读，不执行安装、不写任何系统文件。非 GET 一律 405，口径与
 * platformMemory 对齐。
 */

export type PlatformDependenciesAppDeps = DependencyProber

export function createPlatformDependenciesApp(deps: PlatformDependenciesAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  app.all('/dependencies', async (c) => {
    if (c.req.method.toUpperCase() !== 'GET') {
      return sendJson(405, { error: '只允许 GET' })
    }
    // 检测结果每次都要新事实，不吃任何缓存。
    c.header('Cache-Control', 'no-store')
    return c.json(await deps.probe())
  })
  return app
}

export { PLATFORM_MOUNT }

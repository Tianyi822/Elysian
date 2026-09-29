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
 * 探测有真实宿主成本（连两个 socket、拉 Caddy 全量配置），跨源页面虽读不到响应仍可
 * 高频驱动服务端探测，故 GET 按固定窗口限流（缺省每 60 秒 30 次，超限 429 带
 * Retry-After）；面板是单用户回环服务，正常使用（页面挂载的幂等 check + 手动重新
 * 检测）远低于该频率，不按来源区分。
 */

export type PlatformDependenciesAppDeps = DependencyProber & {
  /** 探测请求的固定窗口限额（次）；缺省 30。测试注入小值。 */
  probeRateLimit?: number
  /** 限额窗口时长（毫秒）；缺省 60_000。测试注入小值。 */
  rateWindowMs?: number
}

/** 缺省限额与窗口：探测单次成本受 3s/5s 超时约束，30 次/分钟已远超正常使用频率。 */
const DEFAULT_PROBE_RATE_LIMIT = 30
const DEFAULT_RATE_WINDOW_MS = 60_000

export function createPlatformDependenciesApp(deps: PlatformDependenciesAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  const limit = deps.probeRateLimit ?? DEFAULT_PROBE_RATE_LIMIT
  const windowMs = deps.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS
  // 限流状态在 app 实例闭包内：每个 createPlatformDependenciesApp 独立计数。
  let windowStartAt = Date.now()
  let served = 0
  app.all('/dependencies', async (c) => {
    if (c.req.method.toUpperCase() !== 'GET') {
      return sendJson(405, { error: '只允许 GET' })
    }
    const now = Date.now()
    if (now - windowStartAt >= windowMs) {
      windowStartAt = now
      served = 0
    }
    if (served >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStartAt + windowMs - now) / 1000))
      return new Response(JSON.stringify({ error: '依赖检测请求过于频繁，请稍后再试' }), {
        status: 429,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(retryAfterSeconds),
        },
      })
    }
    served += 1
    // 检测结果每次都要新事实，不吃任何缓存。
    c.header('Cache-Control', 'no-store')
    return c.json(await deps.probe())
  })
  return app
}

export { PLATFORM_MOUNT }

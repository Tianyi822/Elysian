import { Hono } from 'hono'
import { LOG_CLEARABLE_CATEGORIES, type PlatformLogCategory } from '@elysian/contracts'
import { endpointErrorHandler, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import type { LogsService } from './logsService.ts'

/*
 * 平台日志路由（/api/logs/*）：只做守卫链、路由分发与 service 透传。
 *
 * **本片没有容器边界**：它只读写 ~/.Elysian 下面板自有的目录，不执行系统命令、不碰系统
 * 文件、不需要 root 能力，因此宿主机本地开发与容器内是同一套实现，守卫链也**没有 503 段**
 * ——后来者不要照着防火墙/SSH/用户/文件四片抄一个 available 出来。
 *
 * 守卫链：同源 403「请求来源不允许」→ 读体 415/413/400（仅清空端点）→ 端点 → 404
 * 「未知日志端点：METHOD 相对路径」。错误映射统一走 endpointErrorHandler。
 *
 * 读端点显式声明 cache-control: no-store：面板语义是「每次刷新都要最新」，
 * 显式声明比依赖浏览器默认行为安全；写端点（清空）沿用 sendJson。
 *
 * 清空路由**由契约常量推导**而不是写死两条：把某个类别从 LOG_CLEARABLE_CATEGORIES
 * 里去掉，界面入口与服务端端点一起消失，不存在「按钮没了、端点还在」的错位。
 * 请求体里的 category 不参与路由决策（路径即类别），越界的类别名自然落到 404 兜底。
 */

/** 挂载路径：app.ts 用同一常量挂载，404 兜底与操作日志描述符表都用它——单一事实，三处不漂移。 */
export const LOGS_MOUNT = '/api/logs'

/** 路由装配入参：**无 available**（本片无容器边界，见文件头）。 */
export type LogsAppDeps = {
  service: LogsService
}

/** 读端点的 JSON 响应：在 sendJson 之上显式加 no-store（面板语义是每次刷新都要最新）。 */
function sendLogJson(status: number, body: unknown): Response {
  const response = sendJson(status, body)
  response.headers.set('cache-control', 'no-store')
  return response
}

/** 404 文案用的相对路径：子应用经 app.route 挂载后 c.req.path 是全路径，剥掉前缀逐字对齐。 */
function relativePath(fullPath: string): string {
  return (fullPath.startsWith(LOGS_MOUNT) ? fullPath.slice(LOGS_MOUNT.length) : fullPath) || '/'
}

/** 日志子应用工厂：app.ts 挂到 LOGS_MOUNT；测试直接 request 驱动，fake service 注入。 */
export function createLogsApp(deps: LogsAppDeps): Hono {
  const app = new Hono()
  // 错误映射：EndpointGuardError/InvalidRequestError 按自带 status 回 4xx，系统侧一律 500。
  app.onError(endpointErrorHandler)
  const service = deps.service

  // 同源守卫先于路由分发：跨源写请求在解析任何请求体之前就被拒绝（未知路径先 403 后 404）。
  app.use('*', sameOriginGuard())

  app.get('/runtime', async () => sendLogJson(200, await service.runtimeLog()))
  app.get('/operation', async () => sendLogJson(200, await service.operationLog()))

  // 清空是写端点：读体只为走同一套守卫链（同源、Content-Type、体积上限），
  // 请求体内容不参与任何决策（路径即类别）。
  for (const category of LOG_CLEARABLE_CATEGORIES) {
    const clearable: PlatformLogCategory = category
    app.post(`/${clearable}/clear`, async (c) => {
      await readJsonBody(c.req.raw)
      return sendJson(200, { cleared: await service.clear(clearable) })
    })
  }

  // 未知端点兜底：注册在具体路由之后，通配只在无具体匹配时命中；经 app.route 挂载后
  // 随路由表迁移（notFound 不会），404 文案与守卫链行为因此与独立挂载时一致。
  app.all('*', (c) => sendJson(404, { error: `未知日志端点：${c.req.method} ${relativePath(c.req.path)}` }))
  return app
}

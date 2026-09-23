import { Hono } from 'hono'
import { ALLOWED_HOSTNAMES, endpointErrorHandler, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { recordPanelOperation, type OperationAuditLogs } from '../logs/operationAudit.ts'
import { createTerminalWsEvents } from './terminalConnection.ts'
import type { TerminalsService } from './terminalsService.ts'

/*
 * 终端路由（/api/terminals/*）：只做守卫链与升级委托，会话编排全部在服务层。
 * 守卫链与既有四片同构：不可用整片 503「真实终端仅在 Docker 容器内可用」→
 * 同源 403「请求来源不允许」→ 端点 → 未知路径 404「未知终端端点：METHOD path」。
 *
 * 安全基线（WS 升级绕过同源守卫）的对策落在这里：Upgrade 是 GET，sameOriginGuard
 * 对 GET/HEAD 放行拦不到，因此 /ws 路由在调用 upgradeWebSocket **之前**以普通
 * handler 前置短路执行更严的同源校验（Origin 缺失即拒）。禁止把拒绝写进升级回调
 * 的 return——实测（容器内 hono@4.13.8）该 Response 会被 defineWebSocketHelper 当
 * 事件对象吞掉、连接照常升级打开（假满足）。前置短路同时让 503/403 成为普通路由
 * 响应，vitest 的 app.request 可直接断言。
 *
 * 打开会话是系统级操作，但 WS 升级不经写端点、采集中间件包不到，因此在同源校验通过
 * 之后、升级之前显式记一条操作日志（deps.logs 可选，不传即不记，既有测试零改动）。
 */

/** 挂载路径：app.ts 用同一常量挂载，404 兜底也用它剥前缀——单一事实，两处不漂移。 */
export const TERMINAL_MOUNT = '/api/terminals'

/** 路由装配入参：available=false 时整片 503；service 缺失同样 503（有可用性没服务也不许答）。 */
export type TerminalsAppDeps = {
  available: boolean
  service?: TerminalsService
  /**
   * 日志服务的显式调用口（可选）：终端会话不经 HTTP 写端点，采集中间件包不到它，
   * 因此在这里显式记一条。不传即跳过记录，终端片既有测试与既有行为不变。
   * 命令级别的记录**不做**：终端命令既不经 HTTP、也可能含敏感内容，留给治理期。
   */
  logs?: OperationAuditLogs
}

/**
 * WS 升级专用同源校验（比 REST 的 GET 放行更严）：必须带 Origin；Origin 的 host
 * （含端口，小写归一）与 Host 头一致；Host 的 hostname 落在回环允许名单内。
 */
function isSameOriginUpgrade(req: Request): boolean {
  const origin = req.headers.get('origin')
  const host = req.headers.get('host')
  if (!origin || !host) return false
  try {
    if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
  } catch {
    return false
  }
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase()
    return ALLOWED_HOSTNAMES.includes(hostname)
  } catch {
    return false
  }
}

/** 终端子应用工厂：app.ts 挂到 TERMINAL_MOUNT；测试直接 request 驱动（升级分支由 bun 冒烟覆盖）。 */
export function createTerminalsApp(deps: TerminalsAppDeps): Hono {
  const app = new Hono()
  // 错误映射：EndpointGuardError/InvalidRequestError 按自带 status 回 4xx，系统侧一律 500。
  app.onError(endpointErrorHandler)

  if (!deps.available || !deps.service) {
    // 不可用整片换 503 分支：任意方法、含未知路径，与容器外的强制保护一致。
    app.all('*', () => sendJson(503, { error: '真实终端仅在 Docker 容器内可用' }))
    return app
  }

  // 同源守卫先于路由分发：跨源写请求（含未知路径的写）先 403 后 404，与文件管理片同构。
  app.use('*', sameOriginGuard())

  // 辅助端点：浏览器 WebSocket 拿不到升级失败的 HTTP 状态与原因，客户端连接失败时
  // 请求它取回中文原因。无副作用 GET，走既有放行语义。
  app.get('/status', () => sendJson(200, { ok: true }))

  const wsEvents = createTerminalWsEvents(deps.service)

  app.get('/ws', async (c) => {
    // 前置校验必须在 upgradeWebSocket 之前短路返回普通 Response（见文件头注释）。
    if (!isSameOriginUpgrade(c.req.raw)) {
      return sendJson(403, { error: '请求来源不允许' })
    }
    // 会话是系统级操作，但它是 WS 升级（不经写端点、采集中间件包不到），因此在同源校验
    // 通过之后、升级之前显式记一条：打开本机终端会话。升级被 Bun 实例接走之后没有 HTTP
    // 响应可挂，记录必须发生在此之前。
    if (deps.logs) {
      await recordPanelOperation(deps.logs, {
        category: 'terminals',
        action: '打开本机终端会话',
        target: null,
        result: 'success',
        method: 'GET',
        path: `${TERMINAL_MOUNT}/ws`,
        httpStatus: 200,
      })
    }
    // hono/bun 的入口模块在加载期引用 Bun 全局（其 ssg.js 顶层代码），vitest 的 node
    // 运行时进不了它的模块图——合法升级路径才动态加载 bunWebSocket（ESM 模块缓存
    // 保证 createBunWebSocket 仍每进程恰好一次）。
    const { bunWebSocket } = await import('./bunWebSocket.ts')
    return bunWebSocket.upgradeWebSocket(c, wsEvents)
  })

  // 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与既有四片的文案格式逐字一致。
  app.all('*', (c) => {
    const path = c.req.path.slice(TERMINAL_MOUNT.length) || '/'
    return sendJson(404, { error: `未知终端端点：${c.req.method} ${path}` })
  })
  return app
}

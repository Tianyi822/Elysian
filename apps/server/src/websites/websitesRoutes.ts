import { Hono } from 'hono'
import { endpointErrorHandler, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import type { WebsiteService } from './websitesService.ts'
import { validateWebsiteAccessRequest, validateWebsiteCreateRequest, validateWebsiteUpdateRequest } from './websitesService.ts'
import type { OperationAuditLogs } from '../logs/operationAudit.ts'

/*
 * 网站管理片路由。守卫链对齐 database 片：available 为假整片 503 → sameOriginGuard
 * （跨源写 403）→ 各端点 readJsonBody（415/413/400 三拦）。删除是破坏性动作，必须
 * 带确认正文 DELETE_WEBSITE_AND_DATA，缺确认 400。GET 列表与日志保持只读无副作用。
 */

export type WebsitesAppDeps = { available: boolean; service?: WebsiteService; logs?: OperationAuditLogs }

export function createWebsitesApp(deps: WebsitesAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  if (!deps.available || !deps.service) {
    app.all('*', () => sendJson(503, { error: '真实网站管理仅在 Docker 环境可用' }))
    return app
  }
  const service = () => {
    if (!deps.service) throw new InvalidRequestError(503, '网站服务不可用')
    return deps.service
  }
  app.use('*', sameOriginGuard())
  app.get('/', async (c) => c.json(await service().list()))
  app.get('/runtimes', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await service().runtimeCatalog())
  })
  app.post('/', async (c) => c.json(await service().create(validateWebsiteCreateRequest(await readJsonBody(c.req.raw, 256 * 1024))), 201))
  app.put('/:id', async (c) => c.json(await service().update(c.req.param('id'), validateWebsiteUpdateRequest(await readJsonBody(c.req.raw)))))
  app.put('/:id/access', async (c) => c.json(await service().setAccess(c.req.param('id'), validateWebsiteAccessRequest(await readJsonBody(c.req.raw, 256 * 1024)))))
  app.post('/:id/running', async (c) => {
    const body = await readJsonBody(c.req.raw) as { running?: unknown }
    if (typeof body.running !== 'boolean') throw new InvalidRequestError(400, '启停状态须为布尔值')
    return c.json(await service().setRunning(c.req.param('id'), body.running))
  })
  app.get('/:id/logs', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({ logs: await service().logs(c.req.param('id')) })
  })
  app.post('/proxy/reconcile', async (c) => {
    const proxy = await service().reconcileProxy()
    return c.json({ proxy, applied: proxy.state === 'active' && proxy.detail === null })
  })
  app.delete('/:id', async (c) => {
    const body = await readJsonBody(c.req.raw) as { confirm?: unknown }
    if (body.confirm !== 'DELETE_WEBSITE_AND_DATA') throw new InvalidRequestError(400, '必须确认删除站点及数据')
    await service().remove(c.req.param('id'))
    return c.json({ ok: true })
  })
  return app
}

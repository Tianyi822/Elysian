import { Hono } from 'hono'
import { endpointErrorHandler, invalidRequest, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import type { DockerReadService } from './dockerService.ts'

const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** 挂载路径：app.ts 用同一常量挂载，404 兜底也用它剥前缀——单一事实，两处不漂移。 */
export const DOCKER_MOUNT = '/api/docker'

export type { DockerReadService } from './dockerService.ts'

/** 路由装配入参：两段 503（容器外 / socket 未就绪）与只读 service 注入。 */
export type DockerAppDeps = {
  available: boolean
  socketReady: boolean
  service?: DockerReadService
}

/** 容器管理子应用工厂：app.ts 挂到 DOCKER_MOUNT；测试直接 request 驱动。 */
export function createDockerApp(deps: DockerAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)

  if (!deps.available) {
    app.all('*', () => sendJson(503, { error: '真实容器管理仅在 Docker 容器内可用' }))
    return app
  }

  if (!deps.socketReady || !deps.service) {
    app.all('*', () => sendJson(503, { error: 'Docker 服务未就绪' }))
    return app
  }

  const service = deps.service

  app.use('*', sameOriginGuard())

  app.get('/status', () => sendJson(200, { ok: true }))
  app.get('/containers', async () => sendJson(200, { containers: await service.listContainers() }))
  app.get('/images', async () => sendJson(200, { images: await service.listImages() }))
  app.get('/policy', async () => sendJson(200, await service.policy()))

  async function postContainerAction(
    id: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<Response> {
    if (!CONTAINER_ID_PATTERN.test(id)) {
      throw invalidRequest('容器 ID 格式无效')
    }
    const container = await service.action(id, action)
    return sendJson(200, container)
  }

  app.post('/containers/:id/start', (c) => postContainerAction(c.req.param('id'), 'start'))
  app.post('/containers/:id/stop', (c) => postContainerAction(c.req.param('id'), 'stop'))
  app.post('/containers/:id/restart', (c) => postContainerAction(c.req.param('id'), 'restart'))

  app.all('*', (c) => {
    const path = c.req.path.slice(DOCKER_MOUNT.length) || '/'
    return sendJson(404, { error: `未知容器管理端点：${c.req.method} ${path}` })
  })
  return app
}

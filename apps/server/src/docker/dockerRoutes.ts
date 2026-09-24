import type { Context } from 'hono'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import {
  ALLOWED_HOSTNAMES,
  endpointErrorHandler,
  InvalidRequestError,
  invalidRequest,
  readJsonBody,
  sameOriginGuard,
  sendJson,
} from '../middleware/guard.ts'
import type { OperationAuditLogs } from '../logs/operationAudit.ts'
import type { TerminalWsEvents } from '../terminals/terminalConnection.ts'
import type { DockerTransport } from './dockerTransport.ts'
import { assertContainerTerminalAllowed } from './dockerTerminalGuard.ts'
import type { DockerExecSessions } from './dockerExecSessions.ts'
import type { DockerReadService } from './dockerService.ts'
import type { DockerEventsHub } from './dockerEventsHub.ts'

const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const SSE_RETRY_MS = 3_000
const SSE_HEARTBEAT_MS = 15_000
/** SSE 注释帧：Engine 事件流断开而 HTTP 仍开着时通知浏览器进入 connecting（与 web adapter 约定一致）。 */
export const SSE_STATUS_CONNECTING = ': status connecting\n\n'

/** 挂载路径：app.ts 用同一常量挂载，404 兜底也用它剥前缀——单一事实，两处不漂移。 */
export const DOCKER_MOUNT = '/api/docker'

export type { DockerReadService } from './dockerService.ts'
export type { DockerEventsHub } from './dockerEventsHub.ts'

/** WS 升级专用同源校验（与终端片 /ws 逐字同口径）。 */
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

export type DockerWebSocketUpgrade = (
  c: Context,
  events: TerminalWsEvents,
) => Response | Promise<Response>

/** 路由装配入参：两段 503（容器外 / socket 未就绪）与只读 service 注入。 */
export type DockerAppDeps = {
  available: boolean
  socketReady: boolean
  service?: DockerReadService
  eventsHub?: DockerEventsHub
  transport?: DockerTransport
  selfContainerId?: string | null
  dockerExecSessions?: DockerExecSessions
  logs?: OperationAuditLogs
  /** 测试注入：合法升级路径替换 bunWebSocket.upgradeWebSocket。 */
  upgradeWebSocket?: DockerWebSocketUpgrade
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
  const eventsHub = deps.eventsHub

  app.use('*', sameOriginGuard())

  app.get('/status', () => sendJson(200, { ok: true }))
  app.get('/containers', async () => sendJson(200, { containers: await service.listContainers() }))
  app.get('/images', async () => sendJson(200, { images: await service.listImages() }))
  app.get('/policy', async () => sendJson(200, await service.policy()))

  if (eventsHub) {
    app.get('/events', (c) => {
      const lastEventId = c.req.header('last-event-id')
      type HubFrame = { event: string; id: string; data: string }
      const pending: HubFrame[] = []
      const pendingStatusComments: string[] = []
      let writeFrame: ((frame: HubFrame) => void) | undefined
      let writeStatusComment: ((comment: string) => void) | undefined
      let unsubscribe: () => void

      try {
        unsubscribe = eventsHub.subscribe({
          lastEventId,
          onEvent: (frame) => {
            if (writeFrame) {
              writeFrame(frame)
            } else {
              pending.push(frame)
            }
          },
          onStatus: (status) => {
            if (status === 'connecting') {
              if (writeStatusComment) {
                void writeStatusComment(SSE_STATUS_CONNECTING)
              } else {
                pendingStatusComments.push(SSE_STATUS_CONNECTING)
              }
            }
          },
        })
      } catch (error) {
        if (error instanceof Error && error.message === '实时连接数已达上限') {
          return sendJson(503, { error: error.message })
        }
        throw error
      }

      c.header('Content-Type', 'text/event-stream; charset=utf-8')
      c.header('Cache-Control', 'no-cache, no-transform')

      return stream(c, async (sseStream) => {
        await sseStream.write(`retry: ${SSE_RETRY_MS}\n\n`)
        writeFrame = (frame) => {
          void sseStream.write(
            `event: ${frame.event}\nid: ${frame.id}\ndata: ${frame.data}\n\n`,
          )
        }
        for (const frame of pending) {
          writeFrame(frame)
        }
        pending.length = 0

        writeStatusComment = (comment) => {
          void sseStream.write(comment)
        }
        for (const comment of pendingStatusComments) {
          void writeStatusComment(comment)
        }
        pendingStatusComments.length = 0

        const heartbeat = setInterval(() => {
          void sseStream.write(': keep-alive\n\n')
        }, SSE_HEARTBEAT_MS)

        await new Promise<void>((resolve) => {
          if (c.req.raw.signal.aborted) {
            resolve()
            return
          }
          c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true })
        })

        clearInterval(heartbeat)
        unsubscribe()
      })
    })
  }

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

  app.post('/containers', async (c) => {
    const body = await readJsonBody(c.req.raw)
    const container = await service.create(body)
    return sendJson(201, container)
  })

  app.post('/containers/:id/start', (c) => postContainerAction(c.req.param('id'), 'start'))
  app.post('/containers/:id/stop', (c) => postContainerAction(c.req.param('id'), 'stop'))
  app.post('/containers/:id/restart', (c) => postContainerAction(c.req.param('id'), 'restart'))

  app.post('/images/pull', async (c) => {
    const body = await readJsonBody(c.req.raw)
    const image = await service.pull(body, c.req.raw.signal)
    return sendJson(200, image)
  })

  app.delete('/images/:id', async (c) => {
    const id = c.req.param('id')
    if (!CONTAINER_ID_PATTERN.test(id)) {
      throw invalidRequest('镜像 ID 格式无效')
    }
    await service.removeImage(id)
    return new Response(null, { status: 204 })
  })

  const transport = deps.transport
  const dockerExecSessions = deps.dockerExecSessions

  app.get('/containers/:id/terminal', async (c) => {
    if (!isSameOriginUpgrade(c.req.raw)) {
      return sendJson(403, { error: '请求来源不允许' })
    }

    const id = c.req.param('id')
    if (!CONTAINER_ID_PATTERN.test(id)) {
      throw invalidRequest('容器 ID 格式无效')
    }

    if (!transport || !dockerExecSessions) {
      return sendJson(503, { error: 'Docker 服务未就绪' })
    }

    try {
      await assertContainerTerminalAllowed(transport, id, deps.selfContainerId ?? null)
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return sendJson(error.status, { error: error.message })
      }
      throw error
    }

    if (deps.logs) {
      const { recordPanelOperation } = await import('../logs/operationAudit.ts')
      await recordPanelOperation(deps.logs, {
        category: 'containers',
        action: '打开容器终端',
        target: `容器 ${id}`,
        result: 'success',
        method: 'GET',
        path: `${DOCKER_MOUNT}/containers/${id}/terminal`,
        httpStatus: 200,
      })
    }

    const wsEvents = dockerExecSessions.createWsEvents(id)
    const upgrade = deps.upgradeWebSocket
    if (upgrade) {
      return upgrade(c, wsEvents)
    }
    const { bunWebSocket } = await import('../terminals/bunWebSocket.ts')
    return bunWebSocket.upgradeWebSocket(c, wsEvents)
  })

  app.all('*', (c) => {
    const path = c.req.path.slice(DOCKER_MOUNT.length) || '/'
    return sendJson(404, { error: `未知容器管理端点：${c.req.method} ${path}` })
  })
  return app
}

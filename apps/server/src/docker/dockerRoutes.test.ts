import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Container, ContainerImage } from '@elysian/contracts'
import { InvalidRequestError } from '../shared/errors'
import { sendJson } from '../middleware/guard.ts'
import type { TerminalWsEvents } from '../terminals/terminalConnection.ts'
import type { DockerTransport } from './dockerTransport.ts'
import { TERMINAL_NOT_RUNNING_MESSAGE } from './dockerTerminalGuard.ts'
import type { DockerExecSessions } from './dockerExecSessions.ts'
import {
  DOCKER_MOUNT,
  SSE_STATUS_CONNECTING,
  createDockerApp,
  type DockerAppDeps,
  type DockerEventsHub,
  type DockerReadService,
} from './dockerRoutes'

const SAMPLE_CONTAINER: Container = {
  id: 'a1b2c3d4e5f6',
  name: 'test-container',
  status: 'running',
  imageId: 'deadbeef',
  ports: [],
  createdAt: '2024-06-01T10:00:00.000000000Z',
  command: 'nginx',
  env: [],
  volumes: [],
  restartPolicy: 'no',
}

const SAMPLE_IMAGE: ContainerImage = {
  id: 'abcdef123456',
  name: 'myapp',
  tag: '1.0',
  digest: 'sha256:digest',
  sizeMb: 2,
  pulledAt: '2024-05-01T08:00:00.000000000Z',
}

function createFakeService(overrides: Partial<DockerReadService> = {}): DockerReadService {
  return {
    listContainers: async () => [SAMPLE_CONTAINER],
    listImages: async () => [SAMPLE_IMAGE],
    searchImages: async () => ({ names: ['redis'], searchable: true }),
    imageTags: async () => ({ tags: ['latest', '8-alpine'], searchable: true }),
    policy: async () => ({
      mountRoot: '/srv',
      reservedPorts: [22, 48100, 48101],
    }),
    action: async (id, action) => ({
      ...SAMPLE_CONTAINER,
      id,
      status: action === 'stop' ? 'stopped' : 'running',
    }),
    create: async () => SAMPLE_CONTAINER,
    pull: async () => SAMPLE_IMAGE,
    removeImage: async () => undefined,
    removeContainer: async () => undefined,
    ...overrides,
  }
}

const SAME_ORIGIN_HEADERS = {
  host: 'localhost:5173',
  origin: 'http://localhost:5173',
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: {
      ...SAME_ORIGIN_HEADERS,
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

function mountedApp(deps: DockerAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.route(DOCKER_MOUNT, createDockerApp(deps))
  return parent
}

function createFakeTransport(
  handler: (input: { method: string; path: string }) => { status: number; json: unknown },
): DockerTransport {
  return {
    request: async (input) => handler(input),
  }
}

function baseContainerInspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: SAMPLE_CONTAINER.id,
    State: { Status: 'running' },
    ...overrides,
  }
}

function createFakeDockerExecSessions(): DockerExecSessions {
  return {
    createWsEvents: () => ({
      onOpen: vi.fn(),
      onMessage: vi.fn(),
      onClose: vi.fn(),
    }),
    activeCount: () => 0,
    managedCount: () => 0,
  }
}

const TERMINAL_READY: DockerAppDeps = {
  available: true,
  socketReady: true,
  service: createFakeService(),
  transport: createFakeTransport(() => ({
    status: 200,
    json: baseContainerInspect(),
  })),
  dockerExecSessions: createFakeDockerExecSessions(),
}

const READY: DockerAppDeps = {
  available: true,
  socketReady: true,
  service: createFakeService(),
}

function createFakeHub(): DockerEventsHub & {
  lastSubscribe?: {
    onStatus: (status: 'live' | 'connecting') => void
  }
} {
  let count = 0
  const hub = {
    subscribe(handlers: {
      onEvent: (frame: { event: string; id: string; data: string }) => void
      onStatus: (status: 'live' | 'connecting') => void
      lastEventId?: string
    }) {
      count += 1
      if (count > 8) {
        throw new Error('实时连接数已达上限')
      }
      hub.lastSubscribe = handlers
      return () => {
        count -= 1
      }
    },
    notifyRestarting: vi.fn(),
    lastSubscribe: undefined as
      | { onStatus: (status: 'live' | 'connecting') => void }
      | undefined,
  }
  return hub
}

describe('createDockerApp', () => {
  it('不可用时一律 503（含未知路径）', async () => {
    const app = mountedApp({ available: false, socketReady: false })
    for (const path of ['/api/docker/containers', '/api/docker/nope']) {
      const res = await app.request(req('GET', path))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实容器管理仅在 Docker 容器内可用' })
    }
  })

  it('在容器内但 socket 未就绪时 503，error 携带具体原因', async () => {
    const app = mountedApp({
      available: true,
      socketReady: false,
      socketUnavailableReason: 'Docker Engine API 版本过低，需要 1.41 及以上',
    })
    const res = await app.request(req('GET', '/api/docker/containers'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Docker 服务未就绪')
    expect(body.error).toContain('Docker Engine API 版本过低')
  })

  it('socket 未就绪且无具体原因时回落到默认连接失败文案', async () => {
    const app = mountedApp({ available: true, socketReady: false })
    const res = await app.request(req('GET', '/api/docker/containers'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Docker 服务未就绪：无法连接 Docker socket' })
  })

  it('可用时 GET /status 为 200', async () => {
    const app = createDockerApp(READY)
    const res = await app.request(req('GET', '/status'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET /containers、/images、/policy 透传假 service', async () => {
    const app = createDockerApp(READY)
    const containers = await app.request(req('GET', '/containers'))
    expect(await containers.json()).toEqual({ containers: [SAMPLE_CONTAINER] })

    const images = await app.request(req('GET', '/images'))
    expect(await images.json()).toEqual({ images: [SAMPLE_IMAGE] })

    const policy = await app.request(req('GET', '/policy'))
    expect(await policy.json()).toEqual({
      mountRoot: '/srv',
      reservedPorts: [22, 48100, 48101],
    })
  })

  it('GET /images/search 传入搜索词与自定义镜像源', async () => {
    const searchImages = vi.fn(async () => ({ names: ['redis'], searchable: true }))
    const app = createDockerApp({ ...READY, service: createFakeService({ searchImages }) })
    const res = await app.request(req('GET', '/images/search?term=red&registry=https%3A%2F%2Fmirror.example.com'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ names: ['redis'], searchable: true })
    expect(searchImages).toHaveBeenCalledWith('red', 'https://mirror.example.com')
  })

  it('GET /images/tags 传入仓库名与自定义镜像源', async () => {
    const imageTags = vi.fn(async () => ({ tags: ['latest', '8-alpine'], searchable: true }))
    const app = createDockerApp({ ...READY, service: createFakeService({ imageTags }) })
    const res = await app.request(req('GET', '/images/tags?name=redis&registry=https%3A%2F%2Fmirror.example.com'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ['latest', '8-alpine'], searchable: true })
    expect(imageTags).toHaveBeenCalledWith('redis', 'https://mirror.example.com')
  })

  it('跨源 POST /containers 先 403', async () => {
    const app = createDockerApp(READY)
    const res = await app.request(
      req('POST', '/containers', { name: 'x' }, { origin: 'http://evil.example' }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })

  it('POST /containers 返回 201 与容器对象', async () => {
    const create = vi.fn(async () => ({ ...SAMPLE_CONTAINER, name: 'redis-echo' }))
    const app = mountedApp({
      ...READY,
      service: createFakeService({ create }),
    })
    const res = await app.request(
      req('POST', '/api/docker/containers', {
        imageId: 'abcdef',
        name: 'redis-echo',
        ports: [],
        env: [],
        volumes: [],
        restartPolicy: 'no',
      }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ...SAMPLE_CONTAINER, name: 'redis-echo' })
    expect(create).toHaveBeenCalledOnce()
  })

  it('未知 GET 为 404，文案剥挂载前缀', async () => {
    const app = mountedApp(READY)
    const res = await app.request(req('GET', '/api/docker/nope'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知容器管理端点：GET /nope' })
  })

  it('POST /containers/:id/start|stop|restart 返回 200 与容器对象', async () => {
    const action = vi.fn(async (id: string, kind: 'start' | 'stop' | 'restart') => ({
      ...SAMPLE_CONTAINER,
      id,
      status: kind === 'stop' ? ('stopped' as const) : ('running' as const),
    }))
    const app = mountedApp({
      ...READY,
      service: createFakeService({ action }),
    })

    for (const kind of ['start', 'stop', 'restart'] as const) {
      const res = await app.request(req('POST', `/api/docker/containers/${SAMPLE_CONTAINER.id}/${kind}`))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ...SAMPLE_CONTAINER,
        id: SAMPLE_CONTAINER.id,
        status: kind === 'stop' ? 'stopped' : 'running',
      })
      expect(action).toHaveBeenCalledWith(SAMPLE_CONTAINER.id, kind)
    }
  })

  it('非法容器 id 返回 400', async () => {
    const app = mountedApp(READY)
    const res = await app.request(req('POST', '/api/docker/containers/bad%2Fid/start'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '容器 ID 格式无效' })
  })

  it('service 抛出容器不存在时路由返回 404', async () => {
    const app = mountedApp({
      ...READY,
      service: createFakeService({
        action: async () => {
          throw new InvalidRequestError(404, '容器不存在')
        },
      }),
    })
    const res = await app.request(req('POST', `/api/docker/containers/${SAMPLE_CONTAINER.id}/start`))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '容器不存在' })
  })

  it('GET /events 第 9 路连接返回 503', async () => {
    const app = mountedApp({
      ...READY,
      eventsHub: createFakeHub(),
    })
    for (let i = 0; i < 8; i += 1) {
      const res = await app.request(req('GET', '/api/docker/events'))
      expect(res.status).toBe(200)
      await res.body?.cancel()
    }
    const blocked = await app.request(req('GET', '/api/docker/events'))
    expect(blocked.status).toBe(503)
    expect(await blocked.json()).toEqual({ error: '实时连接数已达上限' })
  })

  it('POST /images/pull 返回 200 并把 AbortSignal 传给 service', async () => {
    const pull = vi.fn(async (_body: unknown, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return SAMPLE_IMAGE
    })
    const app = mountedApp({
      ...READY,
      service: createFakeService({ pull }),
    })
    const res = await app.request(
      req('POST', '/api/docker/images/pull', { name: 'nginx', tag: '1.27' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SAMPLE_IMAGE)
    expect(pull).toHaveBeenCalledOnce()
  })

  it('POST /images/pull/stream 在拉取结束前推送进度，随后发最终镜像', async () => {
    let emitProgress!: () => Promise<void>
    let finish!: () => void
    const pull = vi.fn((_body: unknown, _signal: AbortSignal, onProgress?: (progress: { phase: 'downloading'; layerId: string; currentBytes: number; totalBytes: number }) => void | Promise<void>) =>
      new Promise<ContainerImage>((resolve) => {
        emitProgress = async () => { await onProgress?.({ phase: 'downloading', layerId: 'abc', currentBytes: 50, totalBytes: 100 }) }
        finish = () => resolve(SAMPLE_IMAGE)
      }),
    )
    const app = mountedApp({ ...READY, service: createFakeService({ pull }) })
    const response = await app.request(req('POST', '/api/docker/images/pull/stream', { name: 'nginx', tag: '1.27' }))
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const reader = response.body!.getReader()
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce())
    await emitProgress()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"type":"progress"')
    finish()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain('"type":"result"')
    await reader.cancel()
  })

  it('流式拉取失败时发送错误帧', async () => {
    const app = mountedApp({ ...READY, service: createFakeService({
      pull: async () => { throw new Error('镜像拉取失败') },
    }) })
    const response = await app.request(req('POST', '/api/docker/images/pull/stream', { name: 'nginx', tag: '1.27' }))
    expect(await response.text()).toContain('"type":"error","error":"镜像拉取失败"')
  })

  it('DELETE /images/:id 返回 204 且无响应体', async () => {
    const removeImage = vi.fn(async () => undefined)
    const app = mountedApp({
      ...READY,
      service: createFakeService({ removeImage }),
    })
    const res = await app.request(req('DELETE', `/api/docker/images/${SAMPLE_IMAGE.id}`))
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    expect(removeImage).toHaveBeenCalledWith(SAMPLE_IMAGE.id)
  })

  it('DELETE /containers/:id 调用 removeContainer 并返回 204', async () => {
    const removeContainer = vi.fn(async () => undefined)
    const app = mountedApp({
      ...READY,
      service: createFakeService({ removeContainer }),
    })
    const res = await app.request(req('DELETE', `/api/docker/containers/${SAMPLE_CONTAINER.id}`))
    expect(res.status).toBe(204)
    expect(removeContainer).toHaveBeenCalledWith(SAMPLE_CONTAINER.id)
  })

  it('DELETE /containers/:id 的 id 格式无效时 400', async () => {
    const removeContainer = vi.fn(async () => undefined)
    const app = mountedApp({
      ...READY,
      service: createFakeService({ removeContainer }),
    })
    const res = await app.request(req('DELETE', '/api/docker/containers/坏 id'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '容器 ID 格式无效' })
    expect(removeContainer).not.toHaveBeenCalled()
  })

  describe('GET /containers/:id/terminal 升级前检查', () => {
    const terminalPath = `/api/docker/containers/${SAMPLE_CONTAINER.id}/terminal`

    it('整片不可用时 503', async () => {
      const app = mountedApp({ available: false, socketReady: false })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(503)
    })

    it('无 Origin 时 403', async () => {
      const app = mountedApp(TERMINAL_READY)
      const res = await app.request(
        req('GET', terminalPath, undefined, { origin: '' }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: '请求来源不允许' })
    })

    it('容器不存在时 404', async () => {
      const app = mountedApp({
        ...TERMINAL_READY,
        transport: createFakeTransport(() => ({ status: 404, json: { message: 'not found' } })),
      })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: '容器不存在' })
    })

    it('paused 容器 409', async () => {
      const app = mountedApp({
        ...TERMINAL_READY,
        transport: createFakeTransport(() => ({
          status: 200,
          json: baseContainerInspect({ State: { Status: 'paused' } }),
        })),
      })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: TERMINAL_NOT_RUNNING_MESSAGE })
    })

    it('自身容器运行中也允许升级终端，其他管理动作仍走各自守卫', async () => {
      const upgrade = vi.fn((_c: Context, _events: TerminalWsEvents) =>
        sendJson(200, { upgraded: true }),
      )
      const app = mountedApp({
        ...TERMINAL_READY,
        selfContainerId: SAMPLE_CONTAINER.id,
        upgradeWebSocket: upgrade,
      })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ upgraded: true })
      expect(upgrade).toHaveBeenCalledOnce()
    })

    it('通过前置检查后调用注入的 upgrade', async () => {
      const upgrade = vi.fn((_c: Context, _events: TerminalWsEvents) =>
        sendJson(200, { upgraded: true }),
      )
      const app = mountedApp({
        ...TERMINAL_READY,
        upgradeWebSocket: upgrade,
      })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ upgraded: true })
      expect(upgrade).toHaveBeenCalledOnce()
    })

    it('通过前置检查且提供 logs 时记录打开容器终端', async () => {
      const recordOperation = vi.fn(async () => undefined)
      const log = vi.fn(async () => undefined)
      const app = mountedApp({
        ...TERMINAL_READY,
        logs: { recordOperation, log, recordLogin: async () => undefined },
        upgradeWebSocket: () => sendJson(200, { upgraded: true }),
      })
      const res = await app.request(req('GET', terminalPath))
      expect(res.status).toBe(200)
      expect(recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'containers',
          action: '打开容器终端',
          target: `容器 ${SAMPLE_CONTAINER.id}`,
          result: 'success',
          method: 'GET',
          path: `${DOCKER_MOUNT}/containers/${SAMPLE_CONTAINER.id}/terminal`,
          httpStatus: 200,
        }),
      )
      expect(log).toHaveBeenCalledWith('info', 'logs.operation', '操作：打开容器终端（成功）')
    })
  })

  it('hub 上报 connecting 时 SSE 写入 status connecting 注释帧', async () => {
    const hub = createFakeHub()
    const app = mountedApp({
      ...READY,
      eventsHub: hub,
    })
    const res = await app.request(req('GET', '/api/docker/events'))
    expect(res.status).toBe(200)

    hub.lastSubscribe?.onStatus('connecting')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (text.length < 200) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('status connecting')) break
    }
    await reader.cancel()
    expect(text).toContain(SSE_STATUS_CONNECTING.trim())
  })

  it('首次订阅按连接中、重同步、恢复的顺序写入 SSE，随后断开和恢复都通知客户端', async () => {
    const unsubscribe = vi.fn()
    let reportStatus: ((status: 'live' | 'connecting') => void) | undefined
    const hub: DockerEventsHub = {
      subscribe(handlers) {
        reportStatus = handlers.onStatus
        handlers.onStatus('connecting')
        handlers.onEvent({ event: 'container/resync', id: 'boot.1', data: '{}' })
        handlers.onStatus('live')
        return unsubscribe
      },
      notifyRestarting: vi.fn(),
    }
    const abort = new AbortController()
    const request = new Request(req('GET', '/api/docker/events'), { signal: abort.signal })
    const res = await mountedApp({ ...READY, eventsHub: hub }).request(request)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (tail: string) => {
      while (!text.endsWith(tail)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    }
    try {
      await readUntil('data: {}\n\n')
      expect(text).toContain(': status connecting')
      expect(text.indexOf(': status connecting')).toBeLessThan(text.indexOf('event: container/resync'))
      await readUntil(': status live\n\n')
      expect(text).toContain(': status live\n\n')

      reportStatus?.('connecting')
      await readUntil(': status connecting\n\n')
      reportStatus?.('live')
      await readUntil(': status live\n\n')
      expect(text.match(/: status live/g)).toHaveLength(2)
    } finally {
      abort.abort()
      await reader.cancel()
    }
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  })
})

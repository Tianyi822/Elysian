import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { Container, ContainerImage } from '@elysian/contracts'
import { InvalidRequestError } from '../shared/errors'
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

  it('在容器内但 socket 未就绪时 503', async () => {
    const app = mountedApp({ available: true, socketReady: false })
    const res = await app.request(req('GET', '/api/docker/containers'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Docker 服务未就绪' })
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
})

import { describe, expect, it, vi } from 'vitest'
import type { Container, ContainerImage, ElysianEvent } from '@elysian/contracts'
import { FakeEventSource } from '../../test/fakeEventSource'
import {
  createContainerWatchLive,
  createHttpContainersAdapter,
  parseContainer,
  parseContainerImageListResponse,
  parseContainerListResponse,
  parseContainerPolicyResponse,
} from './containersHttpAdapter'

const baseContainer: Container = {
  id: 'a1b2c3d4e5f6',
  name: 'test-container',
  status: 'paused',
  imageId: 'deadbeef',
  imageRef: 'myapp:1.0',
  ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp', hostIp: '127.0.0.1' }],
  createdAt: '2024-06-01T10:00:00.000Z',
  startedAt: '2024-06-01T10:05:00.000Z',
  command: 'nginx',
  env: [{ key: 'SECRET_TOKEN', value: null }],
  volumes: [{ hostPath: '/data', containerPath: '/var/data', kind: 'bind' }],
  restartPolicy: 'unless-stopped',
}

const baseImage: ContainerImage = {
  id: 'abcdef123456',
  name: 'myapp',
  tag: '1.0',
  digest: 'sha256:digest',
  sizeMb: 2,
  pulledAt: null,
  otherTags: ['myapp:latest', 'repo/myapp:1.0'],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseContainerListResponse', () => {
  it('接受 containers 数组并逐条校验', () => {
    expect(parseContainerListResponse({ containers: [baseContainer] })).toEqual([baseContainer])
  })

  it('缺 containers 或元素缺 id 时抛「容器列表响应无效」', () => {
    expect(() => parseContainerListResponse({})).toThrow('容器列表响应无效')
    expect(() => parseContainerListResponse({ containers: 'nope' })).toThrow('容器列表响应无效')
    expect(() => parseContainerListResponse({ containers: [{ ...baseContainer, id: 7 }] })).toThrow(
      '容器列表响应无效',
    )
  })

  it('paused、hostIp、value: null 能通过解析', () => {
    expect(parseContainer(baseContainer)).toEqual(baseContainer)
  })
})

describe('parseContainerImageListResponse', () => {
  it('接受 images 数组并逐条校验', () => {
    expect(parseContainerImageListResponse({ images: [baseImage] })).toEqual([baseImage])
  })

  it('缺 images 或条目无效时抛「镜像列表响应无效」', () => {
    expect(() => parseContainerImageListResponse({})).toThrow('镜像列表响应无效')
    expect(() => parseContainerImageListResponse({ images: [{ ...baseImage, id: null }] })).toThrow(
      '镜像列表响应无效',
    )
  })

  it('otherTags 与 pulledAt: null 能通过解析', () => {
    expect(parseContainerImageListResponse({ images: [baseImage] })[0]).toEqual(baseImage)
  })
})

describe('parseContainerPolicyResponse', () => {
  it('接受 mountRoot 与 reservedPorts', () => {
    expect(parseContainerPolicyResponse({ mountRoot: '/srv', reservedPorts: [22, 48100] })).toEqual({
      mountRoot: '/srv',
      reservedPorts: [22, 48100],
    })
  })
})

describe('createHttpContainersAdapter', () => {
  it('list() 请求 GET /api/docker/containers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ containers: [baseContainer] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const containers = await adapter.list()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', undefined)
    expect(containers).toEqual([baseContainer])
    vi.unstubAllGlobals()
  })

  it('listImages() 请求 GET /api/docker/images', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ images: [baseImage] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const images = await adapter.listImages()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images', undefined)
    expect(images).toEqual([baseImage])
    vi.unstubAllGlobals()
  })

  it('createPolicy() 请求 GET /api/docker/policy', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ mountRoot: '/srv', reservedPorts: [48100] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.createPolicy()).resolves.toEqual({
      mountRoot: '/srv',
      reservedPorts: [48100],
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/policy', undefined)
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 时抛响应体里的 error 字符串', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Docker 服务未就绪' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.list()).rejects.toThrow('Docker 服务未就绪')
    vi.unstubAllGlobals()
  })

  it('watchLive 订阅 /api/docker/events 并按事件名派发', () => {
    FakeEventSource.reset()
    const statuses: Array<'live' | 'connecting'> = []
    const events: ElysianEvent[] = []
    const watchLive = createContainerWatchLive({ createEventSource: (url) => new FakeEventSource(url) })
    const unsubscribe = watchLive({
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
    })

    const source = FakeEventSource.latest()
    expect(source?.url).toBe('/api/docker/events')
    expect(statuses).toEqual(['connecting'])

    source?.emitOpen()
    expect(statuses).toEqual(['connecting', 'live'])

    const envelope = JSON.stringify({
      id: 'evt-1',
      name: 'container/sample',
      at: '2026-09-12T08:00:00.000Z',
      payload: { samples: [] },
    })
    source?.emitRaw('container/sample', envelope)
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe('container/sample')

    source?.emitRaw('container/sample', '坏帧')
    expect(events).toHaveLength(1)

    source?.emitError()
    expect(statuses).toEqual(['connecting', 'live', 'connecting'])

    unsubscribe()
    expect(source?.closed).toBe(true)
  })

  it('watchLive 在 open 后收到 : status connecting 注释时上报 connecting', () => {
    FakeEventSource.reset()
    const statuses: Array<'live' | 'connecting'> = []
    const watchLive = createContainerWatchLive({ createEventSource: (url) => new FakeEventSource(url) })
    watchLive({ onStatus: (status) => statuses.push(status), onEvent: () => {} })
    const source = FakeEventSource.latest()
    source?.emitOpen()
    source?.emitCommentLine(': status connecting')
    expect(statuses).toEqual(['connecting', 'live', 'connecting'])
  })

  it('watchLive 在 open 之前的 onerror 不上报 connecting', () => {
    FakeEventSource.reset()
    const statuses: Array<'live' | 'connecting'> = []
    const watchLive = createContainerWatchLive({ createEventSource: (url) => new FakeEventSource(url) })
    watchLive({ onStatus: (status) => statuses.push(status), onEvent: () => {} })
    FakeEventSource.latest()?.emitError()
    expect(statuses).toEqual(['connecting'])
  })

  it('fetch 事件源断流后带 Last-Event-ID 重连，并在退避期间上报 connecting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    class NativeEventSourceWithoutConnectingHandler {
      constructor(_url: string) {}
    }
    vi.stubGlobal('EventSource', NativeEventSourceWithoutConnectingHandler)

    const envelope = JSON.stringify({
      id: 'evt-1',
      name: 'container/sample',
      at: '2026-09-12T08:00:00.000Z',
      payload: { samples: [] },
    })
    const firstChunk =
      `id: hub-42\n` +
      `event: container/sample\n` +
      `data: ${envelope}\n\n`

    let fetchCalls = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(firstChunk))
              controller.close()
            },
          }),
          { status: 200 },
        )
      }
      const headers = init?.headers
      const lastEventId =
        headers instanceof Headers
          ? headers.get('Last-Event-ID')
          : (headers as Record<string, string> | undefined)?.['Last-Event-ID']
      expect(lastEventId).toBe('hub-42')
      return new Response(
        new ReadableStream({
          start() {
            // 保持连接，避免测试触发进一步重连
          },
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const statuses: Array<'live' | 'connecting'> = []
    const watchLive = createContainerWatchLive()
    const unsubscribe = watchLive({
      onStatus: (status) => statuses.push(status),
      onEvent: () => {},
    })

    await vi.waitFor(() => {
      expect(statuses).toContain('live')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['connecting', 'live', 'connecting'])

    await vi.advanceTimersByTimeAsync(1_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])

    unsubscribe()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetch 事件源解析 : status connecting 注释', async () => {
    class NativeEventSourceWithoutConnectingHandler {
      constructor(_url: string) {}
    }
    vi.stubGlobal('EventSource', NativeEventSourceWithoutConnectingHandler)

    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': status connecting\n\n'))
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const statuses: Array<'live' | 'connecting'> = []
    const watchLive = createContainerWatchLive()
    const unsubscribe = watchLive({ onStatus: (status) => statuses.push(status), onEvent: () => {} })

    await vi.waitFor(() => {
      expect(statuses).toEqual(['connecting', 'live', 'connecting'])
    })

    unsubscribe()
    vi.unstubAllGlobals()
  })

  it('requestAction() POST /api/docker/containers/:id/:action 并解析容器', async () => {
    const running = { ...baseContainer, status: 'running' as const }
    const fetchMock = vi.fn(async () => jsonResponse(running))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const container = await adapter.requestAction('a1b2c3d4e5f6', 'start')
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers/a1b2c3d4e5f6/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(container).toEqual(running)
    vi.unstubAllGlobals()
  })

  it('create() POST /api/docker/containers 并解析 201 容器对象', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseContainer, 201))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const input = {
      imageId: 'deadbeef',
      name: 'test-container',
      ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' as const, hostIp: '127.0.0.1' }],
      env: [],
      volumes: [],
      restartPolicy: 'no' as const,
    }
    const container = await adapter.create(input)
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(container).toEqual(baseContainer)
    vi.unstubAllGlobals()
  })

  it('create() HTTP 非 2xx 时抛响应体里的 error 字符串', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: '挂载路径不允许' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(
      adapter.create({ imageId: 'x', ports: [], env: [], volumes: [], restartPolicy: 'no' }),
    ).rejects.toThrow('挂载路径不允许')
    vi.unstubAllGlobals()
  })

  it('未接入的方法统一抛固定中文', async () => {
    const adapter = createHttpContainersAdapter()
    await expect(adapter.execMockCommand('x', 'help')).rejects.toThrow('容器管理的该操作尚未接入')
  })

  it('pullImage() POST /images/pull 并解析返回镜像', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseImage))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const image = await adapter.pullImage({ name: 'nginx', tag: '1.27', registry: 'docker.1ms.run' })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nginx', tag: '1.27', registry: 'docker.1ms.run' }),
    })
    expect(image).toEqual(baseImage)
    vi.unstubAllGlobals()
  })

  it('removeImage() DELETE /images/:id，204 不解析 JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.removeImage('sha256:abc/def')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/sha256%3Aabc%2Fdef', {
      method: 'DELETE',
    })
    vi.unstubAllGlobals()
  })

  it('removeImage() HTTP 409 时抛响应体 error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: '镜像仍被容器使用' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.removeImage('img-x')).rejects.toThrow('镜像仍被容器使用')
    vi.unstubAllGlobals()
  })
})

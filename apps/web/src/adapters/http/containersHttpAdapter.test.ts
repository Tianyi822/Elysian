import { describe, expect, it, vi } from 'vitest'
import type { Container, ContainerImage, ElysianEvent } from '@elysian/contracts'
import { FakeEventSource } from '../../test/fakeEventSource'
import { setUnauthorizedListener } from './unauthorized'
import {
  createContainerWatchLive,
  createFetchContainerEventSource,
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

  it('searchImageNames() 编码源地址并传递取消信号', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ names: ['redis'], searchable: true }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const result = await createHttpContainersAdapter().searchImageNames('red', 'https://mirror.example.com', signal)
    expect(result).toEqual({ names: ['redis'], searchable: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/search?term=red&registry=https%3A%2F%2Fmirror.example.com', { signal })
    vi.unstubAllGlobals()
  })

  it('imageTags() 查询选定仓库版本并传递取消信号', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tags: ['latest', '8-alpine'], searchable: true }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const result = await createHttpContainersAdapter().imageTags('library/redis', 'https://mirror.example.com', signal)
    expect(result).toEqual({ tags: ['latest', '8-alpine'], searchable: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/tags?name=library%2Fredis&registry=https%3A%2F%2Fmirror.example.com', { signal })
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

  it('cancelTerminalConnect 接到容器终端 WS 适配器，无 pending 时是安全 no-op', () => {
    const adapter = createHttpContainersAdapter()
    expect(typeof adapter.cancelTerminalConnect).toBe('function')
    expect(() => adapter.cancelTerminalConnect?.()).not.toThrow()
  })

  it('HTTP 非 2xx 时抛响应体里的 error 字符串', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Docker 服务未就绪' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.list()).rejects.toThrow('Docker 服务未就绪')
    vi.unstubAllGlobals()
  })

  it('401 时上报全局监听并抛中文登录失效错误', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    const fetchMock = vi.fn(async () => jsonResponse({ error: '未登录或会话已过期' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.list()).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
    setUnauthorizedListener(() => {})
  })

  it('pullImage 的 401：上报并抛中文错误，不进流读取（无进度回调）', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    const fetchMock = vi.fn(async () => jsonResponse({ error: '未登录或会话已过期' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const onProgress = vi.fn()
    await expect(
      createHttpContainersAdapter().pullImage({ name: 'redis', tag: 'latest' }, onProgress),
    ).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(onProgress).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    setUnauthorizedListener(() => {})
  })

  it('fetch-SSE 的 401：上报一次、触发一次 onerror、超过初始退避窗口后不再重连', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    const fetchMock = vi.fn(
      async () => jsonResponse({ error: '未登录或会话已过期' }, 401),
    )
    vi.stubGlobal('fetch', fetchMock)
    const source = createFetchContainerEventSource('/api/docker/events')
    const onError = vi.fn()
    source.onerror = onError
    try {
      // 等待超过初始退避（1s）：401 后循环应已终止，fetch 不应有第二次。
      await new Promise((resolve) => setTimeout(resolve, 1_300))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      source.close()
      vi.unstubAllGlobals()
      setUnauthorizedListener(() => {})
    }
  }, 5_000)

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

  it('Engine 断开后采样仍可到达，直到恢复注释才清除 connecting', () => {
    FakeEventSource.reset()
    const statuses: Array<'live' | 'connecting'> = []
    const onEvent = vi.fn()
    const unsubscribe = createContainerWatchLive({ createEventSource: (url) => new FakeEventSource(url) })({
      onStatus: (status) => statuses.push(status), onEvent,
    })
    const source = FakeEventSource.latest()!
    try {
      source.emitOpen()
      source.emitCommentLine(': status connecting')
      source.emit('container/sample', {
        id: 'evt-1', name: 'container/sample', at: '2026-09-12T08:00:00.000Z', payload: { samples: [] },
      })
      expect(onEvent).toHaveBeenCalledOnce()
      expect(statuses.at(-1)).toBe('connecting')
      source.emitCommentLine(': status live')
      expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])
    } finally {
      unsubscribe()
    }
  })

  it('默认只创建一条 fetch SSE，支持连接中和恢复注释，退订后中止请求', async () => {
    const nativeConstructor = vi.fn()
    class NativeEventSource {
      constructor(url: string) { nativeConstructor(url) }
    }
    vi.stubGlobal('EventSource', NativeEventSource)
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({ start(value) { controller = value } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const statuses: Array<'live' | 'connecting'> = []
    const unsubscribe = createContainerWatchLive()({ onStatus: (status) => statuses.push(status), onEvent: () => {} })
    try {
      await vi.waitFor(() => expect(statuses).toEqual(['connecting', 'live']))
      controller!.enqueue(new TextEncoder().encode(': status connecting\n\n'))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('connecting'))
      controller!.enqueue(new TextEncoder().encode(': status li'))
      controller!.enqueue(new TextEncoder().encode('ve\n\n'))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('live'))
      expect(nativeConstructor).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      controller?.close()
      vi.unstubAllGlobals()
    }
    expect(signal?.aborted).toBe(true)
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

  it('pullImage() 在结果返回前逐块消费进度，再解析镜像', async () => {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200, headers: { 'content-type': 'application/x-ndjson' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const onProgress = vi.fn()
    const pending = adapter.pullImage({ name: 'nginx', tag: '1.27', registry: 'docker.1ms.run' }, onProgress)
    const progressLine = `${JSON.stringify({ type: 'progress', progress: { phase: 'downloading', layerId: 'abc', currentBytes: 50, totalBytes: 100 } })}\n`
    controller.enqueue(encoder.encode(progressLine.slice(0, 17)))
    controller.enqueue(encoder.encode(progressLine.slice(17)))
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith({ phase: 'downloading', layerId: 'abc', currentBytes: 50, totalBytes: 100 }))
    controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'result', image: baseImage })}\n`))
    controller.close()
    const image = await pending
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/pull/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ name: 'nginx', tag: '1.27', registry: 'docker.1ms.run' }),
    })
    expect(image).toEqual(baseImage)
    vi.unstubAllGlobals()
  })

  it('拉取流错误帧进入失败分支，未收到结果帧时也报错', async () => {
    const adapter = createHttpContainersAdapter()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"error","error":"仓库拒绝访问"}\n')))
    await expect(adapter.pullImage({ name: 'nginx', tag: '1.27' })).rejects.toThrow('仓库拒绝访问')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"progress","progress":{"phase":"preparing"}}\n')))
    await expect(adapter.pullImage({ name: 'nginx', tag: '1.27' })).rejects.toThrow('镜像拉取连接提前结束')
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

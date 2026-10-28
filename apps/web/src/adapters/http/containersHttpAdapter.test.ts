import { describe, expect, it, vi } from 'vitest'
import type { Container, ContainerImage, ElysianEvent } from '@elysian/contracts'
import { FakeEventSource } from '../../test/fakeEventSource'
import { setUnauthorizedListener } from './unauthorized'
import {
  createContainerWatchLive,
  createFetchContainerEventSource,
  createHttpContainersAdapter,
  parseContainer,
  parseContainerBuildPlan,
  parseContainerBuildTask,
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
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', { signal: expect.any(AbortSignal) })
    expect(containers).toEqual([baseContainer])
    vi.unstubAllGlobals()
  })

  it('listImages() 请求 GET /api/docker/images', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ images: [baseImage] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    const images = await adapter.listImages()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images', { signal: expect.any(AbortSignal) })
    expect(images).toEqual([baseImage])
    vi.unstubAllGlobals()
  })

  it('searchImageNames() 编码源地址并传递取消信号', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ names: ['redis'], searchable: true }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const result = await createHttpContainersAdapter().searchImageNames('red', 'https://mirror.example.com', signal)
    expect(result).toEqual({ names: ['redis'], searchable: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/search?term=red&registry=https%3A%2F%2Fmirror.example.com', { signal: expect.any(AbortSignal) })
    vi.unstubAllGlobals()
  })

  it('imageTags() 查询选定仓库版本并传递取消信号', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tags: ['latest', '8-alpine'], searchable: true }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const result = await createHttpContainersAdapter().imageTags('library/redis', 'https://mirror.example.com', signal)
    expect(result).toEqual({ tags: ['latest', '8-alpine'], searchable: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/tags?name=library%2Fredis&registry=https%3A%2F%2Fmirror.example.com', { signal: expect.any(AbortSignal) })
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
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/policy', { signal: expect.any(AbortSignal) })
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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

  it.each(['result', 'error'] as const)('收到 %s 终帧立即结束，正文和清理未结束也不继续等待', async (type) => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(type === 'result'
          ? { type, image: baseImage } : { type, error: '仓库拒绝访问' })}\n`))
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    try {
      const pending = createHttpContainersAdapter().pullImage({ name: 'redis', tag: 'latest' })
      if (type === 'result') await expect(pending).resolves.toEqual(baseImage)
      else await expect(pending).rejects.toThrow('仓库拒绝访问')
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })

  it('透传可选中文阶段说明，旧进度帧仍兼容', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"type":"progress","progress":{"phase":"preparing","message":"正在校验镜像源"}}\n' +
      '{"type":"progress","progress":{"phase":"downloading"}}\n' +
      `${JSON.stringify({ type: 'result', image: baseImage })}\n`,
    )))
    try {
      const onProgress = vi.fn()
      await createHttpContainersAdapter().pullImage({ name: 'redis', tag: 'latest' }, onProgress)
      expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
        { phase: 'preparing', message: '正在校验镜像源' }, { phase: 'downloading' },
      ])
    } finally { vi.unstubAllGlobals() }
  })

  it('下载进度之后断流保留未确认提示，仓库错误帧则保留真实原因', async () => {
    const encoder = new TextEncoder()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    try {
      const onProgress = vi.fn()
      const pending = createHttpContainersAdapter().pullImage({ name: 'mysql', tag: 'latest' }, onProgress)
      const failed = expect(pending).rejects.toThrow('镜像拉取连接中断，结果尚未确认，请刷新镜像列表核实后再重试')
      stream.enqueue(encoder.encode('{"type":"progress","progress":{"phase":"downloading","currentBytes":50,"totalBytes":100}}\n'))
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalled())
      stream.error(new Error('连接重置'))
      await failed
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"progress","progress":{"phase":"downloading"}}\n{"type":"error","error":"no space left on device"}\n')))
      await expect(createHttpContainersAdapter().pullImage({ name: 'mysql', tag: 'latest' })).rejects.toThrow('no space left on device')
    } finally { vi.unstubAllGlobals() }
  })

  it('停止拉取传递信号并关闭进度流，返回明确取消错误', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const controller = new AbortController()
      const onProgress = vi.fn()
      const pending = createHttpContainersAdapter().pullImage({ name: 'redis', tag: 'latest' }, onProgress, controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(body.locked).toBe(true))
      controller.abort()
      await rejected
      expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/pull/stream', expect.objectContaining({ signal: controller.signal }))
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
      expect(onProgress).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('提交前已停止时不发起拉取请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(createHttpContainersAdapter().pullImage({ name: 'redis', tag: 'latest' }, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('removeImage() DELETE /images/:id，204 不解析 JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.removeImage('sha256:abc/def')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/images/sha256%3Aabc%2Fdef', {
      signal: expect.any(AbortSignal),
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

const baseAppFile = {
  path: 'config/app.yml',
  size: 12,
  modifiedAt: '2026-10-01T00:00:00Z',
  text: true,
}

const baseApp = {
  slug: 'myapp',
  displayName: '我的应用',
  createdAt: '2026-10-01T00:00:00Z',
  directory: '/srv/elysian/apps/myapp',
  files: [baseAppFile],
}

const baseComposeCheck = {
  composePath: 'compose.yml',
  composeDir: '/srv/elysian/apps/myapp',
  references: [],
  undetermined: ['第 3 行：build: ./web（build 段由构建任务解析，自检不判定）'],
  coverage: '只判定 volumes 短语法与长语法 source、以及 env_file 引用的路径是否存在；含变量替换、锚点引用、flow 风格与 build 段的行列入未能判定清单（build 段请用构建预览），请人工核对',
}

describe('createHttpContainersAdapter 工作区端点', () => {
  it.each([[], null])('空工作区文件清单 %j 可加载和创建', async (files) => {
    const empty = { ...baseApp, files }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [empty, baseApp] }))
      .mockResolvedValueOnce(jsonResponse(empty, 201))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    expect(await adapter.listApps()).toEqual([{ ...baseApp, files: [] }, baseApp])
    expect(await adapter.createApp({ slug: baseApp.slug, displayName: baseApp.displayName }))
      .toEqual({ ...baseApp, files: [] })
    vi.unstubAllGlobals()
  })

  it.each([undefined, {}, 'invalid'])('无效文件清单 %j 仍明确报错', async (files) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ apps: [{ ...baseApp, files }] })))
    await expect(createHttpContainersAdapter().listApps()).rejects.toThrow('容器工作区响应无效')
    vi.unstubAllGlobals()
  })

  it('listApps() GET /api/container-apps 并解析 apps 数组', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ apps: [baseApp] }))
    vi.stubGlobal('fetch', fetchMock)
    const apps = await createHttpContainersAdapter().listApps()
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps', { signal: expect.any(AbortSignal) })
    expect(apps).toEqual([baseApp])
    vi.unstubAllGlobals()
  })

  it('createApp() POST /api/container-apps 并解析工作区对象', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseApp, 201))
    vi.stubGlobal('fetch', fetchMock)
    const input = { slug: 'myapp', displayName: '我的应用' }
    const created = await createHttpContainersAdapter().createApp(input)
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps', {
      signal: expect.any(AbortSignal),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(created.slug).toBe('myapp')
    vi.unstubAllGlobals()
  })

  it('uploadAppFile() PUT /files?path=… 并解析文件条目', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseAppFile))
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['key: value\n'])
    const saved = await createHttpContainersAdapter().uploadAppFile('myapp', 'config/app.yml', blob)
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/files?path=config%2Fapp.yml', {
      signal: expect.any(AbortSignal),
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    })
    expect(saved.path).toBe('config/app.yml')
    vi.unstubAllGlobals()
  })

  it('checkCompose() GET /compose-check?path=… 并解析引用与判定范围', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseComposeCheck))
    vi.stubGlobal('fetch', fetchMock)
    const checked = await createHttpContainersAdapter().checkCompose('myapp', 'compose.yml')
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/compose-check?path=compose.yml', {
      signal: expect.any(AbortSignal),
    })
    expect(checked.coverage).toContain('build 段请用构建预览')
    expect(checked.undetermined[0]).toContain('build 段由构建任务解析，自检不判定')
    vi.unstubAllGlobals()
  })

  it('readAppContent/writeAppContent/removeAppFile 走各自动词与查询串', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ path: 'config/app.yml', content: 'a: 1', file: baseAppFile }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await adapter.readAppContent('myapp', 'config/app.yml')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/container-apps/myapp/content?path=config%2Fapp.yml', {
      signal: expect.any(AbortSignal),
    })
    fetchMock.mockImplementation(async () => jsonResponse(baseAppFile))
    await adapter.writeAppContent('myapp', 'config/app.yml', 'a: 2')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/container-apps/myapp/content?path=config%2Fapp.yml', {
      signal: expect.any(AbortSignal),
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'a: 2',
    })
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }))
    await adapter.removeAppFile('myapp', 'config/app.yml')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/container-apps/myapp/files?path=config%2Fapp.yml', {
      signal: expect.any(AbortSignal),
      method: 'DELETE',
    })
    await adapter.removeApp('myapp')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/container-apps/myapp/', {
      signal: expect.any(AbortSignal),
      method: 'DELETE',
    })
    vi.unstubAllGlobals()
  })
})

const baseBuildTask = {
  id: '1001b1d5-build-1',
  slug: 'myapp',
  mode: 'compose',
  requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
  state: 'building',
  stage: '构建镜像 elysian/myapp/web',
  createdAt: '2026-10-04T07:30:00Z',
  updatedAt: '2026-10-04T07:31:12Z',
  input: {
    mode: 'compose',
    requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
    compose: 'docker-compose.yml',
    services: ['web'],
  },
  results: [
    {
      target: 'web',
      repository: 'elysian/myapp/web',
      tag: '20261004-073000-1001',
      imageId: 'sha256:abcd0123',
      state: 'succeeded',
      error: '',
    },
  ],
  error: '',
}

describe('createHttpContainersAdapter 镜像构建端点', () => {
  it('previewAppBuild() POST /builds/preview 并解析 dockerfile 形态预览', async () => {
    const preview = {
      mode: 'dockerfile',
      slug: 'myapp',
      target: 'app',
      dockerfile: 'Dockerfile',
      context: '.',
      imageRepository: 'elysian/myapp/app',
      contextFiles: 2,
      contextBytes: 128,
      repositoryOccupied: false,
      warnings: ['第 3 行 FROM 含未解析变量，面板未校验其镜像源'],
    }
    const fetchMock = vi.fn(async () => jsonResponse(preview))
    vi.stubGlobal('fetch', fetchMock)
    const input = { mode: 'dockerfile' as const, dockerfile: 'Dockerfile', context: './' }
    const plan = await createHttpContainersAdapter().previewAppBuild('myapp', input)
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/builds/preview', {
      signal: expect.any(AbortSignal),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(plan).toEqual(preview)
    vi.unstubAllGlobals()
  })

  it('parseContainerBuildPlan 解析 compose 形态的服务清单', () => {
    const plan = parseContainerBuildPlan({
      mode: 'compose',
      slug: 'myapp',
      compose: 'docker-compose.yml',
      services: [
        {
          service: 'web',
          hasBuild: true,
          target: 'web',
          dockerfile: 'web/Dockerfile',
          context: 'web',
          imageRepository: 'elysian/myapp/web',
          contextFiles: 8,
          contextBytes: 524288,
          imageNameInCompose: 'myapp-web',
          repositoryOccupied: false,
          warnings: [],
        },
        {
          service: 'db',
          hasBuild: false,
          target: '',
          dockerfile: '',
          context: '',
          imageRepository: '',
          contextFiles: 0,
          contextBytes: 0,
          imageNameInCompose: 'mariadb:11',
          repositoryOccupied: false,
          warnings: [],
        },
      ],
      warnings: [],
    })
    expect(plan.mode).toBe('compose')
    if (plan.mode !== 'compose') return
    expect(plan.services.map((service) => [service.service, service.hasBuild])).toEqual([
      ['web', true],
      ['db', false],
    ])
  })

  it('parseContainerBuildPlan 缺字段或形态不对时抛中文错误', () => {
    expect(() => parseContainerBuildPlan({ mode: 'dockerfile', slug: 'myapp' })).toThrow('构建预览响应无效')
    expect(() => parseContainerBuildPlan({ mode: 'weird', slug: 'myapp' })).toThrow('构建预览响应无效')
    expect(() =>
      parseContainerBuildPlan({
        mode: 'compose',
        slug: 'myapp',
        compose: 'c.yml',
        services: [{ service: 'web' }],
        warnings: [],
      }),
    ).toThrow('构建服务预览响应无效')
  })

  it('submitAppBuild() POST /builds 并解析 202 任务对象', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseBuildTask, 202))
    vi.stubGlobal('fetch', fetchMock)
    const input = {
      mode: 'compose' as const,
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
      compose: 'docker-compose.yml',
      services: ['web'],
    }
    const task = await createHttpContainersAdapter().submitAppBuild('myapp', input)
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/builds', {
      signal: expect.any(AbortSignal),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(task).toEqual(baseBuildTask)
    vi.unstubAllGlobals()
  })

  it('listAppBuilds() GET /builds 并解析 builds 数组', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ builds: [baseBuildTask] }))
    vi.stubGlobal('fetch', fetchMock)
    const builds = await createHttpContainersAdapter().listAppBuilds('myapp')
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/builds', { signal: expect.any(AbortSignal) })
    expect(builds).toEqual([baseBuildTask])
    vi.unstubAllGlobals()
  })

  it('getAppBuildLogs() 拼出 ?offset= 查询串并解析分页响应', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ lines: ['打包构建上下文（2 个文件，64 字节）'], next: 40, total: 100 }))
    vi.stubGlobal('fetch', fetchMock)
    const logs = await createHttpContainersAdapter().getAppBuildLogs('myapp', '1001b1d5-build-1', 0)
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/builds/1001b1d5-build-1/logs?offset=0', {
      signal: expect.any(AbortSignal),
    })
    expect(logs.next).toBe(40)
    expect(logs.lines[0]).toContain('打包构建上下文')
    const next = await createHttpContainersAdapter().getAppBuildLogs('myapp', '1001b1d5-build-1', 40)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/container-apps/myapp/builds/1001b1d5-build-1/logs?offset=40', {
      signal: expect.any(AbortSignal),
    })
    expect(next.total).toBe(100)
    vi.unstubAllGlobals()
  })

  it('cancelAppBuild() POST /builds/:id/cancel，204 不解析 JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await createHttpContainersAdapter().cancelAppBuild('myapp', '1001b1d5-build-1')
    expect(fetchMock).toHaveBeenCalledWith('/api/container-apps/myapp/builds/1001b1d5-build-1/cancel', {
      signal: expect.any(AbortSignal),
      method: 'POST',
    })
    vi.unstubAllGlobals()
  })

  it('构建端点 503 时透传中文错误（引擎不可用整组拦截）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Docker 服务未就绪' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpContainersAdapter()
    await expect(adapter.previewAppBuild('myapp', { mode: 'compose', compose: 'compose.yml' })).rejects.toThrow(
      'Docker 服务未就绪',
    )
    await expect(adapter.listAppBuilds('myapp')).rejects.toThrow('Docker 服务未就绪')
    vi.unstubAllGlobals()
  })

  it('任务对象缺字段时抛中文错误', () => {
    expect(() => parseContainerBuildTask({ id: 'x', slug: 'myapp', mode: 'compose', state: 'queued' })).toThrow(
      '构建任务响应无效',
    )
    expect(() =>
      parseContainerBuildTask({
        ...baseBuildTask,
        results: [{ target: 'web', repository: 'r', tag: 't', imageId: '', state: 'pending', error: '' }],
      }),
    ).toThrow('构建结果状态响应无效')
    expect(() => parseContainerBuildTask({ ...baseBuildTask, state: 'running' })).toThrow('构建任务状态响应无效')
  })
})

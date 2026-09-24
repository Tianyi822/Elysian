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

  it('watchLive 在 open 之前的 onerror 不上报 connecting', () => {
    FakeEventSource.reset()
    const statuses: Array<'live' | 'connecting'> = []
    const watchLive = createContainerWatchLive({ createEventSource: (url) => new FakeEventSource(url) })
    watchLive({ onStatus: (status) => statuses.push(status), onEvent: () => {} })
    FakeEventSource.latest()?.emitError()
    expect(statuses).toEqual(['connecting'])
  })

  it('未接入的方法统一抛固定中文', async () => {
    const adapter = createHttpContainersAdapter()
    await expect(adapter.requestAction('x', 'stop')).rejects.toThrow('容器管理的该操作尚未接入')
    await expect(adapter.create({ imageId: 'x', ports: [], env: [], volumes: [], restartPolicy: 'no' })).rejects.toThrow(
      '容器管理的该操作尚未接入',
    )
    await expect(adapter.removeImage('x')).rejects.toThrow('容器管理的该操作尚未接入')
    await expect(adapter.pullImage({ name: 'a', tag: 'b' })).rejects.toThrow('容器管理的该操作尚未接入')
    await expect(adapter.execMockCommand('x', 'help')).rejects.toThrow('容器管理的该操作尚未接入')
  })
})

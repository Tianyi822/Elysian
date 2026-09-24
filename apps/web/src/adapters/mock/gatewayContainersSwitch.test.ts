import { describe, expect, it, vi } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import { FakeEventSource } from '../../test/fakeEventSource'
import { createMockGateway } from './gateway'
import { MockContainerAdapter, MockFilesAdapter } from './mockAdapters'
import { MockTerminalAdapter } from './terminalAdapter'
import { useContainersStore } from '../../stores/containersStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'

describe('createMockGateway containers 可选片分流', () => {
  it('缺省与显式 mock 时 gateway.containers 是 MockContainerAdapter', () => {
    expect(createMockGateway({ eventStream: 'memory' }).containers).toBeInstanceOf(MockContainerAdapter)
    expect(
      createMockGateway({ eventStream: 'memory', containers: 'mock' }).containers,
    ).toBeInstanceOf(MockContainerAdapter)
  })

  it("containers: 'http' 时不是 MockContainerAdapter，且 list() 打到 /api/docker/containers", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ containers: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    expect(gateway.containers).not.toBeInstanceOf(MockContainerAdapter)
    await gateway.containers.list()
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', undefined)
    vi.unstubAllGlobals()
  })

  it("containers: 'http' 时 watchLive 事件进入 events.subscribe，onStatus 只写容器 store", () => {
    FakeEventSource.reset()
    vi.stubGlobal('EventSource', FakeEventSource)
    useContainersStore.setState({ liveStatus: 'live' })
    useEventStreamStore.setState({ status: 'live' })
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    const events: ElysianEvent[] = []
    const unsub = gateway.events.subscribe({
      onEvent: (event) => events.push(event),
      onStatus: () => {},
    })

    const source = FakeEventSource.latest()
    expect(source?.url).toBe('/api/docker/events')
    source?.emitOpen()

    const envelope = JSON.stringify({
      id: 'evt-docker-1',
      name: 'container/removed',
      at: '2026-09-12T08:00:00.000Z',
      payload: { containerId: 'abc' },
    })
    source?.emitRaw('container/removed', envelope)
    expect(events.some((e) => e.name === 'container/removed')).toBe(true)

    source?.emitError()
    expect(useContainersStore.getState().liveStatus).toBe('connecting')
    expect(useEventStreamStore.getState().status).toBe('live')

    unsub()
    vi.unstubAllGlobals()
  })

  it("containers: 'http' 不改变 files 与 terminals 的类型", () => {
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })
})

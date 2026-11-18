import { describe, expect, it, vi } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import { createMockGateway } from './gateway'
import { MockContainerAdapter, MockFilesAdapter } from './mockAdapters'
import { MockTerminalAdapter } from './terminalAdapter'

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
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', { signal: expect.any(AbortSignal) })
    vi.unstubAllGlobals()
  })

  it("containers: 'http' 时独立上报容器连接状态和事件", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(value) { controller = value },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    const events: ElysianEvent[] = []
    const onStatus = vi.fn()
    const onContainerStatus = vi.fn()
    const unsub = gateway.events.subscribe({
      onEvent: (event) => events.push(event),
      onStatus,
      onContainerStatus,
    })

    try {
      expect(fetchMock).toHaveBeenCalledWith('/api/docker/events', expect.objectContaining({ signal: expect.any(AbortSignal) }))
      await vi.waitFor(() => expect(onContainerStatus).toHaveBeenLastCalledWith('live'))
      const initialStatusCalls = onStatus.mock.calls.length
      const envelope = JSON.stringify({
        id: 'evt-docker-1',
        name: 'container/removed',
        at: '2026-09-12T08:00:00.000Z',
        payload: { containerId: 'abc' },
      })
      controller!.enqueue(new TextEncoder().encode(`event: container/removed\ndata: ${envelope}\n\n`))
      await vi.waitFor(() => expect(events.some((e) => e.name === 'container/removed')).toBe(true))

      controller!.enqueue(new TextEncoder().encode(': status connecting\n\n'))
      await vi.waitFor(() => expect(onContainerStatus).toHaveBeenLastCalledWith('connecting'))
      controller!.enqueue(new TextEncoder().encode(': status live\n\n'))
      await vi.waitFor(() => expect(onContainerStatus).toHaveBeenLastCalledWith('live'))
      expect(onStatus).toHaveBeenCalledTimes(initialStatusCalls)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      unsub()
      controller?.close()
      vi.unstubAllGlobals()
    }
  })

  it("containers: 'http' 不改变 files 与 terminals 的类型", () => {
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })
})

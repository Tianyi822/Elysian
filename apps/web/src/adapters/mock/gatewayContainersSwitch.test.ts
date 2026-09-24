import { describe, expect, it, vi } from 'vitest'
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
    expect(fetchMock).toHaveBeenCalledWith('/api/docker/containers', undefined)
    vi.unstubAllGlobals()
  })

  it("containers: 'http' 不改变 files 与 terminals 的类型", () => {
    const gateway = createMockGateway({ eventStream: 'memory', containers: 'http' })
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })
})

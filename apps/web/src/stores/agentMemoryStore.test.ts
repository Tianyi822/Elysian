import { memoryFixture } from '../test/memoryFixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import { useAgentMemoryStore } from './agentMemoryStore'
import { useSessionStore } from './sessionStore'

beforeEach(() => { useAgentMemoryStore.getState().reset(); useSessionStore.setState({ phase: 'authed', mode: 'demo' }) })
describe('Wiki 读取隔离', () => {
  it('首载失败可经同一入口重试，空空间列表也是成功快照', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const list = vi.spyOn(gateway.agentMemory, 'listSpaces')
      .mockRejectedValueOnce(new Error('空间暂不可用'))
      .mockResolvedValueOnce([])
    const listPages = vi.spyOn(gateway.agentMemory, 'listPages')
    const { load } = useAgentMemoryStore.getState()

    expect(useAgentMemoryStore.getState().status).toBe('idle')
    const first = load(gateway)
    expect(useAgentMemoryStore.getState().status).toBe('loading')
    await first
    expect(useAgentMemoryStore.getState()).toMatchObject({ status: 'error', errorMessage: '空间暂不可用' })
    await load(gateway)
    expect(list).toHaveBeenCalledTimes(2)
    expect(listPages).not.toHaveBeenCalled()
    expect(useAgentMemoryStore.getState()).toMatchObject({ status: 'ready', spaces: [], errorMessage: undefined })
  })

  it('登出立即清空内容，迟到请求不能回灌', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    let resolve!: (value: Awaited<ReturnType<typeof gateway.agentMemory.listSpaces>>) => void
    vi.spyOn(gateway.agentMemory, 'listSpaces').mockImplementation(() => new Promise(done => { resolve = done }))
    const request = useAgentMemoryStore.getState().load(gateway)
    useSessionStore.setState({ phase: 'anonymous' })
    resolve([{ id: 'private', revision: 1, name: '秘密空间', kind: 'business', createdAt: '' }]); await request
    expect(useAgentMemoryStore.getState()).toMatchObject({ spaces: [], pages: [], page: undefined, status: 'idle' })
  })
  it('切换空间使旧页面请求失效，刷新失败保留当前空间', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const fixture = memoryFixture(gateway.agentMemory)
    const space = await fixture.seedSpace({ name: 'New', kind: 'business' })
    const page = await fixture.seedPage(space.id, { slug: 'saved', title: '已读取页面', markdown: '正文' })
    const listSpaces = vi.spyOn(gateway.agentMemory, 'listSpaces')
    await useAgentMemoryStore.getState().load(gateway)
    let resolve!: (value: Awaited<ReturnType<typeof gateway.agentMemory.listPages>>) => void
    const original = gateway.agentMemory.listPages.bind(gateway.agentMemory)
    vi.spyOn(gateway.agentMemory, 'listPages').mockImplementation(id => id === 'wiki-global' ? new Promise(done => { resolve = done }) : original(id))
    const old = useAgentMemoryStore.getState().selectSpace(gateway, 'wiki-global')
    await useAgentMemoryStore.getState().selectSpace(gateway, space.id)
    resolve([]); await old
    expect(useAgentMemoryStore.getState()).toMatchObject({ spaceId: space.id, pages: [page], status: 'ready' })
    vi.spyOn(gateway.agentMemory, 'listPages').mockRejectedValue(new Error('页面暂不可用'))
    const refresh = useAgentMemoryStore.getState().load(gateway)
    expect(useAgentMemoryStore.getState()).toMatchObject({ status: 'ready', pages: [page] })
    await refresh
    expect(listSpaces).toHaveBeenCalledTimes(1)
    expect(useAgentMemoryStore.getState()).toMatchObject({ spaceId: space.id, pages: [page], errorMessage: '页面暂不可用', status: 'error' })
  })
})

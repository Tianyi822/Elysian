import { memoryFixture } from '../test/memoryFixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import { useAgentMemoryStore } from './agentMemoryStore'
import { useSessionStore } from './sessionStore'

beforeEach(() => { useAgentMemoryStore.getState().reset(); useSessionStore.setState({ phase: 'authed', mode: 'demo' }) })
describe('Wiki 读取隔离', () => {
  it('登出立即清空内容，迟到请求不能回灌', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    let resolve!: (value: Awaited<ReturnType<typeof gateway.agentMemory.listSpaces>>) => void
    vi.spyOn(gateway.agentMemory, 'listSpaces').mockImplementation(() => new Promise(done => { resolve = done }))
    const request = useAgentMemoryStore.getState().initialize(gateway)
    useSessionStore.setState({ phase: 'anonymous' })
    resolve([{ id: 'private', revision: 1, name: '秘密空间', kind: 'business', createdAt: '' }]); await request
    expect(useAgentMemoryStore.getState()).toMatchObject({ spaces: [], pages: [], page: undefined, loading: false })
  })
  it('切换空间使旧页面请求失效，刷新失败保留当前空间', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const space = await memoryFixture(gateway.agentMemory).seedSpace({ name: 'New', kind: 'business' })
    await useAgentMemoryStore.getState().initialize(gateway)
    let resolve!: (value: Awaited<ReturnType<typeof gateway.agentMemory.listPages>>) => void
    const original = gateway.agentMemory.listPages.bind(gateway.agentMemory)
    vi.spyOn(gateway.agentMemory, 'listPages').mockImplementation(id => id === 'wiki-global' ? new Promise(done => { resolve = done }) : original(id))
    const old = useAgentMemoryStore.getState().selectSpace(gateway, 'wiki-global')
    await useAgentMemoryStore.getState().selectSpace(gateway, space.id)
    resolve([]); await old
    expect(useAgentMemoryStore.getState().spaceId).toBe(space.id)
    vi.spyOn(gateway.agentMemory, 'listPages').mockRejectedValue(new Error('页面暂不可用'))
    await useAgentMemoryStore.getState().refresh(gateway)
    expect(useAgentMemoryStore.getState()).toMatchObject({ spaceId: space.id, pages: [], error: '页面暂不可用', loading: false })
  })

})

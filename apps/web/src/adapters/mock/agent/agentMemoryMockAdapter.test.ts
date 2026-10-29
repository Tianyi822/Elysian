import { describe, expect, it } from 'vitest'
import { AgentMemoryMockAdapter } from './agentMemoryMockAdapter'

describe('Wiki 本地文档演示', () => {
  it('人工编辑追加修订，旧修订保持不变并拒绝过期写入', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const first = await adapter.seedPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'one', maintenance: 'automatic' })
    const second = await adapter.updatePage(first.spaceId, first.id, { ...first, markdown: 'two', expectedRevision: 1, maintenance: 'manual' })
    expect(second).toMatchObject({ revision: 2, maintenance: 'manual' })
    await expect(adapter.updatePage(first.spaceId, first.id, { ...first, expectedRevision: 1 })).rejects.toThrow('修订')
    expect((await adapter.getRevision(first.spaceId, first.id, 1)).markdown).toBe('one')
    const restored = await adapter.updatePage(first.spaceId, first.id, { ...first, expectedRevision: 2, maintenance: 'manual' })
    expect(restored).toMatchObject({ revision: 3, markdown: 'one' })
    expect((await Promise.all([3, 2, 1].map(revision => adapter.getRevision(first.spaceId, first.id, revision)))).map(page => page.revision)).toEqual([3, 2, 1])
  })

})

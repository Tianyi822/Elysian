import { describe, expect, it } from 'vitest'
import { AgentMemoryMockAdapter } from './agentMemoryMockAdapter'
import { ModelSettingsMockAdapter } from './modelSettingsMockAdapter'

describe('Wiki 本地文档演示', () => {
  it('人工编辑与回退均追加修订，旧修订保持不变并拒绝过期写入', async () => {
    const adapter = new AgentMemoryMockAdapter(new ModelSettingsMockAdapter())
    const first = await adapter.createPage('wiki-global', { slug: 'guide', title: 'Guide', markdown: 'one', maintenance: 'automatic' })
    const second = await adapter.updatePage(first.spaceId, first.id, { ...first, markdown: 'two', expectedRevision: 1, maintenance: 'manual' })
    expect(second).toMatchObject({ revision: 2, maintenance: 'manual' })
    await expect(adapter.updatePage(first.spaceId, first.id, { ...first, expectedRevision: 1 })).rejects.toThrow('修订')
    expect((await adapter.getRevision(first.spaceId, first.id, 1)).markdown).toBe('one')
    const restored = await adapter.updatePage(first.spaceId, first.id, { ...first, expectedRevision: 2, maintenance: 'manual' })
    expect(restored).toMatchObject({ revision: 3, markdown: 'one' })
    expect((await adapter.listRevisions(first.spaceId, first.id)).map(page => page.revision)).toEqual([3, 2, 1])
  })
  it('资料原文保留且导入幂等，演示明确不生成整理内容', async () => {
    const models = new ModelSettingsMockAdapter(), adapter = new AgentMemoryMockAdapter(models)
    const model = (await models.listModelProfiles()).find(model => model.active && model.capabilities.text)!
    const input = { requestId: 'source-request', title: '原始资料', text: '原始内容', modelProfileId: model.id, modelProfileRevision: model.revision }
    const first = await adapter.importSource('wiki-global', input), second = await adapter.importSource('wiki-global', input)
    expect(first.source).toMatchObject({ markdown: '原始内容', kind: 'sources', maintenance: 'manual' })
    expect(second.source.id).toBe(first.source.id)
    expect(first.job).toMatchObject({ status: 'interrupted', publishedRefs: [], error: { code: 'demo-no-generation' } })
    expect(await adapter.listPages('wiki-global')).toHaveLength(1)
    await expect(adapter.updatePage('wiki-global', first.source.id, { ...first.source, markdown: '改写原文', expectedRevision: 1 })).rejects.toThrow('导入原文不可改写')
    await expect(adapter.importSource('wiki-global', { ...input, requestId: 'large', text: '汉'.repeat(5500) })).rejects.toThrow('16 KiB')
  })
})

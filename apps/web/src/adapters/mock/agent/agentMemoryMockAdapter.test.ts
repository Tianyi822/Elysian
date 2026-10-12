import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentMemoryAdapterContract } from '../../agentMemoryAdapterContract'
import { AgentMemoryMockAdapter, resetAgentMemoryData } from './agentMemoryMockAdapter'
import { MEMORY_SEED_BASE_MS, readAgentMemoryDataset, resetAgentMemoryData as resetDataset } from './agentMemoryData'

/*
 * mock 适配器测试：契约套件（与 HTTP 同一套断言）＋ mock 专属状态机断言——
 * 撤回传播 invalidated、提炼任务定时器推进（fake timers）、索引重建闭环、
 * 队列满 429。种子确定性由 agentMemoryData.test.ts 单独覆盖。
 */

beforeEach(() => {
  vi.useFakeTimers()
  resetAgentMemoryData()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AgentMemoryMockAdapter 契约', () => {
  runAgentMemoryAdapterContract('mock', () => {
    resetDataset()
    return new AgentMemoryMockAdapter()
  })
})

describe('AgentMemoryMockAdapter 状态机', () => {
  it('撤回来源页面：依赖它的 pending 候选被同事务标记 invalidated', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const before = await adapter.listProposals({ status: 'pending' })
    expect(before.some((proposal) => proposal.id === 'prop-1')).toBe(true)
    await adapter.withdrawPage('space-1', 'page-b', 1)
    const after = await adapter.listProposals({})
    const target = after.find((proposal) => proposal.id === 'prop-1')
    expect(target?.status).toBe('invalidated')
    await expect(adapter.decideProposal('prop-1', { decision: 'approved' }))
      .rejects.toThrow('候选来源已撤回，不能发布')
  })

  it('手工提炼：queued→running→succeeded 定时器推进，成功后产出候选', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const job = await adapter.createExtraction({ requestId: 'mock-ext-1', runId: 'run-seed-1' })
    expect(job.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(1_300)
    const running = await adapter.getExtraction(job.id)
    expect(running.status).toBe('running')
    await vi.advanceTimersByTimeAsync(1_300)
    const done = await adapter.getExtraction(job.id)
    expect(done.status).toBe('succeeded')
    expect(done.memoryStatus).toBe('updated')
    expect(done.candidateIds.length).toBe(1)
    const pending = await adapter.listProposals({ status: 'pending' })
    expect(pending.some((proposal) => proposal.id === done.candidateIds[0])).toBe(true)
  })

  it('队列满 32 个排队任务后拒绝（中文 429 语义文案）', async () => {
    const adapter = new AgentMemoryMockAdapter()
    for (let index = 0; index < 32; index += 1) {
      await adapter.createExtraction({ requestId: `mock-queue-${index}`, runId: 'run-seed-1' })
    }
    await expect(adapter.createExtraction({ requestId: 'mock-queue-overflow', runId: 'run-seed-1' }))
      .rejects.toThrow('长期记忆后台任务队列已满')
  })

  it('索引重建闭环：stale→重建任务推进→回读 ready，搜索转为 hybrid-rrf', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const before = await adapter.indexStatus('space-1')
    expect(before.length).toBe(2)
    expect(before.every((row) => row.status === 'stale')).toBe(true)
    const job = await adapter.rebuildIndex('space-1', { requestId: 'mock-index-1', profileId: 'emb-1', profileRevision: 2 })
    expect(job.kind).toBe('embedding')
    await vi.advanceTimersByTimeAsync(2_600)
    const done = await adapter.getExtraction(job.id)
    expect(done.status).toBe('succeeded')
    const after = await adapter.indexStatus('space-1')
    expect(after.find((row) => row.profile.id === 'emb-1')?.status).toBe('ready')
    expect(after.find((row) => row.profile.id === 'emb-2')?.status).toBe('stale')
    const search = await adapter.search('space-1', '端口 映射')
    expect(search.degraded).toBe(false)
    expect(search.items.every((hit) => hit.method === 'hybrid-rrf')).toBe(true)
  })

  it('零配置与单配置空间的索引状态：空数组与单行', async () => {
    const dataset = readAgentMemoryDataset()
    dataset.embeddingProfiles = []
    const empty = await new AgentMemoryMockAdapter().indexStatus('space-1')
    expect(empty).toEqual([])
    dataset.embeddingProfiles = [{ id: 'emb-single', revision: 1, name: '唯一配置', baseUrl: 'https://embedding.example.test/v1', model: 'm', dimensions: 8, active: true, hasCredential: false }]
    // 种子里 space-1 有 3 个 active 页面（page-a2/page-b/page-d），全部建满即 ready。
    dataset.indexedPages.set('space-1:emb-single', 3)
    const single = await new AgentMemoryMockAdapter().indexStatus('space-1')
    expect(single).toHaveLength(1)
    expect(single[0]?.status).toBe('ready')
    expect(single[0]?.pages).toBeGreaterThan(0)
    expect(single[0]?.indexedPages).toBe(single[0]?.pages)
  })

  it('重复建全局空间透传 409 wiki-global-exists 中文文案', async () => {
    const adapter = new AgentMemoryMockAdapter()
    await expect(adapter.createSpace({ name: '另一个全局', kind: 'global' }))
      .rejects.toThrow('全局 Wiki 空间已存在')
  })

  it('种子基准时间不被系统时钟影响：撤回页的有效期判定确定性', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const report = await adapter.checkSpace('space-1')
    expect(report.expiredPages).toContain('observation/backup-window')
    expect(readAgentMemoryDataset().sequence).toBeGreaterThan(0)
    expect(MEMORY_SEED_BASE_MS).toBe(Date.parse('2026-10-10T00:00:00Z'))
  })
})

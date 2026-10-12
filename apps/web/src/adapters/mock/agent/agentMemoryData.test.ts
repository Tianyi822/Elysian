import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_SEED_BASE_MS,
  memoryDigest,
  nextMemoryId,
  nextMemoryStamp,
  readAgentMemoryDataset,
  resetAgentMemoryData,
  scheduleMemoryTimer,
} from './agentMemoryData'

/*
 * 演示数据集的确定性断言：同序号操作得到同一 ID/时间戳/摘要，reset 清掉
 * 后台定时器并回到种子。不依赖当前时钟（种子相对固定基准生成）。
 */

describe('agentMemoryData 确定性', () => {
  it('种子结构齐全：两空间、多页面修订、三候选、三任务、两向量配置', () => {
    resetAgentMemoryData()
    const dataset = readAgentMemoryDataset()
    expect(dataset.spaces.map((space) => space.id)).toEqual(['space-global', 'space-1'])
    expect(dataset.spaces.filter((space) => space.kind === 'global')).toHaveLength(1)
    expect(dataset.pages.filter((page) => page.spaceId === 'space-1').length).toBe(4)
    expect(dataset.pageRevisions.get('page-a:1')?.markdown).not.toContain('观察五分钟')
    expect(dataset.pageRevisions.get('page-a:2')?.markdown).toContain('观察五分钟')
    expect(dataset.proposals.map((proposal) => proposal.id)).toEqual(['prop-1', 'prop-2', 'prop-3'])
    expect(dataset.jobs.map((job) => job.id)).toEqual(['ext-1', 'ext-2', 'ext-3'])
    expect(dataset.jobs.map((job) => job.status)).toEqual(['succeeded', 'failed', 'interrupted'])
    expect(dataset.embeddingProfiles.map((profile) => profile.id)).toEqual(['emb-1', 'emb-2'])
    expect(dataset.embeddingRequests).toHaveLength(3)
  })

  it('摘要与 ID/时间戳对同一输入恒定，reset 后回到种子', () => {
    resetAgentMemoryData()
    const first = {
      digest: memoryDigest('标题', '正文'),
      id: nextMemoryId(readAgentMemoryDataset(), 'page'),
      stamp: nextMemoryStamp(),
    }
    const second = {
      digest: memoryDigest('标题', '正文'),
      id: nextMemoryId(readAgentMemoryDataset(), 'page'),
      stamp: nextMemoryStamp(),
    }
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toHaveLength(64)
    expect(first.id).not.toBe(second.id)
    expect(first.stamp).not.toBe(second.stamp)
    // 种子自身把序号推进到 20；reset 回到种子后，下一个动态 ID 从 21 起算。
    resetAgentMemoryData()
    const dataset = readAgentMemoryDataset()
    expect(dataset.sequence).toBe(20)
    expect(nextMemoryId(dataset, 'page')).toBe('page-121')
    expect(nextMemoryStamp()).toBe(new Date(MEMORY_SEED_BASE_MS + 21 * 7_000).toISOString())
  })

  it('reset 清掉未触发的后台定时器', () => {
    vi.useFakeTimers()
    try {
      resetAgentMemoryData()
      const fired = vi.fn()
      scheduleMemoryTimer(fired, 1_000)
      resetAgentMemoryData()
      vi.advanceTimersByTime(2_000)
      expect(fired).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('种子候选的依赖关系：prop-1 的来源指向 page-b（撤回传播的依据）', () => {
    resetAgentMemoryData()
    const dataset = readAgentMemoryDataset()
    const prop1 = dataset.proposals.find((proposal) => proposal.id === 'prop-1')
    expect((prop1?.page.sources ?? []).some((source) => source.pageId === 'page-b')).toBe(true)
  })
})

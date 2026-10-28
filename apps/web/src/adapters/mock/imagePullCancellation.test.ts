import { describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'

describe('演示镜像拉取的停止行为', () => {
  it.each(['downloading', 'finalizing'])('在 %s 阶段停止后不生成镜像', async (phase) => {
    vi.useFakeTimers()
    try {
      const adapter = createMockGateway({ eventStream: 'memory' }).containers
      const before = await adapter.listImages()
      const controller = new AbortController()
      const pending = adapter.pullImage({ name: `cancel-${phase}`, tag: 'latest' }, (progress) => {
        if (progress.phase === phase) controller.abort()
      }, controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
      expect(await adapter.listImages()).toEqual(before)
    } finally { vi.useRealTimers() }
  })
})

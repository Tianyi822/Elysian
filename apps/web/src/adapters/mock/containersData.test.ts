import { describe, expect, it } from 'vitest'
import { CONTAINERS, initialContainerUsage, walkContainerUsage } from './containersData'

describe('容器采样游走', () => {
  it('初始占用只含运行中容器', () => {
    const usage = initialContainerUsage()
    const runningIds = CONTAINERS.filter((c) => c.status === 'running').map((c) => c.id)
    expect(usage.map((u) => u.containerId).sort()).toEqual([...runningIds].sort())
  })

  it('游走只产生运行中容器的采样，数值始终在界内', () => {
    let prev = initialContainerUsage()
    for (let i = 0; i < 200; i += 1) {
      prev = walkContainerUsage(prev, CONTAINERS)
      for (const sample of prev) {
        expect(sample.cpuPercent).toBeGreaterThanOrEqual(2)
        expect(sample.cpuPercent).toBeLessThanOrEqual(95)
        expect(sample.memMb).toBeGreaterThanOrEqual(128)
        expect(sample.memMb).toBeLessThanOrEqual(4096)
      }
      expect(prev.some((u) => u.containerId === 'ctr-backup-agent')).toBe(false)
    }
  })
})

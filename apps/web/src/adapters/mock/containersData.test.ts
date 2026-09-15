import { describe, expect, it } from 'vitest'
import { CONTAINERS, initialContainerUsage, mockImageArtifact, walkContainerUsage } from './containersData'

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

describe('拉取镜像的确定性产物', () => {
  it('同一引用永远得到同一摘要与体积，不同引用彼此不同', () => {
    const first = mockImageArtifact('redis', '8-alpine')
    const second = mockImageArtifact('redis', '8-alpine')
    expect(first).toEqual(second)
    expect(mockImageArtifact('redis', '7.4').digest).not.toBe(first.digest)
  })

  it('摘要形如 12 位十六进制的 sha256，体积在 8-455 MB 界内', () => {
    const references: ReadonlyArray<readonly [string, string]> = [
      ['redis', 'latest'],
      ['grafana/grafana', '11'],
      ['a', 'b'],
    ]
    for (const [name, tag] of references) {
      const artifact = mockImageArtifact(name, tag)
      expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{12}$/)
      expect(artifact.sizeMb).toBeGreaterThanOrEqual(8)
      expect(artifact.sizeMb).toBeLessThanOrEqual(455)
    }
  })
})

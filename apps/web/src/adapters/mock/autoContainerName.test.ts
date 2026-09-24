import { describe, expect, it } from 'vitest'
import { autoContainerName } from '@elysian/contracts'

describe('autoContainerName（契约导出）', () => {
  it('grafana/grafana → grafana-grafana', () => {
    expect(autoContainerName([], 'grafana/grafana')).toBe('grafana-grafana')
  })

  it('名称冲突时从 -2 起递增', () => {
    expect(autoContainerName([{ name: 'redis' }], 'redis')).toBe('redis-2')
  })
})

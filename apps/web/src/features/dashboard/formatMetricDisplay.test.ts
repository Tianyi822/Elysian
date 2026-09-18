import { describe, expect, it } from 'vitest'
import {
  formatResourceMetricValue,
  formatThroughputFromMbps,
  mbpsToUnit,
  pickThroughputUnit,
} from './formatMetricDisplay'

describe('formatThroughputFromMbps', () => {
  it('极小吞吐显示为 B/s', () => {
    expect(formatThroughputFromMbps(0.000248)).toMatch(/B\/s$/)
    expect(formatThroughputFromMbps(0.000248)).not.toContain('MB/s')
  })

  it('中等吞吐显示为 KB/s', () => {
    expect(formatThroughputFromMbps(0.054)).toMatch(/KB\/s$/)
  })

  it('接近 1 MB/s 仍可用 MB/s', () => {
    expect(formatThroughputFromMbps(1.5)).toMatch(/MB\/s$/)
  })

  it('很大吞吐升到 GB/s', () => {
    expect(formatThroughputFromMbps(2048)).toMatch(/GB\/s$/)
  })
})

describe('pickThroughputUnit / mbpsToUnit', () => {
  it('按峰值选单位并换算', () => {
    expect(pickThroughputUnit([0.0001, 0.0002])).toBe('B/s')
    expect(mbpsToUnit(1, 'MB/s')).toBeCloseTo(1)
    expect(mbpsToUnit(1, 'KB/s')).toBeCloseTo(1024)
  })
})

describe('formatResourceMetricValue', () => {
  it('百分比与吞吐分支', () => {
    expect(formatResourceMetricValue(29.4, '%')).toBe('29.4%')
    expect(formatResourceMetricValue(0.05, 'MB/s')).toMatch(/KB\/s$/)
  })
})

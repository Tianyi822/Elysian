import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIME_RANGE,
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  TIME_RANGE_LABELS,
  TIME_RANGES,
  timeRangeDurationMs,
  timeRangeGranularity,
  timeRangeGranularityLabel,
  type ResourceMetricKey,
} from './resourceMetrics'

describe('TimeRange', () => {
  it('默认与枚举完整', () => {
    expect(DEFAULT_TIME_RANGE).toBe('5m')
    expect([...TIME_RANGES]).toEqual(['5m', '30m', '1h', '5h', '7d'])
    expect(TIME_RANGE_LABELS['5m']).toBe('近 5 分钟')
    expect(TIME_RANGE_LABELS['7d']).toBe('近 7 天')
    expect(TIME_RANGE_LABELS).not.toHaveProperty('10m')
    expect(TIME_RANGE_LABELS).not.toHaveProperty('10h')
    expect(TIME_RANGE_LABELS).not.toHaveProperty('30d')
  })

  it('窗长与粒度', () => {
    expect(timeRangeDurationMs('5m')).toBe(5 * 60_000)
    expect(timeRangeDurationMs('1h')).toBe(3_600_000)
    expect(timeRangeDurationMs('7d')).toBe(7 * 86_400_000)
    expect(timeRangeGranularity('5m')).toBe('5s')
    expect(timeRangeGranularity('1h')).toBe('5s')
    expect(timeRangeGranularity('5h')).toBe('1m')
    expect(timeRangeGranularityLabel('30m')).toBe('按 5 秒')
    expect(timeRangeGranularityLabel('7d')).toBe('按 1 分钟')
  })
})

describe('资源指标中文标签与单位', () => {
  it('四个指标的标签与单位表完整，取值非空', () => {
    const keys: ResourceMetricKey[] = ['cpu', 'memory', 'networkIo', 'diskIo']
    expect(Object.keys(RESOURCE_METRIC_LABELS)).toEqual(keys)
    expect(Object.keys(RESOURCE_METRIC_UNITS)).toEqual(keys)
    for (const key of keys) {
      expect(RESOURCE_METRIC_LABELS[key].length).toBeGreaterThan(0)
      expect(RESOURCE_METRIC_UNITS[key].length).toBeGreaterThan(0)
    }
  })
})

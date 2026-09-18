import { afterEach, describe, expect, it } from 'vitest'
import { BASE_DATE } from './dataset'
import {
  appendLiveResourceSample,
  appendMockSample,
  createResourceMetrics,
  DEFAULT_TIME_RANGE,
  getLiveResources,
  listMockHistory,
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  resetLiveResources,
  resetMockHistory,
  sliceResourceMetrics,
  TIME_RANGE_LABELS,
  TIME_RANGES,
  timeRangeDurationMs,
  timeRangeGranularity,
  timeRangeGranularityLabel,
} from './resourceMetrics'
import type { ResourceMetricKey } from './resourceMetrics'

describe('资源指标时序 mock', () => {
  const metrics = createResourceMetrics()

  it('生成基准时刻之前 30 天的按天序列，日期连续且止于基准日', () => {
    expect(metrics).toHaveLength(30)
    expect(metrics[metrics.length - 1]?.date).toBe(BASE_DATE)

    for (let index = 1; index < metrics.length; index += 1) {
      const previous = Date.parse(metrics[index - 1]?.date ?? '')
      const current = Date.parse(metrics[index]?.date ?? '')
      expect(current - previous).toBe(86_400_000)
    }
  })

  it('CPU 与内存是合理区间的百分比，网络与磁盘 IO 是正的吞吐值', () => {
    for (const day of metrics) {
      expect(day.cpu).toBeGreaterThanOrEqual(25)
      expect(day.cpu).toBeLessThanOrEqual(95)
      expect(day.memory).toBeGreaterThanOrEqual(45)
      expect(day.memory).toBeLessThanOrEqual(95)
      expect(day.networkIo).toBeGreaterThan(0)
      expect(day.diskIo).toBeGreaterThan(0)
      expect(Number.isInteger(day.cpu)).toBe(true)
      expect(Number.isInteger(day.memory)).toBe(true)
      expect(Number.isInteger(day.networkIo)).toBe(true)
      expect(Number.isInteger(day.diskIo)).toBe(true)
    }
  })

  it('同一种子两次生成逐字段一致，时间范围切换不引入随机性', () => {
    expect(createResourceMetrics()).toEqual(metrics)
  })

  it('按时间范围切片：近 7 天取最后 7 天', () => {
    const week = sliceResourceMetrics(metrics, '7d')
    expect(week).toHaveLength(7)
    expect(week).toEqual(metrics.slice(-7))
  })
})

describe('ResourceSamplePoint 分层历史', () => {
  afterEach(() => {
    resetMockHistory()
  })

  it('短窗返回 5s 点，长窗返回 1m 点', () => {
    resetMockHistory()
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 40; i += 1) {
      appendMockSample({
        ts: t0 + i * 5_000,
        cpu: 10 + i,
        memory: 50,
        networkIo: 100,
        diskIo: 80,
      })
    }
    const short = listMockHistory('5m', t0 + 39 * 5_000)
    expect(short.length).toBeGreaterThan(0)
    expect(
      short.every(
        (p, idx, arr) =>
          idx === 0 || p.ts - arr[idx - 1]!.ts === 5_000 || p.ts >= arr[idx - 1]!.ts,
      ),
    ).toBe(true)

    resetMockHistory()
    for (let m = 0; m < 120; m += 1) {
      appendMockSample({
        ts: t0 + m * 60_000,
        cpu: m % 50,
        memory: 40,
        networkIo: 10,
        diskIo: 10,
      })
    }
    const long = listMockHistory('5h', t0 + 119 * 60_000)
    expect(long.length).toBeGreaterThan(0)
    expect(timeRangeGranularity('5h')).toBe('1m')
  })
})

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

describe('资源指标实时叠加层', () => {
  afterEach(() => {
    resetLiveResources()
  })

  it('未叠加时实时序列就是种子序列', () => {
    expect(getLiveResources()).toEqual(createResourceMetrics())
  })

  it('采样追加到序列尾并保持 30 个点滚动窗口', () => {
    const sample = { cpu: 66, memory: 77, networkIo: 300, diskIo: 200 }
    const appended = appendLiveResourceSample(sample)

    expect(appended).toHaveLength(30)
    const last = appended[appended.length - 1]
    expect(last?.cpu).toBe(66)
    expect(last?.memory).toBe(77)
    expect(last?.networkIo).toBe(300)
    expect(last?.diskIo).toBe(200)
    // 日期接在原序列最后一天之后，保持连续
    const beforeLast = appended[appended.length - 2]
    expect(Date.parse(last?.date ?? '') - Date.parse(beforeLast?.date ?? '')).toBe(86_400_000)
  })

  it('连续采样滚动掉最老的一天，返回同一份序列引用', () => {
    const before = getLiveResources()[0]
    appendLiveResourceSample({ cpu: 50, memory: 50, networkIo: 100, diskIo: 100 })
    appendLiveResourceSample({ cpu: 51, memory: 51, networkIo: 110, diskIo: 101 })

    const after = getLiveResources()
    expect(after).toHaveLength(30)
    expect(after[0]?.cpu).not.toBe(before?.cpu)
    expect(after[after.length - 1]?.cpu).toBe(51)
  })
})

import { describe, expect, it } from 'vitest'
import { BASE_DATE } from './timeseries'
import {
  createResourceMetrics,
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  sliceResourceMetrics,
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

  it('按时间范围切片：近 7 天取最后 7 天，近 30 天取全量', () => {
    const week = sliceResourceMetrics(metrics, '7d')
    expect(week).toHaveLength(7)
    expect(week).toEqual(metrics.slice(-7))
    expect(sliceResourceMetrics(metrics, '30d')).toEqual(metrics)
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

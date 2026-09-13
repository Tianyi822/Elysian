import { describe, expect, it } from 'vitest'
import { BASE_DATE, TREND_DAYS, createIncidentTrend, dailyTotal, sliceTrend } from './timeseries'

describe('确定性时序 mock', () => {
  it('两次构建结果完全一致', () => {
    expect(createIncidentTrend()).toEqual(createIncidentTrend())
  })

  it('覆盖 30 天：最早一天是基准前 29 天，最后一天就是基准日', () => {
    const trend = createIncidentTrend()
    expect(trend).toHaveLength(TREND_DAYS)
    expect(trend[0]?.date).toBe('2026-08-14')
    expect(trend[TREND_DAYS - 1]?.date).toBe(BASE_DATE)
    expect(BASE_DATE).toBe('2026-09-12')
  })

  it('每天至少有一些事故，30 天里四档严重等级都出现过', () => {
    const trend = createIncidentTrend()
    for (const day of trend) {
      expect(dailyTotal(day)).toBeGreaterThan(0)
    }
    for (const key of ['sev1', 'sev2', 'sev3', 'sev4'] as const) {
      expect(trend.reduce((sum, day) => sum + day[key], 0)).toBeGreaterThan(0)
    }
  })

  it('日期严格递增且不重复', () => {
    const trend = createIncidentTrend()
    for (let index = 1; index < trend.length; index += 1) {
      const previous = trend[index - 1]
      const current = trend[index]
      expect(previous && current && previous.date < current.date).toBe(true)
    }
  })
})

describe('时间范围切片', () => {
  const trend = createIncidentTrend()

  it('近 7 天取最后 7 天，仍按时间正序', () => {
    const week = sliceTrend(trend, '7d')
    expect(week).toHaveLength(7)
    expect(week[0]?.date).toBe(trend[TREND_DAYS - 7]?.date)
    expect(week[6]?.date).toBe(BASE_DATE)
  })

  it('近 30 天就是全量', () => {
    expect(sliceTrend(trend, '30d')).toEqual(trend)
  })

  it('切片不修改原序列', () => {
    const before = JSON.stringify(trend)
    sliceTrend(trend, '7d')
    expect(JSON.stringify(trend)).toBe(before)
  })
})

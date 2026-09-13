import type { Severity } from '@elysian/contracts'
import { DATASET_BASE_TIME, DATASET_SEED } from './dataset'
import { createRandom, intBetween } from './seed'

/**
 * 确定性时序 mock：基准时刻之前 30 天的每日新增事故序列，按四档严重等级分档。
 *
 * 它与事故快照（dataset.ts）是两份数据：快照是「当前时点的存量」，
 * 时序是「过去 30 天的每日流量」，用于仪表盘的趋势折线图。
 * 日期相对基准时刻推导，测试不依赖当前时钟。
 */

export const TREND_DAYS = 30

export type DailyIncidents = {
  /** ISO 日期（YYYY-MM-DD）。 */
  date: string
  sev1: number
  sev2: number
  sev3: number
  sev4: number
}

export function dailyTotal(day: DailyIncidents): number {
  return day.sev1 + day.sev2 + day.sev3 + day.sev4
}

/** 基准时刻的 ISO 日期（YYYY-MM-DD）。「今日」在演示数据里就是这个日期。 */
export const BASE_DATE = DATASET_BASE_TIME.slice(0, 10)

export function createIncidentTrend(): DailyIncidents[] {
  // 种子与数据集错开，避免两份数据的随机序列耦合。
  const rnd = createRandom(DATASET_SEED + 1)
  const baseMs = Date.parse(DATASET_BASE_TIME)
  const days: DailyIncidents[] = []

  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(baseMs - offset * 86_400_000).toISOString().slice(0, 10)
    days.push({
      date,
      sev1: intBetween(rnd, 0, 2),
      sev2: intBetween(rnd, 1, 5),
      sev3: intBetween(rnd, 2, 8),
      sev4: intBetween(rnd, 1, 6),
    })
  }

  return days
}

export type TimeRange = '7d' | '30d'

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
}

/** 按时间范围取最近 N 天，返回仍按时间正序排列的切片。 */
export function sliceTrend(trend: readonly DailyIncidents[], range: TimeRange): DailyIncidents[] {
  const days = range === '7d' ? 7 : 30
  return trend.slice(-days)
}

/** 严重等级的数值字段名，供图表系列遍历。 */
export const SEVERITY_KEYS = ['sev1', 'sev2', 'sev3', 'sev4'] as const satisfies readonly [
  Severity,
  Severity,
  Severity,
  Severity,
]

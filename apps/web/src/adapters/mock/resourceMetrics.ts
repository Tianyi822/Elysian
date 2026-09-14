import { DATASET_BASE_TIME, DATASET_SEED } from './dataset'
import { createRandom, intBetween } from './seed.ts'

/**
 * 单机资源指标（CPU、内存、网络 IO、磁盘 IO）的确定性时序 mock。
 *
 * 与事故时序（timeseries.ts）同构：固定种子、基准时刻之前 30 天、按天一个点，
 * 日期相对基准时刻推导，测试不依赖当前时钟。种子再错开一位，避免随机序列耦合。
 */

export type ResourceMetricKey = 'cpu' | 'memory' | 'networkIo' | 'diskIo'

/** 资源序列与事故时序共用 30 天窗口。 */
export const TREND_DAYS = 30

export type TimeRange = '7d' | '30d'

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
}

export type DailyResourceMetrics = {
  /** ISO 日期（YYYY-MM-DD）。 */
  date: string
  /** CPU 使用率（%）。 */
  cpu: number
  /** 内存占用率（%）。 */
  memory: number
  /** 网络 IO 吞吐（MB/s，当日均值）。 */
  networkIo: number
  /** 磁盘 IO 吞吐（MB/s，当日均值）。 */
  diskIo: number
}

export const RESOURCE_METRIC_LABELS: Record<ResourceMetricKey, string> = {
  cpu: 'CPU 使用率',
  memory: '内存占用率',
  networkIo: '网络 IO',
  diskIo: '磁盘 IO',
}

export const RESOURCE_METRIC_UNITS: Record<ResourceMetricKey, string> = {
  cpu: '%',
  memory: '%',
  networkIo: 'MB/s',
  diskIo: 'MB/s',
}

export function createResourceMetrics(): DailyResourceMetrics[] {
  const rnd = createRandom(DATASET_SEED + 2)
  const baseMs = Date.parse(DATASET_BASE_TIME)
  const days: DailyResourceMetrics[] = []

  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(baseMs - offset * 86_400_000).toISOString().slice(0, 10)
    days.push({
      date,
      cpu: intBetween(rnd, 30, 85),
      memory: intBetween(rnd, 50, 90),
      networkIo: intBetween(rnd, 80, 900),
      diskIo: intBetween(rnd, 60, 500),
    })
  }

  return days
}

/** 按时间范围取最近 N 天，返回仍按时间正序排列的切片。 */
export function sliceResourceMetrics(
  metrics: readonly DailyResourceMetrics[],
  range: TimeRange,
): DailyResourceMetrics[] {
  const count = range === '7d' ? 7 : 30
  return metrics.slice(-count)
}

/*
 * 实时叠加层：事件流的采样回灌到序列尾部并滚动掉最老的一天，
 * 让资源卡与资源图表随事件流动起来。种子函数保持纯函数。
 */

/** 系统负载（load average，1/5/15 分钟均值）与磁盘占用（按挂载点）的 mock 形状。 */
export type SystemLoad = { m1: number; m5: number; m15: number }
export type DiskUsage = { mount: string; usagePct: number }

export const INITIAL_LOAD: SystemLoad = { m1: 0.16, m5: 0.09, m15: 0.05 }
export const INITIAL_DISKS: DiskUsage[] = [
  { mount: '/', usagePct: 62 },
  { mount: '/data', usagePct: 78 },
  { mount: '/backup', usagePct: 41 },
]

const clampValue = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** 负载随机游走：1 分钟窗口动得最快，15 分钟几乎不动（贴近真实 load average 的惯性）。 */
export function nextLoadWalk(load: SystemLoad): SystemLoad {
  const drift = (value: number, delta: number): number =>
    Math.round(clampValue(value + (Math.random() - 0.5) * 2 * delta, 0.02, 2.5) * 100) / 100
  return { m1: drift(load.m1, 0.06), m5: drift(load.m5, 0.03), m15: drift(load.m15, 0.015) }
}

/** 磁盘占用随机游走：真实磁盘变化很慢，漂移压在 0.1% 量级。 */
export function nextDisksWalk(disks: readonly DiskUsage[]): DiskUsage[] {
  return disks.map((disk) => ({
    ...disk,
    usagePct: Math.round(clampValue(disk.usagePct + (Math.random() - 0.5) * 0.2, 5, 95) * 10) / 10,
  }))
}

let liveResources: DailyResourceMetrics[] | undefined

/** 当前生效的资源序列：有实时采样时返回实时序列，否则返回种子序列。 */
export function getLiveResources(): DailyResourceMetrics[] {
  if (!liveResources) liveResources = createResourceMetrics()
  return liveResources
}

/** 实时采样：追加到序列尾并保持 30 个点的滚动窗口。 */
export function appendLiveResourceSample(
  sample: Omit<DailyResourceMetrics, 'date'>,
): DailyResourceMetrics[] {
  const series = getLiveResources()
  const last = series[series.length - 1]
  const nextDateMs = Date.parse((last ?? { date: DATASET_BASE_TIME.slice(0, 10) }).date) + 86_400_000
  series.push({ date: new Date(nextDateMs).toISOString().slice(0, 10), ...sample })
  if (series.length > TREND_DAYS) series.shift()
  return series
}

/** 测试辅助：清掉实时叠加，回到纯种子序列。 */
export function resetLiveResources(): void {
  liveResources = undefined
}

import { DATASET_BASE_TIME, DATASET_SEED } from './dataset.ts'
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

export type TimeRange = '5m' | '10m' | '30m' | '1h' | '5h' | '10h' | '7d'

export const TIME_RANGES: readonly TimeRange[] = [
  '5m',
  '10m',
  '30m',
  '1h',
  '5h',
  '10h',
  '7d',
]

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '5m': '近 5 分钟',
  '10m': '近 10 分钟',
  '30m': '近 30 分钟',
  '1h': '近 1 小时',
  '5h': '近 5 小时',
  '10h': '近 10 小时',
  '7d': '近 7 天',
}

export const DEFAULT_TIME_RANGE: TimeRange = '5m'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** 时间范围对应的回看窗长（毫秒）。 */
export function timeRangeDurationMs(range: TimeRange): number {
  switch (range) {
    case '5m':
      return 5 * MS_PER_MINUTE
    case '10m':
      return 10 * MS_PER_MINUTE
    case '30m':
      return 30 * MS_PER_MINUTE
    case '1h':
      return MS_PER_HOUR
    case '5h':
      return 5 * MS_PER_HOUR
    case '10h':
      return 10 * MS_PER_HOUR
    case '7d':
      return 7 * MS_PER_DAY
  }
}

export type ResourceGranularity = '3s' | '1m'

/** 时间范围对应的采样粒度：窗长不超过 1 小时按 3 秒，否则按 1 分钟。 */
export function timeRangeGranularity(range: TimeRange): ResourceGranularity {
  return timeRangeDurationMs(range) <= MS_PER_HOUR ? '3s' : '1m'
}

/** 采样粒度的中文展示文案。 */
export function timeRangeGranularityLabel(range: TimeRange): string {
  return timeRangeGranularity(range) === '3s' ? '按 3 秒' : '按 1 分钟'
}

/** 资源采样点：毫秒时间戳为横轴。 */
export type ResourceSamplePoint = {
  ts: number
  cpu: number
  memory: number
  networkIo: number
  diskIo: number
}

const RAW_RETENTION_MS = MS_PER_HOUR
const MINUTE_RETENTION_MS = 7 * MS_PER_DAY

let rawPoints: ResourceSamplePoint[] = []
let minutePoints: ResourceSamplePoint[] = []

type MinuteBucket = {
  minuteStart: number
  count: number
  cpu: number
  memory: number
  networkIo: number
  diskIo: number
}

let openMinuteBucket: MinuteBucket | null = null

function minuteStartMs(ts: number): number {
  return Math.floor(ts / MS_PER_MINUTE) * MS_PER_MINUTE
}

function flushOpenMinuteBucket(): void {
  if (!openMinuteBucket || openMinuteBucket.count === 0) return
  const { minuteStart, count, cpu, memory, networkIo, diskIo } = openMinuteBucket
  minutePoints.push({
    ts: minuteStart,
    cpu: cpu / count,
    memory: memory / count,
    networkIo: networkIo / count,
    diskIo: diskIo / count,
  })
  openMinuteBucket = null
}

function absorbIntoMinuteBucket(point: ResourceSamplePoint): void {
  const start = minuteStartMs(point.ts)
  if (openMinuteBucket && openMinuteBucket.minuteStart !== start) {
    flushOpenMinuteBucket()
  }
  if (!openMinuteBucket) {
    openMinuteBucket = {
      minuteStart: start,
      count: 0,
      cpu: 0,
      memory: 0,
      networkIo: 0,
      diskIo: 0,
    }
  }
  openMinuteBucket.count += 1
  openMinuteBucket.cpu += point.cpu
  openMinuteBucket.memory += point.memory
  openMinuteBucket.networkIo += point.networkIo
  openMinuteBucket.diskIo += point.diskIo
}

function evictMockHistory(refMs: number): void {
  const rawCutoff = refMs - RAW_RETENTION_MS
  const minuteCutoff = refMs - MINUTE_RETENTION_MS
  rawPoints = rawPoints.filter((p) => p.ts >= rawCutoff)
  minutePoints = minutePoints.filter((p) => p.ts >= minuteCutoff)
}

/** 写入 raw 环；跨分钟边界时聚合成 1m 点；淘汰超龄数据。 */
export function appendMockSample(point: ResourceSamplePoint, nowMs?: number): void {
  const refMs = nowMs ?? point.ts
  absorbIntoMinuteBucket(point)
  rawPoints.push(point)
  evictMockHistory(refMs)
}

/** 从内存缓冲取 `[nowMs - duration, nowMs]` 内的点。 */
export function listMockHistory(range: TimeRange, nowMs: number): ResourceSamplePoint[] {
  const granularity = timeRangeGranularity(range)
  const windowStart = nowMs - timeRangeDurationMs(range)
  const inWindow = (p: ResourceSamplePoint) => p.ts >= windowStart && p.ts <= nowMs

  if (granularity === '3s') {
    return rawPoints.filter(inWindow)
  }

  const fromMinute = minutePoints.filter(inWindow)
  if (fromMinute.length > 0) return fromMinute

  // 长窗尚无 1m 聚合时，用 raw 按分钟降采样兜底
  const byMinute = new Map<number, ResourceSamplePoint[]>()
  for (const p of rawPoints.filter(inWindow)) {
    const key = minuteStartMs(p.ts)
    const list = byMinute.get(key) ?? []
    list.push(p)
    byMinute.set(key, list)
  }
  return [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, points]) => {
      const n = points.length
      return {
        ts,
        cpu: points.reduce((s, x) => s + x.cpu, 0) / n,
        memory: points.reduce((s, x) => s + x.memory, 0) / n,
        networkIo: points.reduce((s, x) => s + x.networkIo, 0) / n,
        diskIo: points.reduce((s, x) => s + x.diskIo, 0) / n,
      }
    })
}

/** 测试辅助：清空分层历史缓冲。 */
export function resetMockHistory(): void {
  rawPoints = []
  minutePoints = []
  openMinuteBucket = null
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

/**
 * 按时间范围取最近 N 天，返回仍按时间正序排列的切片。
 * @deprecated 仍按「天」切片；窗长与粒度切片由后续任务替换。
 */
export function sliceResourceMetrics(
  metrics: readonly DailyResourceMetrics[],
  range: TimeRange,
): DailyResourceMetrics[] {
  const count = range === '7d' ? 7 : 1
  return metrics.slice(-count)
}

/*
 * 按天种子序列与实时叠加层（旧路径）：仪表盘主路径已迁至 ResourceSamplePoint；
 * 事件流与其它测试仍可能引用 appendLiveResourceSample，保留至后续任务切换。
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

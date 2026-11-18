export type ResourceMetricKey = 'cpu' | 'memory' | 'networkIo' | 'diskIo'

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

export type TimeRange = '5m' | '30m' | '1h' | '5h' | '7d'

export const TIME_RANGES: readonly TimeRange[] = [
  '5m',
  '30m',
  '1h',
  '5h',
  '7d',
]

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '5m': '近 5 分钟',
  '30m': '近 30 分钟',
  '1h': '近 1 小时',
  '5h': '近 5 小时',
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
    case '30m':
      return 30 * MS_PER_MINUTE
    case '1h':
      return MS_PER_HOUR
    case '5h':
      return 5 * MS_PER_HOUR
    case '7d':
      return 7 * MS_PER_DAY
  }
}

export type ResourceGranularity = '5s' | '1m'

/** 时间范围对应的采样粒度：窗长不超过 1 小时按 5 秒，否则按 1 分钟。 */
export function timeRangeGranularity(range: TimeRange): ResourceGranularity {
  return timeRangeDurationMs(range) <= MS_PER_HOUR ? '5s' : '1m'
}

/** 采样粒度的中文展示文案。 */
export function timeRangeGranularityLabel(range: TimeRange): string {
  return timeRangeGranularity(range) === '5s' ? '按 5 秒' : '按 1 分钟'
}

/** 资源采样点：毫秒时间戳为横轴。 */
export type ResourceSamplePoint = {
  ts: number
  cpu: number
  memory: number
  /** 网络合计吞吐（MB/s）= networkRx + networkTx。 */
  networkIo: number
  /** 网络下行（接收，MB/s）。 */
  networkRx: number
  /** 网络上行（发送，MB/s）。 */
  networkTx: number
  /** 磁盘合计吞吐（MB/s）= diskRead + diskWrite。 */
  diskIo: number
  /** 磁盘读（MB/s）。 */
  diskRead: number
  /** 磁盘写（MB/s）。 */
  diskWrite: number
}

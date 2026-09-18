import { afterEach, describe, expect, it } from 'bun:test'
import {
  timeRangeGranularity,
  type ResourceSamplePoint,
} from '../mock/resourceMetrics.ts'
import { isDockerEnv } from './isDockerEnv.ts'
import { METRICS_SQLITE_PATH, openMemoryMetricsStore, type MetricsStore } from './metricsStore.ts'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

function sample(ts: number, cpu = 10): ResourceSamplePoint {
  return {
    ts,
    cpu,
    memory: 50,
    networkIo: 100,
    networkRx: 58,
    networkTx: 42,
    diskIo: 80,
    diskRead: 50,
    diskWrite: 30,
  }
}

describe('isDockerEnv', () => {
  it('ELSYIAN_DOCKER=1 时为 true', () => {
    expect(isDockerEnv({ ELSYIAN_DOCKER: '1' })).toBe(true)
    expect(isDockerEnv({ ELSYIAN_DOCKER: '0' })).toBe(false)
    expect(isDockerEnv({})).toBe(false)
  })
})

describe('METRICS_SQLITE_PATH', () => {
  it('默认库路径为 /var/lib/elysian/metrics.sqlite', () => {
    expect(METRICS_SQLITE_PATH).toBe('/var/lib/elysian/metrics.sqlite')
  })
})

describe('MetricsStore 内存库', () => {
  let store: MetricsStore

  afterEach(() => {
    store?.close()
  })

  it('insertRaw 后短窗 query 返回 raw 点', () => {
    store = openMemoryMetricsStore()
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 5; i += 1) {
      store.insertRaw(sample(t0 + i * 5_000, 10 + i))
    }
    const now = t0 + 4 * 5_000
    const points = store.query('5m', now)
    expect(points).toHaveLength(5)
    expect(points.map((p) => p.cpu)).toEqual([10, 11, 12, 13, 14])
    expect(timeRangeGranularity('5m')).toBe('5s')
  })

  it('rollupMinuteIfNeeded 将已完成分钟写入 samples_1m，长窗 query 读 1m', () => {
    store = openMemoryMetricsStore()
    const minute0 = 1_700_000_000_000
    const minute0Aligned = Math.floor(minute0 / MS_PER_MINUTE) * MS_PER_MINUTE
    store.insertRaw(sample(minute0Aligned, 10))
    store.insertRaw(sample(minute0Aligned + 5_000, 20))
    store.insertRaw(sample(minute0Aligned + 10_000, 30))
    const nextMinute = minute0Aligned + MS_PER_MINUTE
    store.insertRaw(sample(nextMinute, 40))
    store.rollupMinuteIfNeeded(nextMinute + 1)
    const long = store.query('5h', nextMinute + 1)
    expect(long.length).toBeGreaterThanOrEqual(1)
    const firstMinute = long.find((p) => p.ts === minute0Aligned)
    expect(firstMinute).toBeDefined()
    expect(firstMinute!.cpu).toBe(20)
  })

  it('prune 淘汰超龄 raw（1 小时）与 1m（7 天）', () => {
    store = openMemoryMetricsStore()
    const now = 2_000_000_000_000
    const oldRaw = now - MS_PER_HOUR - 1_000
    const freshRaw = now - 30_000
    store.insertRaw(sample(oldRaw))
    store.insertRaw(sample(freshRaw))
    store.prune(now)
    const short = store.query('1h', now)
    expect(short.some((p) => p.ts === oldRaw)).toBe(false)
    expect(short.some((p) => p.ts === freshRaw)).toBe(true)

    const oldMinute = now - 7 * MS_PER_DAY - MS_PER_MINUTE
    const minuteAligned = Math.floor(oldMinute / MS_PER_MINUTE) * MS_PER_MINUTE
    store.insertRaw(sample(minuteAligned, 5))
    store.insertRaw(sample(minuteAligned + MS_PER_MINUTE, 6))
    store.rollupMinuteIfNeeded(minuteAligned + MS_PER_MINUTE + 1)
    store.prune(now)
    const long = store.query('7d', now)
    expect(long.some((p) => p.ts === minuteAligned)).toBe(false)
  })
})

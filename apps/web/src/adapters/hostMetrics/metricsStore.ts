import { Database } from 'bun:sqlite'
import {
  timeRangeDurationMs,
  timeRangeGranularity,
  type ResourceSamplePoint,
  type TimeRange,
} from '../mock/resourceMetrics.ts'

/** 生产 compose 挂载的指标库路径（卷配置见后续任务）。 */
export const METRICS_SQLITE_PATH = '/var/lib/elysian/metrics.sqlite'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const RAW_RETENTION_MS = MS_PER_HOUR
const MINUTE_RETENTION_MS = 7 * MS_PER_DAY

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples_raw (
  ts INTEGER PRIMARY KEY,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  network_io REAL NOT NULL,
  disk_io REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS samples_1m (
  ts INTEGER PRIMARY KEY,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  network_io REAL NOT NULL,
  disk_io REAL NOT NULL
);
`

export type MetricsStore = {
  insertRaw(point: ResourceSamplePoint): void
  rollupMinuteIfNeeded(nowMs: number): void
  prune(nowMs: number): void
  query(range: TimeRange, nowMs: number): ResourceSamplePoint[]
  close(): void
}

type MinuteBucket = {
  minuteStart: number
  count: number
  cpu: number
  memory: number
  networkIo: number
  diskIo: number
}

function minuteStartMs(ts: number): number {
  return Math.floor(ts / MS_PER_MINUTE) * MS_PER_MINUTE
}

type SampleRow = {
  ts: number
  cpu: number
  memory: number
  network_io: number
  disk_io: number
}

function rowToPoint(row: SampleRow): ResourceSamplePoint {
  return {
    ts: row.ts,
    cpu: row.cpu,
    memory: row.memory,
    networkIo: row.network_io,
    diskIo: row.disk_io,
  }
}

function createMetricsStore(db: Database): MetricsStore {
  db.exec(SCHEMA)

  let openMinuteBucket: MinuteBucket | null = null

  const insertMinuteStmt = db.prepare(`
    INSERT OR REPLACE INTO samples_1m (ts, cpu, memory, network_io, disk_io)
    VALUES ($ts, $cpu, $memory, $network_io, $disk_io)
  `)

  const insertRawStmt = db.prepare(`
    INSERT OR REPLACE INTO samples_raw (ts, cpu, memory, network_io, disk_io)
    VALUES ($ts, $cpu, $memory, $network_io, $disk_io)
  `)

  const deleteRawBefore = db.prepare('DELETE FROM samples_raw WHERE ts < ?')
  const deleteMinuteBefore = db.prepare('DELETE FROM samples_1m WHERE ts < ?')

  const selectRawInWindow = db.prepare(`
    SELECT ts, cpu, memory, network_io, disk_io
    FROM samples_raw
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `)

  const selectMinuteInWindow = db.prepare(`
    SELECT ts, cpu, memory, network_io, disk_io
    FROM samples_1m
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `)

  function flushOpenMinuteBucket(): void {
    if (!openMinuteBucket || openMinuteBucket.count === 0) return
    const { minuteStart, count, cpu, memory, networkIo, diskIo } = openMinuteBucket
    insertMinuteStmt.run({
      $ts: minuteStart,
      $cpu: cpu / count,
      $memory: memory / count,
      $network_io: networkIo / count,
      $disk_io: diskIo / count,
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

  return {
    insertRaw(point) {
      absorbIntoMinuteBucket(point)
      insertRawStmt.run({
        $ts: point.ts,
        $cpu: point.cpu,
        $memory: point.memory,
        $network_io: point.networkIo,
        $disk_io: point.diskIo,
      })
    },

    rollupMinuteIfNeeded(nowMs) {
      const currentMinuteStart = minuteStartMs(nowMs)
      if (openMinuteBucket && openMinuteBucket.minuteStart < currentMinuteStart) {
        flushOpenMinuteBucket()
      }
    },

    prune(nowMs) {
      deleteRawBefore.run(nowMs - RAW_RETENTION_MS)
      deleteMinuteBefore.run(nowMs - MINUTE_RETENTION_MS)
    },

    query(range, nowMs) {
      const granularity = timeRangeGranularity(range)
      const windowStart = nowMs - timeRangeDurationMs(range)
      const inWindow = (p: ResourceSamplePoint) => p.ts >= windowStart && p.ts <= nowMs

      if (granularity === '5s') {
        return (selectRawInWindow.all(windowStart, nowMs) as SampleRow[]).map(rowToPoint)
      }

      const fromMinute = (selectMinuteInWindow.all(windowStart, nowMs) as SampleRow[]).map(
        rowToPoint,
      )
      if (fromMinute.length > 0) return fromMinute

      const rawInWindow = (selectRawInWindow.all(windowStart, nowMs) as SampleRow[]).map(rowToPoint)
      const byMinute = new Map<number, ResourceSamplePoint[]>()
      for (const p of rawInWindow) {
        const key = minuteStartMs(p.ts)
        const list = byMinute.get(key) ?? []
        list.push(p)
        byMinute.set(key, list)
      }
      const downsampled: ResourceSamplePoint[] = []
      for (const [minuteTs, points] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) {
        const n = points.length
        downsampled.push({
          ts: minuteTs,
          cpu: points.reduce((s, p) => s + p.cpu, 0) / n,
          memory: points.reduce((s, p) => s + p.memory, 0) / n,
          networkIo: points.reduce((s, p) => s + p.networkIo, 0) / n,
          diskIo: points.reduce((s, p) => s + p.diskIo, 0) / n,
        })
      }
      return downsampled.filter(inWindow)
    },

    close() {
      flushOpenMinuteBucket()
      db.close()
    },
  }
}

export function openMetricsStore(path: string): MetricsStore {
  return createMetricsStore(new Database(path))
}

export function openMemoryMetricsStore(): MetricsStore {
  return createMetricsStore(new Database(':memory:'))
}

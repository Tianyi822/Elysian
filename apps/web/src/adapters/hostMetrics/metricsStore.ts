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
  network_rx REAL NOT NULL DEFAULT 0,
  network_tx REAL NOT NULL DEFAULT 0,
  disk_io REAL NOT NULL,
  disk_read REAL NOT NULL DEFAULT 0,
  disk_write REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS samples_1m (
  ts INTEGER PRIMARY KEY,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  network_io REAL NOT NULL,
  network_rx REAL NOT NULL DEFAULT 0,
  network_tx REAL NOT NULL DEFAULT 0,
  disk_io REAL NOT NULL,
  disk_read REAL NOT NULL DEFAULT 0,
  disk_write REAL NOT NULL DEFAULT 0
);
`

const DIRECTIONAL_COLUMNS = [
  'network_rx',
  'network_tx',
  'disk_read',
  'disk_write',
] as const

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
  networkRx: number
  networkTx: number
  diskIo: number
  diskRead: number
  diskWrite: number
}

function minuteStartMs(ts: number): number {
  return Math.floor(ts / MS_PER_MINUTE) * MS_PER_MINUTE
}

type SampleRow = {
  ts: number
  cpu: number
  memory: number
  network_io: number
  network_rx: number
  network_tx: number
  disk_io: number
  disk_read: number
  disk_write: number
}

function rowToPoint(row: SampleRow): ResourceSamplePoint {
  const networkRx = row.network_rx ?? 0
  const networkTx = row.network_tx ?? 0
  const diskRead = row.disk_read ?? 0
  const diskWrite = row.disk_write ?? 0
  return {
    ts: row.ts,
    cpu: row.cpu,
    memory: row.memory,
    networkIo: row.network_io,
    networkRx,
    networkTx,
    diskIo: row.disk_io,
    diskRead,
    diskWrite,
  }
}

function ensureDirectionalColumns(db: Database): void {
  for (const table of ['samples_raw', 'samples_1m'] as const) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    for (const column of DIRECTIONAL_COLUMNS) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`)
      }
    }
  }
}

function createMetricsStore(db: Database): MetricsStore {
  db.exec(SCHEMA)
  ensureDirectionalColumns(db)

  let openMinuteBucket: MinuteBucket | null = null

  const insertMinuteStmt = db.prepare(`
    INSERT OR REPLACE INTO samples_1m
      (ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write)
    VALUES
      ($ts, $cpu, $memory, $network_io, $network_rx, $network_tx, $disk_io, $disk_read, $disk_write)
  `)

  const insertRawStmt = db.prepare(`
    INSERT OR REPLACE INTO samples_raw
      (ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write)
    VALUES
      ($ts, $cpu, $memory, $network_io, $network_rx, $network_tx, $disk_io, $disk_read, $disk_write)
  `)

  const deleteRawBefore = db.prepare('DELETE FROM samples_raw WHERE ts < ?')
  const deleteMinuteBefore = db.prepare('DELETE FROM samples_1m WHERE ts < ?')

  const selectRawInWindow = db.prepare(`
    SELECT ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write
    FROM samples_raw
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `)

  const selectMinuteInWindow = db.prepare(`
    SELECT ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write
    FROM samples_1m
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `)

  function flushOpenMinuteBucket(): void {
    if (!openMinuteBucket || openMinuteBucket.count === 0) return
    const { minuteStart, count, cpu, memory, networkIo, networkRx, networkTx, diskIo, diskRead, diskWrite } =
      openMinuteBucket
    insertMinuteStmt.run({
      $ts: minuteStart,
      $cpu: cpu / count,
      $memory: memory / count,
      $network_io: networkIo / count,
      $network_rx: networkRx / count,
      $network_tx: networkTx / count,
      $disk_io: diskIo / count,
      $disk_read: diskRead / count,
      $disk_write: diskWrite / count,
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
        networkRx: 0,
        networkTx: 0,
        diskIo: 0,
        diskRead: 0,
        diskWrite: 0,
      }
    }
    openMinuteBucket.count += 1
    openMinuteBucket.cpu += point.cpu
    openMinuteBucket.memory += point.memory
    openMinuteBucket.networkIo += point.networkIo
    openMinuteBucket.networkRx += point.networkRx
    openMinuteBucket.networkTx += point.networkTx
    openMinuteBucket.diskIo += point.diskIo
    openMinuteBucket.diskRead += point.diskRead
    openMinuteBucket.diskWrite += point.diskWrite
  }

  return {
    insertRaw(point) {
      absorbIntoMinuteBucket(point)
      insertRawStmt.run({
        $ts: point.ts,
        $cpu: point.cpu,
        $memory: point.memory,
        $network_io: point.networkIo,
        $network_rx: point.networkRx,
        $network_tx: point.networkTx,
        $disk_io: point.diskIo,
        $disk_read: point.diskRead,
        $disk_write: point.diskWrite,
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

      const fromMinute = (selectMinuteInWindow.all(windowStart, nowMs) as SampleRow[]).map(rowToPoint)
      if (fromMinute.length > 0) return fromMinute

      const raw = (selectRawInWindow.all(windowStart, nowMs) as SampleRow[]).map(rowToPoint)
      const byMinute = new Map<number, ResourceSamplePoint[]>()
      for (const p of raw.filter(inWindow)) {
        const key = minuteStartMs(p.ts)
        const list = byMinute.get(key) ?? []
        list.push(p)
        byMinute.set(key, list)
      }
      const downsampled: ResourceSamplePoint[] = []
      for (const [ts, points] of [...byMinute.entries()].sort(([a], [b]) => a - b)) {
        const n = points.length
        downsampled.push({
          ts,
          cpu: points.reduce((s, p) => s + p.cpu, 0) / n,
          memory: points.reduce((s, p) => s + p.memory, 0) / n,
          networkIo: points.reduce((s, p) => s + p.networkIo, 0) / n,
          networkRx: points.reduce((s, p) => s + p.networkRx, 0) / n,
          networkTx: points.reduce((s, p) => s + p.networkTx, 0) / n,
          diskIo: points.reduce((s, p) => s + p.diskIo, 0) / n,
          diskRead: points.reduce((s, p) => s + p.diskRead, 0) / n,
          diskWrite: points.reduce((s, p) => s + p.diskWrite, 0) / n,
        })
      }
      return downsampled.filter(inWindow)
    },

    close() {
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

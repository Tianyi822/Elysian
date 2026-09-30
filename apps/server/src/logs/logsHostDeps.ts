import {
  pageByQuery,
  type LoginLogEntry,
  type LogStorageStats,
  type OperationLogEntry,
  type RuntimeLogEntry,
} from '@elysian/contracts'
import { createLogsService, type LogsService } from './logsService.ts'
import type {
  LogClearCategory,
  LogStore,
  LogSweepCategory,
  LogSweepResult,
} from './logStoreTypes.ts'

/*
 * 临时装配：Task 6 把 LogsService 改成依赖 LogStore，真正打开 SQLite 与导入分片在 Task 7。
 * 这里用进程内内存库顶上，让 typecheck 与既有路由冒烟仍能装配出 service。
 */

export type LogsHostDepsOptions = {
  /** 保留参数形状：Task 7 起才真正用作分片根。 */
  platformLogsDir?: string
  /** 时钟注入：缺省真实时钟（测试用假时钟）。 */
  now?: () => Date
}

export type LogsHostDeps = {
  service: LogsService
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Task 7 删除：临时内存 LogStore，不打开 SQLite、不碰分片目录。 */
function createTemporaryMemoryLogStore(): LogStore {
  let nextId = 1
  const runtimes: Array<RuntimeLogEntry & { bytes: number }> = []
  const operations: Array<OperationLogEntry & { bytes: number }> = []
  const logins: Array<LoginLogEntry & { at: string; bytes: number }> = []
  let droppedRecords = 0
  let failedWrites = 0

  function storageOf(sweep: {
    lastSweepAt: string | null
    trimmedBySize: boolean
  }): LogStorageStats {
    const runtimeBytes = runtimes.reduce((sum, row) => sum + row.bytes, 0)
    const operationBytes = operations.reduce((sum, row) => sum + row.bytes, 0)
    const runtimeRowCount = runtimes.length
    const operationRowCount = operations.length
    const oldestCandidates = [...runtimes.map((row) => row.at), ...operations.map((row) => row.at)].sort()
    return {
      totalBytes: runtimeBytes + operationBytes,
      runtimeBytes,
      operationBytes,
      runtimeRowCount,
      operationRowCount,
      rowCount: runtimeRowCount + operationRowCount,
      oldestAt: oldestCandidates[0] ?? null,
      lastSweepAt: sweep.lastSweepAt,
      trimmedBySize: sweep.trimmedBySize,
      droppedRecords,
      failedWrites,
    }
  }

  return {
    insertRuntime(input) {
      try {
        const bytes = utf8Bytes({
          at: input.at,
          level: input.level,
          source: input.source,
          message: input.message,
        })
        runtimes.push({
          id: String(nextId++),
          at: input.at,
          level: input.level,
          source: input.source,
          message: input.message,
          bytes,
        })
      } catch {
        failedWrites += 1
      }
    },
    insertLogin(input) {
      try {
        const bytes = utf8Bytes(input)
        logins.push({
          id: String(nextId++),
          at: input.at,
          time: input.at,
          ip: input.ip,
          location: input.location,
          userAgent: input.userAgent,
          status: input.status,
          bytes,
        })
      } catch {
        failedWrites += 1
      }
    },
    insertOperation(input) {
      try {
        const bytes = utf8Bytes(input)
        operations.push({
          id: String(nextId++),
          at: input.at,
          category: input.category,
          action: input.action,
          target: input.target,
          summary: input.summary,
          result: input.result,
          method: input.method,
          path: input.path,
          httpStatus: input.httpStatus,
          bytes,
        })
      } catch {
        failedWrites += 1
      }
    },
    importFile() {
      return { inserted: 0, skipped: 0 }
    },
    queryRuntime(query) {
      return pageByQuery(runtimes, query, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        return (
          entry.source.toLowerCase().includes(needle) || entry.message.toLowerCase().includes(needle)
        )
      })
    },
    queryLogin(query) {
      const filtered =
        query.status === undefined ? logins : logins.filter((entry) => entry.status === query.status)
      const page = pageByQuery(filtered, query, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        return (
          entry.ip.toLowerCase().includes(needle) ||
          entry.location.toLowerCase().includes(needle) ||
          entry.userAgent.toLowerCase().includes(needle)
        )
      })
      return {
        ...page,
        entries: page.entries.map(({ id, ip, location, userAgent, status, time }) => ({
          id,
          ip,
          location,
          userAgent,
          status,
          time,
        })),
      }
    },
    queryOperation(query) {
      let rows = operations
      if (query.category !== undefined) rows = rows.filter((entry) => entry.category === query.category)
      if (query.result !== undefined) rows = rows.filter((entry) => entry.result === query.result)
      return pageByQuery(rows, query, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        return (
          entry.action.toLowerCase().includes(needle) ||
          entry.summary.toLowerCase().includes(needle) ||
          (entry.target ?? '').toLowerCase().includes(needle)
        )
      })
    },
    clear(category: LogClearCategory) {
      const rows = category === 'runtime' ? runtimes : operations
      const rowCount = rows.length
      const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
      const oldestAt = [...rows].map((row) => row.at).sort()[0] ?? null
      rows.length = 0
      return { rowCount, totalBytes, oldestAt }
    },
    sweep(_category: LogSweepCategory, _now: Date): LogSweepResult {
      return {
        deletedByAge: 0,
        deletedBySize: 0,
        freedBytes: 0,
        totalBytes: runtimes.reduce((sum, row) => sum + row.bytes, 0) +
          operations.reduce((sum, row) => sum + row.bytes, 0),
        trimmedBySize: false,
        failed: 0,
      }
    },
    storage(sweep) {
      return storageOf(sweep)
    },
    counters() {
      return { droppedRecords, failedWrites }
    },
    close() {},
  }
}

/** 平台日志片的临时装配：产出 `{ service }`（内存库；Task 7 换 SQLite）。 */
export function createLogsHostDeps(options: LogsHostDepsOptions = {}): LogsHostDeps {
  void options.platformLogsDir
  const now = options.now ?? (() => new Date())
  const service = createLogsService({
    store: createTemporaryMemoryLogStore(),
    now,
    startTimer: (onTick, intervalMs) => {
      const timer = setInterval(onTick, intervalMs)
      timer.unref()
    },
  })
  return { service }
}

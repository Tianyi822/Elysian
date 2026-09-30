import { Database } from 'bun:sqlite'
import {
  LOG_ENTRY_FETCH_LIMIT,
  LOG_RETENTION_POLICIES,
  type LoginLogEntry,
  type LoginLogListQuery,
  type LogListQuery,
  type LogPage,
  type LogRetentionPolicy,
  type LoginLogStatus,
  type LogStorageStats,
  type OperationLogCategory,
  type OperationLogEntry,
  type OperationLogListQuery,
  type OperationLogOutcome,
  type PlatformLogLevel,
  type RuntimeLogEntry,
} from '@elysian/contracts'
import {
  LOG_ACTION_MAX_LENGTH,
  LOG_IP_MAX_LENGTH,
  LOG_LOCATION_MAX_LENGTH,
  LOG_MESSAGE_MAX_LENGTH,
  LOG_METHOD_MAX_LENGTH,
  LOG_PATH_MAX_LENGTH,
  LOG_RECORD_MAX_BYTES,
  LOG_SOURCE_MAX_LENGTH,
  LOG_SUMMARY_MAX_LENGTH,
  LOG_TARGET_MAX_LENGTH,
  LOG_USER_AGENT_MAX_LENGTH,
  normalizeSingleLine,
  utf8ByteLength,
} from './logRecords.ts'

export type RuntimeInsert = {
  at: string
  level: PlatformLogLevel
  source: string
  message: string
  sourceKey?: string
}

export type LoginInsert = {
  at: string
  ip: string
  location: string
  userAgent: string
  status: LoginLogStatus
  sourceKey?: string
}

export type OperationInsert = {
  at: string
  category: OperationLogCategory
  action: string
  target: string | null
  summary: string
  result: OperationLogOutcome
  method: string | null
  path: string | null
  httpStatus: number | null
  sourceKey?: string
}

export type LogSweepCategory = 'runtime' | 'operation' | 'login'
export type LogClearCategory = 'runtime' | 'operation'

export type LogSweepResult = {
  deletedByAge: number
  deletedBySize: number
  freedBytes: number
  totalBytes: number
  trimmedBySize: boolean
  failed: number
}

export type LogClearResult = {
  rowCount: number
  totalBytes: number
  oldestAt: string | null
}

export type LogStorePolicies = Partial<Record<LogSweepCategory, LogRetentionPolicy>>

export type LogStore = {
  insertRuntime(input: RuntimeInsert): void
  insertLogin(input: LoginInsert): void
  insertOperation(input: OperationInsert): void
  queryRuntime(query: LogListQuery): LogPage<RuntimeLogEntry>
  queryLogin(query: LoginLogListQuery): LogPage<LoginLogEntry>
  queryOperation(query: OperationLogListQuery): LogPage<OperationLogEntry>
  clear(category: LogClearCategory): LogClearResult
  sweep(category: LogSweepCategory, now: Date): LogSweepResult
  storage(sweep: {
    category: LogSweepCategory
    lastSweepAt: string | null
    trimmedBySize: boolean
  }): LogStorageStats
  counters(): { droppedRecords: number; failedWrites: number }
  close(): void
}

/** 登录日志默认保留：与 logRetention.LOGIN_LOG_RETENTION_POLICY 同值。 */
const DEFAULT_LOGIN_POLICY: LogRetentionPolicy = {
  retentionDays: 30,
  maxTotalBytes: 16 * 1024 * 1024,
}

const TABLE_OF: Record<LogSweepCategory, string> = {
  runtime: 'runtime_logs',
  operation: 'operation_logs',
  login: 'login_logs',
}

const DAY_MS = 86_400_000

const UNAVAILABLE_MESSAGE = '日志数据库不可用'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_logs_at ON runtime_logs (at);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_logs_at ON login_logs (at);
CREATE INDEX IF NOT EXISTS login_logs_status_at ON login_logs (status, at);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  result TEXT NOT NULL,
  method TEXT,
  path TEXT,
  http_status INTEGER,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operation_logs_at ON operation_logs (at);
CREATE INDEX IF NOT EXISTS operation_logs_category_result_at ON operation_logs (category, result, at);
`

/** 关键字 LIKE 模式：字面匹配 %、_、\\，两侧加通配。 */
function likePattern(keyword: string): string {
  const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

function recordBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value))
}

type CursorBind = [string | null, string | null, string | null, number | null]

function cursorBind(query: LogListQuery): CursorBind {
  const before = query.before ?? null
  const beforeId = query.beforeId ?? null
  return [before, before, before, beforeId]
}

const CURSOR_SQL = '(? IS NULL OR at < ? OR (at = ? AND id < ?))'

function resolvePolicies(policies?: LogStorePolicies): Record<LogSweepCategory, LogRetentionPolicy> {
  return {
    runtime: policies?.runtime ?? LOG_RETENTION_POLICIES.runtime,
    operation: policies?.operation ?? LOG_RETENTION_POLICIES.operation,
    login: policies?.login ?? DEFAULT_LOGIN_POLICY,
  }
}

function emptySweep(failed = 0): LogSweepResult {
  return {
    deletedByAge: 0,
    deletedBySize: 0,
    freedBytes: 0,
    totalBytes: 0,
    trimmedBySize: false,
    failed,
  }
}

export function openLogStore(path: string, policies?: LogStorePolicies): LogStore {
  const db = new Database(path)
  db.exec(SCHEMA)
  const resolved = resolvePolicies(policies)

  let droppedRecords = 0
  let failedWrites = 0

  const insertRuntimeSql = db.prepare(
    `INSERT OR IGNORE INTO runtime_logs (at, level, source, message, source_key, bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertRuntimeNoKeySql = db.prepare(
    `INSERT INTO runtime_logs (at, level, source, message, source_key, bytes)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
  const insertLoginSql = db.prepare(
    `INSERT OR IGNORE INTO login_logs (at, ip, location, user_agent, status, source_key, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertLoginNoKeySql = db.prepare(
    `INSERT INTO login_logs (at, ip, location, user_agent, status, source_key, bytes)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
  const insertOperationSql = db.prepare(
    `INSERT OR IGNORE INTO operation_logs
      (at, category, action, target, summary, result, method, path, http_status, source_key, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertOperationNoKeySql = db.prepare(
    `INSERT INTO operation_logs
      (at, category, action, target, summary, result, method, path, http_status, source_key, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  )

  function tryRun(run: () => void): void {
    try {
      run()
    } catch {
      failedWrites += 1
    }
  }

  function sumBytes(table: string): number {
    const row = db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM ${table}`).get() as { n: number }
    return Number(row.n)
  }

  function countRows(table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return Number(row.n)
  }

  function minAt(table: string): string | null {
    const row = db.prepare(`SELECT MIN(at) AS at FROM ${table}`).get() as { at: string | null }
    return row.at ?? null
  }

  return {
    insertRuntime(input) {
      const source = normalizeSingleLine(input.source, LOG_SOURCE_MAX_LENGTH)
      const message = normalizeSingleLine(input.message, LOG_MESSAGE_MAX_LENGTH)
      const bytes = recordBytes({
        at: input.at,
        level: input.level,
        source,
        message,
      })
      if (bytes > LOG_RECORD_MAX_BYTES) {
        droppedRecords += 1
        return
      }
      const sourceKey = input.sourceKey
      tryRun(() => {
        if (sourceKey !== undefined) {
          insertRuntimeSql.run(input.at, input.level, source, message, sourceKey, bytes)
        } else {
          insertRuntimeNoKeySql.run(input.at, input.level, source, message, bytes)
        }
      })
    },

    insertLogin(input) {
      const ip = normalizeSingleLine(input.ip, LOG_IP_MAX_LENGTH)
      const location = normalizeSingleLine(input.location, LOG_LOCATION_MAX_LENGTH)
      const userAgent = normalizeSingleLine(input.userAgent, LOG_USER_AGENT_MAX_LENGTH)
      const bytes = recordBytes({
        at: input.at,
        ip,
        location,
        userAgent,
        status: input.status,
      })
      if (bytes > LOG_RECORD_MAX_BYTES) {
        droppedRecords += 1
        return
      }
      const sourceKey = input.sourceKey
      tryRun(() => {
        if (sourceKey !== undefined) {
          insertLoginSql.run(input.at, ip, location, userAgent, input.status, sourceKey, bytes)
        } else {
          insertLoginNoKeySql.run(input.at, ip, location, userAgent, input.status, bytes)
        }
      })
    },

    insertOperation(input) {
      const action = normalizeSingleLine(input.action, LOG_ACTION_MAX_LENGTH)
      const target =
        input.target === null ? null : normalizeSingleLine(input.target, LOG_TARGET_MAX_LENGTH)
      const summary = normalizeSingleLine(input.summary, LOG_SUMMARY_MAX_LENGTH)
      const method =
        input.method === null ? null : normalizeSingleLine(input.method, LOG_METHOD_MAX_LENGTH)
      const path =
        input.path === null ? null : normalizeSingleLine(input.path, LOG_PATH_MAX_LENGTH)
      const bytes = recordBytes({
        at: input.at,
        category: input.category,
        action,
        target,
        result: input.result,
        httpStatus: input.httpStatus,
        method,
        path,
        summary,
      })
      if (bytes > LOG_RECORD_MAX_BYTES) {
        droppedRecords += 1
        return
      }
      const sourceKey = input.sourceKey
      tryRun(() => {
        if (sourceKey !== undefined) {
          insertOperationSql.run(
            input.at,
            input.category,
            action,
            target,
            summary,
            input.result,
            method,
            path,
            input.httpStatus,
            sourceKey,
            bytes,
          )
        } else {
          insertOperationNoKeySql.run(
            input.at,
            input.category,
            action,
            target,
            summary,
            input.result,
            method,
            path,
            input.httpStatus,
            bytes,
          )
        }
      })
    },

    queryRuntime(query) {
      return queryTable<RuntimeLogEntry>({
        db,
        table: 'runtime_logs',
        query,
        keywordSql: '(source LIKE ? ESCAPE \'\\\' OR message LIKE ? ESCAPE \'\\\')',
        keywordParams: (pattern) => [pattern, pattern],
        mapRow: (row) => ({
          id: String(row.id),
          at: String(row.at),
          level: row.level as PlatformLogLevel,
          source: String(row.source),
          message: String(row.message),
        }),
      })
    },

    queryLogin(query) {
      const status = query.status
      return queryTable<LoginLogEntry>({
        db,
        table: 'login_logs',
        query,
        extraWhere: '(? IS NULL OR status = ?)',
        extraParams: [status ?? null, status ?? null],
        keywordSql:
          '(ip LIKE ? ESCAPE \'\\\' OR location LIKE ? ESCAPE \'\\\' OR user_agent LIKE ? ESCAPE \'\\\')',
        keywordParams: (pattern) => [pattern, pattern, pattern],
        mapRow: (row) => ({
          id: String(row.id),
          ip: String(row.ip),
          location: String(row.location),
          userAgent: String(row.user_agent),
          status: row.status as LoginLogStatus,
          time: String(row.at),
        }),
      })
    },

    queryOperation(query) {
      const category = query.category
      const result = query.result
      return queryTable<OperationLogEntry>({
        db,
        table: 'operation_logs',
        query,
        extraWhere: '(? IS NULL OR category = ?) AND (? IS NULL OR result = ?)',
        extraParams: [category ?? null, category ?? null, result ?? null, result ?? null],
        keywordSql:
          '(action LIKE ? ESCAPE \'\\\' OR summary LIKE ? ESCAPE \'\\\' OR IFNULL(target, \'\') LIKE ? ESCAPE \'\\\')',
        keywordParams: (pattern) => [pattern, pattern, pattern],
        mapRow: (row) => ({
          id: String(row.id),
          at: String(row.at),
          category: row.category as OperationLogCategory,
          action: String(row.action),
          target: row.target === null || row.target === undefined ? null : String(row.target),
          summary: String(row.summary),
          result: row.result as OperationLogOutcome,
          method: row.method === null || row.method === undefined ? null : String(row.method),
          path: row.path === null || row.path === undefined ? null : String(row.path),
          httpStatus:
            row.http_status === null || row.http_status === undefined
              ? null
              : Number(row.http_status),
        }),
      })
    },

    clear(category) {
      const table = TABLE_OF[category]
      return db.transaction(() => {
        const stats = db
          .prepare(
            `SELECT COUNT(*) AS rowCount, COALESCE(SUM(bytes), 0) AS totalBytes, MIN(at) AS oldestAt FROM ${table}`,
          )
          .get() as { rowCount: number; totalBytes: number; oldestAt: string | null }
        db.prepare(`DELETE FROM ${table}`).run()
        return {
          rowCount: Number(stats.rowCount),
          totalBytes: Number(stats.totalBytes),
          oldestAt: stats.oldestAt ?? null,
        }
      })()
    },

    sweep(category, now) {
      const table = TABLE_OF[category]
      const policy = resolved[category]
      try {
        let freedBytes = 0
        const cutoff = new Date(now.getTime() - policy.retentionDays * DAY_MS).toISOString()
        const ageBytesRow = db
          .prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM ${table} WHERE at < ?`)
          .get(cutoff) as { n: number }
        const ageDelete = db.prepare(`DELETE FROM ${table} WHERE at < ?`).run(cutoff)
        const deletedByAge = Number(ageDelete.changes)
        freedBytes += Number(ageBytesRow.n)

        const rows = db
          .prepare(`SELECT id, bytes FROM ${table} ORDER BY at ASC, id ASC`)
          .all() as Array<{ id: number; bytes: number }>
        let total = rows.reduce((sum, row) => sum + Number(row.bytes), 0)
        const deleteIds: number[] = []
        let deletedBySize = 0
        for (const row of rows) {
          if (total <= policy.maxTotalBytes) break
          deleteIds.push(Number(row.id))
          total -= Number(row.bytes)
          freedBytes += Number(row.bytes)
          deletedBySize += 1
        }
        if (deleteIds.length > 0) {
          db.prepare(`DELETE FROM ${table} WHERE id IN (${deleteIds.map(() => '?').join(', ')})`).run(
            ...deleteIds,
          )
        }

        return {
          deletedByAge,
          deletedBySize,
          freedBytes,
          totalBytes: sumBytes(table),
          trimmedBySize: deletedBySize > 0,
          failed: 0,
        }
      } catch (error) {
        console.error(
          `Elysian 日志巡检失败（${category}）：${error instanceof Error ? error.message : String(error)}`,
        )
        try {
          return { ...emptySweep(1), totalBytes: sumBytes(table) }
        } catch {
          return emptySweep(1)
        }
      }
    },

    storage(sweep) {
      const runtimeBytes = sumBytes('runtime_logs')
      const operationBytes = sumBytes('operation_logs')
      const runtimeCount = countRows('runtime_logs')
      const operationCount = countRows('operation_logs')
      const runtimeOldest = minAt('runtime_logs')
      const operationOldest = minAt('operation_logs')
      let oldestAt: string | null = null
      if (runtimeOldest !== null && operationOldest !== null) {
        oldestAt = runtimeOldest < operationOldest ? runtimeOldest : operationOldest
      } else {
        oldestAt = runtimeOldest ?? operationOldest
      }
      return {
        totalBytes: runtimeBytes + operationBytes,
        runtimeBytes,
        operationBytes,
        fileCount: runtimeCount + operationCount,
        oldestAt,
        lastSweepAt: sweep.lastSweepAt,
        trimmedBySize: sweep.trimmedBySize,
        droppedRecords,
        failedWrites,
      }
    },

    counters() {
      return { droppedRecords, failedWrites }
    },

    close() {
      db.close()
    },
  }
}

export function createUnavailableLogStore(): LogStore {
  let failedWrites = 0

  function unavailable(): never {
    throw new Error(UNAVAILABLE_MESSAGE)
  }

  return {
    insertRuntime() {
      failedWrites += 1
    },
    insertLogin() {
      failedWrites += 1
    },
    insertOperation() {
      failedWrites += 1
    },
    queryRuntime: unavailable,
    queryLogin: unavailable,
    queryOperation: unavailable,
    clear: unavailable,
    sweep() {
      return emptySweep(1)
    },
    storage(sweep) {
      return {
        totalBytes: 0,
        runtimeBytes: 0,
        operationBytes: 0,
        fileCount: 0,
        oldestAt: null,
        lastSweepAt: sweep.lastSweepAt,
        trimmedBySize: sweep.trimmedBySize,
        droppedRecords: 0,
        failedWrites,
      }
    },
    counters() {
      return { droppedRecords: 0, failedWrites }
    },
    close() {},
  }
}

type Row = Record<string, unknown>

function queryTable<T>(options: {
  db: Database
  table: string
  query: LogListQuery
  extraWhere?: string
  extraParams?: unknown[]
  keywordSql: string
  keywordParams: (pattern: string) => unknown[]
  mapRow: (row: Row) => T
}): LogPage<T> {
  const limit = Math.min(options.query.limit ?? LOG_ENTRY_FETCH_LIMIT, LOG_ENTRY_FETCH_LIMIT)
  const keyword = options.query.q?.trim() ?? ''
  const whereParts: string[] = [CURSOR_SQL]
  const params: unknown[] = [...cursorBind(options.query)]

  if (options.extraWhere) {
    whereParts.push(options.extraWhere)
    params.push(...(options.extraParams ?? []))
  }

  if (keyword !== '') {
    whereParts.push(options.keywordSql)
    params.push(...options.keywordParams(likePattern(keyword)))
  }

  const whereSql = whereParts.join(' AND ')

  // total：同一套筛选，不含游标与 LIMIT。
  const totalWhereParts = whereParts.filter((part) => part !== CURSOR_SQL)
  const totalParams = params.slice(4)
  const totalSql =
    totalWhereParts.length > 0
      ? `SELECT COUNT(*) AS n FROM ${options.table} WHERE ${totalWhereParts.join(' AND ')}`
      : `SELECT COUNT(*) AS n FROM ${options.table}`
  const totalRow = options.db.prepare(totalSql).get(...totalParams) as { n: number }
  const total = Number(totalRow.n)

  const remainingSql = `SELECT COUNT(*) AS n FROM ${options.table} WHERE ${whereSql}`
  const remainingRow = options.db.prepare(remainingSql).get(...params) as { n: number }
  const remaining = Number(remainingRow.n)

  const selectSql = `SELECT * FROM ${options.table} WHERE ${whereSql} ORDER BY at DESC, id DESC LIMIT ?`
  const rows = options.db.prepare(selectSql).all(...params, limit) as Row[]
  const entries = rows.map(options.mapRow)
  const truncated = remaining > entries.length

  return { entries, total, truncated }
}

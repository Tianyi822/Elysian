import { Database } from 'bun:sqlite'
import type {
  LoginLogEntry,
  LoginLogListQuery,
  LogListQuery,
  LogPage,
  LoginLogStatus,
  OperationLogCategory,
  OperationLogEntry,
  OperationLogListQuery,
  OperationLogOutcome,
  PlatformLogLevel,
  RuntimeLogEntry,
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

export type LogStore = {
  insertRuntime(input: RuntimeInsert): void
  insertLogin(input: LoginInsert): void
  insertOperation(input: OperationInsert): void
  queryRuntime(query: LogListQuery): LogPage<RuntimeLogEntry>
  queryLogin(query: LoginLogListQuery): LogPage<LoginLogEntry>
  queryOperation(query: OperationLogListQuery): LogPage<OperationLogEntry>
  counters(): { droppedRecords: number; failedWrites: number }
  close(): void
}

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

export function openLogStore(path: string): LogStore {
  const db = new Database(path)
  db.exec(SCHEMA)

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

    counters() {
      return { droppedRecords, failedWrites }
    },

    close() {
      db.close()
    },
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
  const limit = options.query.limit ?? 1000
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

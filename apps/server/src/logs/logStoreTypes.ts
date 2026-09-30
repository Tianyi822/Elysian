import type {
  LoginLogEntry,
  LoginLogListQuery,
  LoginLogStatus,
  LogListQuery,
  LogPage,
  LogRetentionPolicy,
  LogStorageStats,
  OperationLogCategory,
  OperationLogEntry,
  OperationLogListQuery,
  OperationLogOutcome,
  PlatformLogLevel,
  RuntimeLogEntry,
} from '@elysian/contracts'

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
  importFile(
    category: LogSweepCategory,
    lines: readonly string[],
  ): { inserted: number; skipped: number }
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

import {
  LOG_RETENTION_POLICIES,
  PLATFORM_LOG_CATEGORY_LABELS,
  formatLogBytes,
  type LogClearReport,
  type LoginLogListReport,
  type LoginLogStatus,
  type LogStorageStats,
  type OperationLogCategory,
  type LoginLogListQuery,
  type LogListQuery,
  type OperationLogListReport,
  type OperationLogListQuery,
  type OperationLogOutcome,
  type PlatformLogCategory,
  type PlatformLogLevel,
  type RuntimeLogListReport,
} from '@elysian/contracts'
import { loginLocationOf, normalizePeerAddress } from './loginClient.ts'
import { normalizeSingleLine, LOG_USER_AGENT_MAX_LENGTH } from './logRecords.ts'
import type { LogStore, LogSweepCategory } from './logStoreTypes.ts'

/*
 * 日志服务的编排层：列表、清空、写运行/登录/操作日志、触发巡检。
 * 读写全部走 LogStore；类别维护锁保证 clear 与 sweep 不并发。
 * 巡检定时器只在第一次收到该类别的巡检请求后注册。
 */

/** 巡检定时器间隔：每 5 分钟一次。 */
export const LOG_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export type SweepReason = 'first-write' | 'timer' | 'after-roll' | 'after-clear' | 'manual'

export type LogsServiceDeps = {
  store: LogStore
  now(): Date
  /** 巡检定时器的注册出口（第一次收到巡检请求时调用一次）。 */
  startTimer(onTick: () => void, intervalMs: number): void
}

export type SweepResult = {
  removedTmp: 0
  compressed: 0
  deletedByAge: number
  deletedBySize: number
  freedBytes: number
  totalBytes: number
  trimmedBySize: boolean
  failed: number
  at: string
}

export type LogsService = {
  runtimeLog(query?: LogListQuery): Promise<RuntimeLogListReport>
  operationLog(query?: OperationLogListQuery): Promise<OperationLogListReport>
  loginLog(query?: LoginLogListQuery): Promise<LoginLogListReport>
  clear(category: PlatformLogCategory): Promise<LogClearReport>
  log(level: PlatformLogLevel, source: string, message: string): Promise<void>
  recordLogin(input: { ip: string; userAgent: string; status: LoginLogStatus }): Promise<void>
  recordOperation(input: {
    category: OperationLogCategory
    action: string
    target?: string | null
    result: OperationLogOutcome
    summary?: string | null
    method?: string | null
    path?: string | null
    httpStatus?: number | null
  }): Promise<void>
  runSweep(category: LogSweepCategory, reason: SweepReason): Promise<SweepResult>
}

const LOGIN_RETENTION_POLICY = {
  retentionDays: 30,
  maxTotalBytes: 16 * 1024 * 1024,
} as const

function retentionPolicyOf(category: LogSweepCategory) {
  return category === 'login' ? LOGIN_RETENTION_POLICY : LOG_RETENTION_POLICIES[category]
}

function categoryLabel(category: LogSweepCategory): string {
  return category === 'login' ? '登录日志' : PLATFORM_LOG_CATEGORY_LABELS[category]
}

export function createLogsService(deps: LogsServiceDeps): LogsService {
  const sweepState: Record<LogSweepCategory, { lastSweepAt: string | null; trimmedBySize: boolean }> = {
    runtime: { lastSweepAt: null, trimmedBySize: false },
    operation: { lastSweepAt: null, trimmedBySize: false },
    login: { lastSweepAt: null, trimmedBySize: false },
  }
  const locks: Record<LogSweepCategory, Promise<void>> = {
    runtime: Promise.resolve(),
    operation: Promise.resolve(),
    login: Promise.resolve(),
  }
  const pending: Partial<Record<LogSweepCategory, Promise<SweepResult>>> = {}
  const timerStarted: Record<LogSweepCategory, boolean> = {
    runtime: false,
    operation: false,
    login: false,
  }

  function withMaintenanceLock<T>(category: LogSweepCategory, task: () => Promise<T>): Promise<T> {
    const previous = locks[category]
    let release: () => void = () => {}
    locks[category] = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(task, task).finally(() => release())
  }

  function storage(category: LogSweepCategory): LogStorageStats {
    return deps.store.storage({
      category,
      lastSweepAt: sweepState[category].lastSweepAt,
      trimmedBySize: sweepState[category].trimmedBySize,
    })
  }

  async function log(level: PlatformLogLevel, source: string, message: string): Promise<void> {
    deps.store.insertRuntime({
      at: deps.now().toISOString(),
      level,
      source,
      message,
    })
  }

  async function logSweepResult(
    category: LogSweepCategory,
    reason: SweepReason,
    result: SweepResult,
  ): Promise<void> {
    if (reason === 'after-clear') return
    const deleted = result.deletedByAge + result.deletedBySize
    const level: PlatformLogLevel = deleted > 0 || result.failed > 0 ? 'warning' : 'info'
    await log(
      level,
      'logs.retention',
      `保留巡检完成：删除 ${deleted}、释放 ${formatLogBytes(result.freedBytes)}`,
    )
    if (result.failed > 0) {
      await log('warning', 'logs.retention', `保留巡检有 ${result.failed} 项失败（详见服务端 stderr 与目录权限）`)
    }
    const policy = retentionPolicyOf(category)
    if (result.totalBytes > policy.maxTotalBytes) {
      await log(
        'warning',
        'logs.retention',
        `${categoryLabel(category)}仍超出总量上限：当前 ${formatLogBytes(result.totalBytes)}、上限 ${formatLogBytes(policy.maxTotalBytes)}（只剩活动分片或静默窗口内的文件，已停止删除）`,
      )
    }
  }

  async function sweepLocked(category: LogSweepCategory, reason: SweepReason): Promise<SweepResult> {
    const raw = deps.store.sweep(category, deps.now())
    const result: SweepResult = {
      removedTmp: 0,
      compressed: 0,
      deletedByAge: raw.deletedByAge,
      deletedBySize: raw.deletedBySize,
      freedBytes: raw.freedBytes,
      totalBytes: raw.totalBytes,
      trimmedBySize: raw.trimmedBySize,
      failed: raw.failed,
      at: deps.now().toISOString(),
    }
    sweepState[category] = { lastSweepAt: result.at, trimmedBySize: result.trimmedBySize }
    await logSweepResult(category, reason, result)
    return result
  }

  function runSweep(category: LogSweepCategory, reason: SweepReason): Promise<SweepResult> {
    const inFlight = pending[category]
    if (inFlight !== undefined) return inFlight
    if (!timerStarted[category]) {
      timerStarted[category] = true
      deps.startTimer(() => {
        void runSweep(category, 'timer')
      }, LOG_SWEEP_INTERVAL_MS)
    }
    const task = withMaintenanceLock(category, () => sweepLocked(category, reason))
    pending[category] = task
    const settled = (): void => {
      if (pending[category] === task) delete pending[category]
    }
    void task.then(settled, settled)
    return task
  }

  async function clear(category: PlatformLogCategory): Promise<LogClearReport> {
    return withMaintenanceLock(category, async () => {
      const cleared = deps.store.clear(category)
      const clearedAt = deps.now().toISOString()
      const text = `删除 ${cleared.rowCount} 条记录，释放 ${formatLogBytes(cleared.totalBytes)}`
      deps.store.insertRuntime({
        at: clearedAt,
        level: 'warning',
        source: 'logs.clear',
        message: `${PLATFORM_LOG_CATEGORY_LABELS[category]}已清空：${text}`,
      })
      deps.store.insertOperation({
        at: clearedAt,
        category: 'logs',
        action: category === 'runtime' ? '清空运行日志' : '清空操作日志',
        target: null,
        summary: text,
        result: 'success',
        method: null,
        path: null,
        httpStatus: null,
      })
      await sweepLocked(category, 'after-clear')
      return {
        category,
        rowCount: cleared.rowCount,
        totalBytes: cleared.totalBytes,
        oldestAt: cleared.oldestAt,
        clearedAt,
      }
    })
  }

  async function recordLogin(input: Parameters<LogsService['recordLogin']>[0]): Promise<void> {
    const ip = normalizePeerAddress(input.ip)
    const userAgent = normalizeSingleLine(input.userAgent, LOG_USER_AGENT_MAX_LENGTH)
    deps.store.insertLogin({
      at: deps.now().toISOString(),
      ip,
      location: loginLocationOf(ip),
      userAgent: userAgent === '' ? '未知' : userAgent,
      status: input.status,
    })
  }

  async function recordOperation(input: Parameters<LogsService['recordOperation']>[0]): Promise<void> {
    deps.store.insertOperation({
      at: deps.now().toISOString(),
      category: input.category,
      action: input.action,
      target: input.target ?? null,
      summary: input.summary ?? '',
      result: input.result,
      method: input.method ?? null,
      path: input.path ?? null,
      httpStatus: input.httpStatus ?? null,
    })
  }

  async function runtimeLog(query: LogListQuery = {}): Promise<RuntimeLogListReport> {
    const page = deps.store.queryRuntime(query)
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: storage('runtime'),
    }
  }

  async function loginLog(query: LoginLogListQuery = {}): Promise<LoginLogListReport> {
    const page = deps.store.queryLogin(query)
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
    }
  }

  async function operationLog(query: OperationLogListQuery = {}): Promise<OperationLogListReport> {
    const page = deps.store.queryOperation(query)
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: storage('operation'),
    }
  }

  return { runtimeLog, operationLog, loginLog, clear, log, recordLogin, recordOperation, runSweep }
}

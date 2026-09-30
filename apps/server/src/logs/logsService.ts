import {
  LOG_ENTRY_FETCH_LIMIT,
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
import {
  normalizeSingleLine,
  toLoginLogEntry,
  toOperationLogEntry,
  toRuntimeLogEntry,
  LOG_USER_AGENT_MAX_LENGTH,
  type LoginLogRecord,
  type OperationLogRecord,
  type RuntimeLogRecord,
} from './logRecords.ts'
import { readLogRecords, type LogReaderDeps } from './logReader.ts'
import {
  collectStorageStats,
  retentionEntries,
  retentionPolicyOf,
  runRetentionSweep,
  type LogRetentionDeps,
  type SweepResult,
} from './logRetention.ts'
import type { LogShardCategory } from './logsPaths.ts'
import type { LogWriter } from './logWriter.ts'

/*
 * 日志服务的编排层：列表、清空、写运行日志、写操作日志、触发巡检，以及计数器与
 * 巡检状态的唯一持有者。
 *
 * 锁只有两把，落点写死：
 * - **writer 串行队列**（logWriter 内）：所有 append 与 seal 共用它，任何两条记录不交错；
 * - **类别维护锁**（本文件，per-category promise 链）：clear 与 sweep 都先取它，
 *   因此「清空与巡检永不并发」只在一个地方实现与测试。
 * clear 在维护锁内用 writer.sealAndRun 把「封盘 + 删除全部文件」做成一个不被 append
 * 插入的临界区：清空期间排队的 append 在清空之后落地，写进新建的分片（不丢日志，
 * 也不会写进刚被删掉的文件名）。
 *
 * 巡检定时器只在**第一次收到该类别的巡检请求**（也就是第一次写入之后）注册，
 * 因此装配期与「从没写过日志的进程」都不产生定时器，也无需 dispose。
 */

/** 巡检定时器间隔：每 5 分钟一次。 */
export const LOG_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export type SweepReason = 'first-write' | 'timer' | 'after-roll' | 'after-clear' | 'manual'

export type LogsServiceDeps = {
  /** 每类别一个写入器（由 logsHostDeps 构造）。login 与运行/操作共用写入器，目录分开。 */
  writers: Record<LogShardCategory, LogWriter>
  /** 每类别一个读取器依赖：listFiles / readLines / parseLine 三件套，parseLine 决定记录类型。 */
  readers: {
    runtime: LogReaderDeps<RuntimeLogRecord>
    operation: LogReaderDeps<OperationLogRecord>
    login: LogReaderDeps<LoginLogRecord>
  }
  /** 每类别一份巡检依赖（listFiles / gzipFile / removeFile / ensureDir），writer 由本层注入。 */
  retention: Record<LogShardCategory, Omit<LogRetentionDeps, 'writer'>>
  now(): Date
  /** 巡检定时器的注册出口（第一次收到巡检请求时调用一次，实现在 hostDeps 里 setInterval + unref）。 */
  startTimer(onTick: () => void, intervalMs: number): void
}

export type LogsService = {
  runtimeLog(query?: LogListQuery): Promise<RuntimeLogListReport>
  operationLog(query?: OperationLogListQuery): Promise<OperationLogListReport>
  /** 登录日志列表（时间倒序）。 */
  loginLog(query?: LoginLogListQuery): Promise<LoginLogListReport>
  clear(category: PlatformLogCategory): Promise<LogClearReport>
  log(level: PlatformLogLevel, source: string, message: string): Promise<void>
  /**
   * 记一次登录尝试。ip 会先归一成合法地址（否则「未知」），归属地由地址推导；
   * userAgent 单行化，空串收成「未知」。写失败不抛给调用方（写入器自己计数）。
   */
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
  /**
   * 单个类别的巡检入口。内部先取该类别的维护锁，再执行四步巡检；
   * 并发触发同一类别时合并到同一次（后到的调用等待前一个完成即返回，不排队、不重复扫）。
   * 返回巡检结果（测试与排障直接看计数）。
   */
  runSweep(category: LogShardCategory, reason: SweepReason): Promise<SweepResult>
}

export function createLogsService(deps: LogsServiceDeps): LogsService {
  let seq = 0
  // 巡检状态**按类别**：进程级单值会让一个类别的裁剪显示在另一个类别的报告里，
  // 也会被无关类别的下一次巡检瞬间冲掉（界面提示因此可能永远看不到）。
  const sweepState: Record<LogShardCategory, { lastSweepAt: string | null; trimmedBySize: boolean }> = {
    runtime: { lastSweepAt: null, trimmedBySize: false },
    operation: { lastSweepAt: null, trimmedBySize: false },
    login: { lastSweepAt: null, trimmedBySize: false },
  }
  const locks: Record<LogShardCategory, Promise<void>> = {
    runtime: Promise.resolve(),
    operation: Promise.resolve(),
    login: Promise.resolve(),
  }
  const pending: Partial<Record<LogShardCategory, Promise<SweepResult>>> = {}
  const timerStarted: Record<LogShardCategory, boolean> = { runtime: false, operation: false, login: false }

  /** 类别维护锁：per-category promise 链，FIFO，clear 与 sweep 都先取它。 */
  function withMaintenanceLock<T>(category: LogShardCategory, task: () => Promise<T>): Promise<T> {
    const previous = locks[category]
    let release: () => void = () => {}
    locks[category] = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(task, task).finally(() => release())
  }

  function nextSeq(): number {
    seq += 1
    return seq
  }

  function counters(): { droppedRecords: number; failedWrites: number } {
    const runtime = deps.writers.runtime.counters()
    const operation = deps.writers.operation.counters()
    const login = deps.writers.login.counters()
    return {
      droppedRecords: runtime.droppedRecords + operation.droppedRecords + login.droppedRecords,
      failedWrites: runtime.failedWrites + operation.failedWrites + login.failedWrites,
    }
  }

  function categoryLabel(category: LogShardCategory): string {
    return category === 'login' ? '登录日志' : PLATFORM_LOG_CATEGORY_LABELS[category]
  }

  /** 单个类别的存储统计：口径与巡检一致，巡检状态取该类别自己的那一份。 */
  async function storage(category: LogShardCategory): Promise<LogStorageStats> {
    return collectStorageStats(
      { listFiles: (listed) => deps.retention[listed].listFiles(listed) },
      counters(),
      sweepState[category],
    )
  }

  async function log(level: PlatformLogLevel, source: string, message: string): Promise<void> {
    await deps.writers.runtime.append({
      at: deps.now().toISOString(),
      seq: nextSeq(),
      level,
      source,
      message,
    })
  }

  /** 巡检的收尾留痕：一行摘要（有删除或失败时 warning），超预算未删净时另加一行警告。 */
  async function logSweepResult(
    category: LogShardCategory,
    reason: SweepReason,
    result: SweepResult,
  ): Promise<void> {
    // 清空自己已经写了一条「已清空」留痕（清空后界面应当**正好一条**），after-clear 不再重复报。
    if (reason === 'after-clear') return
    const deleted = result.deletedByAge + result.deletedBySize
    const level: PlatformLogLevel = deleted > 0 || result.failed > 0 ? 'warning' : 'info'
    await log(
      level,
      'logs.retention',
      `保留巡检完成：压缩 ${result.compressed}、删除 ${deleted}、释放 ${formatLogBytes(result.freedBytes)}`,
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

  /** 巡检本体：调用方必须已经持有类别维护锁。 */
  async function sweepLocked(category: LogShardCategory, reason: SweepReason): Promise<SweepResult> {
    const result = await runRetentionSweep(
      { ...deps.retention[category], writer: deps.writers[category] },
      category,
    )
    sweepState[category] = { lastSweepAt: result.at, trimmedBySize: result.trimmedBySize }
    await logSweepResult(category, reason, result)
    return result
  }

  function runSweep(category: LogShardCategory, reason: SweepReason): Promise<SweepResult> {
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
      const writer = deps.writers[category]
      const retention = deps.retention[category]
      let fileCount = 0
      let totalBytes = 0
      let oldestAt: string | null = null
      let failed = 0

      // ① 封盘并独占：删除动作与 append 互不插入（清空期间的 append 排队，之后写进新建的分片）。
      await writer.sealAndRun(async () => {
        // ② 清该类别目录下**全部条目**：活动片、已压缩片、`.tmp` 残留、以及任何其它形态的
        //    普通文件、符号链接与子目录，一个不留（「一个不留」必须覆盖非本模块命名与非常规条目，
        //    否则它们会落在窗口与预算之外永久累积；它们是别人放在面板私有 0700 目录里的东西）。
        //    符号链接只摘链接自身、子目录递归删除（都不跟随链接，链接目标与目录外的文件不受影响）；
        //    sshd.log 在另一个目录，天然不碰。
        const files = await retention.listFiles(category)
        const counted = new Map(retentionEntries(files, category).map((entry) => [entry.file.path, entry]))
        for (const file of files) {
          try {
            await retention.removeFile(file.path)
          } catch (error) {
            failed += 1
            console.error(
              `Elysian 清空日志失败（${category}：${file.path}）：${error instanceof Error ? error.message : String(error)}`,
            )
            continue
          }
          const entry = counted.get(file.path)
          // `.tmp` 删掉但不进统计口径（与「日志大小」同口径）。
          if (entry === undefined) continue
          // 报告回的是**已删除的事实**：条目数与字节按统计口径计入（子目录按递归字节和）。
          fileCount += 1
          totalBytes += entry.file.sizeBytes
          if (oldestAt === null || entry.at < oldestAt) oldestAt = entry.at
        }
      })

      const clearedAt = deps.now().toISOString()
      // ③ 自指留痕：清空动作本身写回新文件（运行日志的 warning；操作日志那条由采集中间件写）。
      await log(
        'warning',
        'logs.clear',
        `${categoryLabel(category)}已清空：删除 ${fileCount} 个文件，释放 ${formatLogBytes(totalBytes)}`,
      )
      if (failed > 0) {
        await log('warning', 'logs.clear', `${categoryLabel(category)}清空有 ${failed} 个文件未能删除`)
      }
      // 顺带巡检（清临时残留）：已经在维护锁里，走不加锁的那份。
      await sweepLocked(category, 'after-clear')

      return { category, fileCount, totalBytes, oldestAt, clearedAt }
    })
  }

  async function recordLogin(input: Parameters<LogsService['recordLogin']>[0]): Promise<void> {
    const ip = normalizePeerAddress(input.ip)
    const userAgent = normalizeSingleLine(input.userAgent, LOG_USER_AGENT_MAX_LENGTH)
    const record: LoginLogRecord = {
      at: deps.now().toISOString(),
      seq: nextSeq(),
      ip,
      location: loginLocationOf(ip),
      userAgent: userAgent === '' ? '未知' : userAgent,
      status: input.status,
    }
    await deps.writers.login.append(record)
  }

  async function recordOperation(input: Parameters<LogsService['recordOperation']>[0]): Promise<void> {
    const record: OperationLogRecord = {
      at: deps.now().toISOString(),
      seq: nextSeq(),
      category: input.category,
      action: input.action,
      target: input.target ?? null,
      result: input.result,
      httpStatus: input.httpStatus ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      summary: input.summary ?? '',
    }
    await deps.writers.operation.append(record)
  }

  async function runtimeLog(_query?: LogListQuery): Promise<RuntimeLogListReport> {
    const read = await readLogRecords(deps.readers.runtime, 'runtime', LOG_ENTRY_FETCH_LIMIT)
    const entries = read.records.map(toRuntimeLogEntry).reverse()
    return {
      // 运行日志倒序（新 → 旧）：与操作日志同一口径，最新一条在表格最上方。
      entries,
      total: entries.length,
      truncated: read.truncated,
      skippedLines: read.skippedLines,
      skippedFiles: read.skippedFiles,
      storage: await storage('runtime'),
    }
  }

  async function loginLog(_query?: LoginLogListQuery): Promise<LoginLogListReport> {
    const read = await readLogRecords(deps.readers.login, 'login', LOG_ENTRY_FETCH_LIMIT)
    const entries = read.records.map(toLoginLogEntry).reverse()
    return {
      entries,
      total: entries.length,
      truncated: read.truncated,
      skippedLines: read.skippedLines,
      skippedFiles: read.skippedFiles,
    }
  }

  async function operationLog(_query?: OperationLogListQuery): Promise<OperationLogListReport> {
    const read = await readLogRecords(deps.readers.operation, 'operation', LOG_ENTRY_FETCH_LIMIT)
    const entries = read.records.map(toOperationLogEntry).reverse()
    return {
      // 操作日志倒序（新 → 旧），与登录日志一致。
      entries,
      total: entries.length,
      truncated: read.truncated,
      skippedLines: read.skippedLines,
      skippedFiles: read.skippedFiles,
      storage: await storage('operation'),
    }
  }

  return { runtimeLog, operationLog, loginLog, clear, log, recordLogin, recordOperation, runSweep }
}

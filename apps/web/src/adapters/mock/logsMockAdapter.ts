import { PLATFORM_LOG_CATEGORY_LABELS, formatLogBytes, pageByQuery } from '@elysian/contracts'
import type {
  LoginLogEntry, LoginLogListQuery, LoginLogListReport, LogClearReport, LogListQuery, LogStorageStats,
  OperationLogEntry, OperationLogListQuery, OperationLogListReport, PlatformLogCategory, RuntimeLogEntry, RuntimeLogListReport,
} from '@elysian/contracts'
import type { LogsAdapter } from '../../contracts/adapters'
import {
  getLoginLogs,
  operationLogEntries,
  replaceOperationLogEntries,
  replaceRuntimeLogEntries,
  runtimeLogEntries,
} from './logsData'

/**
 * 清空留痕的进程内序号：起点取 1000，避开种子条目已占用的编号，
 * 让「留痕」的 id 与种子条目的 id 形式一致且互不冲突（uuid 只要求响应内唯一）。
 */
let nextClearTraceSeq = 1000

/** jsonl 行的 UTF-8 字节数：与写盘口径一致，界面「日志大小」显示的就是这个数。 */
function logEntriesBytes(entries: readonly object[]): number {
  const encoder = new TextEncoder()
  return entries.reduce((sum, entry) => sum + encoder.encode(`${JSON.stringify(entry)}\n`).length, 0)
}

/** 存储统计：两类条目的字节、行数与最旧时间为两类合计。 */
function logStorage(
  runtime: readonly RuntimeLogEntry[],
  operation: readonly OperationLogEntry[],
): LogStorageStats {
  const runtimeBytes = logEntriesBytes(runtime)
  const operationBytes = logEntriesBytes(operation)
  const oldest = [...runtime, ...operation].map((entry) => entry.at).sort()[0]
  return {
    totalBytes: runtimeBytes + operationBytes,
    runtimeBytes,
    operationBytes,
    runtimeRowCount: runtime.length,
    operationRowCount: operation.length,
    rowCount: runtime.length + operation.length,
    oldestAt: oldest ?? null,
    lastSweepAt: null,
    trimmedBySize: false,
    droppedRecords: 0,
    failedWrites: 0,
  }
}

function oldestAtOf(entries: readonly { at: string }[]): string | null {
  return [...entries].map((entry) => entry.at).sort()[0] ?? null
}

/** 清空一条运行日志留痕（与真实服务端同款文案与来源）。 */
function runtimeClearTrace(category: PlatformLogCategory, report: LogClearReport, at: string): RuntimeLogEntry {
  return {
    id: `${at}#${(nextClearTraceSeq += 1)}`,
    at,
    level: 'warning',
    source: 'logs.clear',
    message: `${PLATFORM_LOG_CATEGORY_LABELS[category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}`,
  }
}

/** 清空一条操作日志留痕：动作、方法、路径与真实服务端的采集结果同形。 */
function operationClearTrace(category: PlatformLogCategory, report: LogClearReport, at: string): OperationLogEntry {
  return {
    id: `${at}#${(nextClearTraceSeq += 1)}`,
    at,
    category: 'logs',
    action: `清空${PLATFORM_LOG_CATEGORY_LABELS[category]}`,
    target: null,
    summary: `删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}`,
    result: 'success',
    method: 'POST',
    path: `/api/logs/${category}/clear`,
    httpStatus: 200,
  }
}

/**
 * 日志的 mock 实现：读内存里的条目数组（种子见 logsData），列表返回报告。
 * 清空改写内存数组并留下本次清空的留痕——与真实服务端同形的自指留痕（规格 7.2）：
 * 被清空的类别清空后最多剩一条记录，且那条就是清空动作自己。
 * 列表不设截断：演示数据只有几百条，远低于服务端的单次读取上限。
 */
export class MockLogsAdapter implements LogsAdapter {
  async runtimeLog(query?: LogListQuery): Promise<RuntimeLogListReport> {
    const runtime = runtimeLogEntries()
    const operation = operationLogEntries()
    const page = pageByQuery(runtime, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      return entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)
    })
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(runtime, operation),
    }
  }

  async loginLogs(query?: LoginLogListQuery): Promise<LoginLogListReport> {
    const rows = getLoginLogs().map((entry) => ({ ...entry, at: entry.time }))
    const page = pageByQuery(rows, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      if (query?.status && entry.status !== query.status) return false
      return (
        entry.ip.toLowerCase().includes(needle)
        || entry.location.toLowerCase().includes(needle)
        || entry.userAgent.toLowerCase().includes(needle)
      )
    })
    const entries: LoginLogEntry[] = page.entries.map(({ at: _at, ...entry }) => entry)
    return {
      entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
    }
  }

  async operationLogs(query?: OperationLogListQuery): Promise<OperationLogListReport> {
    const runtime = runtimeLogEntries()
    const operation = operationLogEntries()
    const page = pageByQuery(operation, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      if (query?.category && entry.category !== query.category) return false
      if (query?.result && entry.result !== query.result) return false
      return (
        entry.action.toLowerCase().includes(needle)
        || entry.summary.toLowerCase().includes(needle)
        || (entry.target?.toLowerCase().includes(needle) ?? false)
      )
    })
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(runtime, operation),
    }
  }

  async clearLogs(category: PlatformLogCategory): Promise<LogClearReport> {
    const cleared = category === 'runtime' ? runtimeLogEntries() : operationLogEntries()
    const clearedAt = new Date().toISOString()
    // 报告回的是**已删除的事实**：条目前的字节、分片数与最旧时间。
    const report: LogClearReport = {
      category,
      rowCount: cleared.length,
      totalBytes: logEntriesBytes(cleared),
      oldestAt: oldestAtOf(cleared),
      clearedAt,
    }
    const trace = runtimeClearTrace(category, report, clearedAt)
    if (category === 'runtime') {
      // 清空运行日志：新文件里只剩这条 warning 留痕。
      replaceRuntimeLogEntries([trace])
    } else {
      // 清空操作日志：操作日志里只剩这条成功留痕；清空动作本身同时记进运行日志（服务端同样如此）。
      replaceOperationLogEntries([operationClearTrace(category, report, clearedAt)])
      replaceRuntimeLogEntries([...runtimeLogEntries(), trace])
    }
    return report
  }
}

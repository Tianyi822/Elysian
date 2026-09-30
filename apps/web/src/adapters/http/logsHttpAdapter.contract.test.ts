import type {
  LogClearReport,
  LogStorageStats,
  OperationLogEntry,
  PlatformLogCategory,
  PlatformLogLevel,
  RuntimeLogEntry,
} from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS } from '@elysian/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SweepResult } from '../../../../server/src/logs/logRetention.ts'
import { createLogsApp, LOGS_MOUNT } from '../../../../server/src/logs/logsRoutes.ts'
import type { LogsService } from '../../../../server/src/logs/logsService.ts'
import { runLogsAdapterContract } from '../logsAdapterContract'
import { SEED_OPERATION_LOGS, SEED_RUNTIME_LOGS } from '../mock/logsData'
import { createHttpLogsAdapter } from './logsHttpAdapter'

/*
 * 同一套日志契约断言对 HTTP 实现再跑一遍（「mock 可替换」的验证在日志域不能缺一半）。
 *
 * 端点用的是**服务端真实的日志子应用**（apps/server/src/logs/logsRoutes.ts 的
 * createLogsApp），只有 LogsService 是假的——因此被检验的是真实的路由、守卫链、
 * 状态码与响应形状，而不是一份手抄的形状。跨包 import 服务端源码有先例
 * （proxyTable.test.ts 取挂载常量）。
 *
 * 两点测试侧脚手架的说明：
 * - 不 import app.ts 的 createApp：它为终端片动态 `import('bun')`，web 的 vitest
 *   pipeline（jsdom + node）解析不到 bun 模块图；子应用本身零 bun 依赖，直接驱动它。
 * - 子应用的路径是相对的（挂载前缀由 app.ts 拼接），因此桩把 `/api/logs` 前缀剥掉再转发；
 *   「挂载前缀就是 /api/logs」由 proxyTable.test.ts 与 server 侧用例各自锚定。
 * - 写端点要过同源守卫：桩补上 Origin 与 Host（浏览器对同源写请求自动带 Origin、
 *   Host 由网络层给出），与真实浏览器的请求同形。
 */

const UTF8 = new TextEncoder()

/** 两类条目的字节数：与界面「日志大小」同口径（jsonl 一行的 UTF-8 字节和）。 */
function bytesOf(entries: readonly object[]): number {
  return entries.reduce((sum, entry) => sum + UTF8.encode(`${JSON.stringify(entry)}\n`).length, 0)
}

function shardCount(entries: readonly { at: string }[]): number {
  return new Set(entries.map((entry) => entry.at.slice(0, 10))).size
}

/** 与 server 侧 collectStorageStats 同口径：总量为两类之和，最旧时间取两类合并后的最小值。 */
function storageOf(
  runtime: readonly RuntimeLogEntry[],
  operation: readonly OperationLogEntry[],
): LogStorageStats {
  const runtimeBytes = bytesOf(runtime)
  const operationBytes = bytesOf(operation)
  const oldest = [...runtime, ...operation].map((entry) => entry.at).sort()[0]
  return {
    totalBytes: runtimeBytes + operationBytes,
    runtimeBytes,
    operationBytes,
    fileCount: shardCount(runtime) + shardCount(operation),
    oldestAt: oldest ?? null,
    lastSweepAt: null,
    trimmedBySize: false,
    droppedRecords: 0,
    failedWrites: 0,
  }
}

/**
 * 假服务：内存条目 + 与真实服务端同形的自指留痕（规格 7.2）。
 * 运行日志的留痕由服务层在清空后写；操作日志的留痕在生产里由 app 层采集中间件记录
 * （清空本身是写端点），这里由假服务代替——两种留痕的形状与真实实现一致。
 */
function createFakeLogsService(): LogsService {
  let runtime: RuntimeLogEntry[] = [...SEED_RUNTIME_LOGS]
  let operation: OperationLogEntry[] = [...SEED_OPERATION_LOGS]
  let seq = 1000

  const writeRuntime = (level: PlatformLogLevel, source: string, message: string): void => {
    const at = new Date().toISOString()
    seq += 1
    runtime = [...runtime, { id: `${at}#${seq}`, at, level, source, message }]
  }

  const service: LogsService = {
    async runtimeLog() {
      return {
        entries: runtime,
        total: runtime.length,
        truncated: false,
        skippedLines: 0,
        skippedFiles: 0,
        storage: storageOf(runtime, operation),
      }
    },
    async operationLog() {
      return {
        entries: operation,
        total: operation.length,
        truncated: false,
        skippedLines: 0,
        skippedFiles: 0,
        storage: storageOf(runtime, operation),
      }
    },
    async loginLog() {
      return { entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0 }
    },
    async recordLogin() {
      return undefined
    },
    async clear(category: PlatformLogCategory) {
      const cleared = category === 'runtime' ? runtime : operation
      const report: LogClearReport = {
        category,
        fileCount: shardCount(cleared),
        totalBytes: bytesOf(cleared),
        oldestAt: [...cleared].map((entry) => entry.at).sort()[0] ?? null,
        clearedAt: new Date().toISOString(),
      }
      if (category === 'runtime') {
        runtime = []
      } else {
        operation = []
        // 清空操作日志时，操作日志的留痕由采集中间件写（它记录的正是这次 POST）。
        await service.recordOperation({
          category: 'logs',
          action: `清空${PLATFORM_LOG_CATEGORY_LABELS[category]}`,
          result: 'success',
          summary: `删除 ${report.fileCount} 个文件`,
          method: 'POST',
          path: `${LOGS_MOUNT}/${category}/clear`,
          httpStatus: 200,
        })
      }
      writeRuntime('warning', 'logs.clear', `${PLATFORM_LOG_CATEGORY_LABELS[category]}已清空：删除 ${report.fileCount} 个文件`)
      return report
    },
    async log(level, source, message) {
      writeRuntime(level, source, message)
    },
    async recordOperation(input) {
      const at = new Date().toISOString()
      seq += 1
      // 倒序：新记录排在最前（与 operationLog 的返回顺序一致）。
      operation = [
        {
          id: `${at}#${seq}`,
          at,
          category: input.category,
          action: input.action,
          target: input.target ?? null,
          summary: input.summary ?? '',
          result: input.result,
          method: input.method ?? null,
          path: input.path ?? null,
          httpStatus: input.httpStatus ?? null,
        },
        ...operation,
      ]
    },
    async runSweep() {
      // 契约断言只覆盖读取与清空：巡检由服务端轨自己的用例覆盖，这里回一份空结果。
      return EMPTY_SWEEP
    },
  }
  return service
}

/** 巡检结果的最小合法形状：契约用例从不触发巡检，只满足接口。 */
const EMPTY_SWEEP: SweepResult = {
  removedTmp: 0,
  compressed: 0,
  deletedByAge: 0,
  deletedBySize: 0,
  freedBytes: 0,
  totalBytes: 0,
  trimmedBySize: false,
  failed: 0,
  at: '2026-09-23T00:00:00.000Z',
}

/** 每次新建子应用（连同假服务）并装好 fetch 桩：清空会改写状态，用例之间不能共用。 */
function makeHttpAdapter() {
  const app = createLogsApp({ service: createFakeLogsService() })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const relative = url.pathname.startsWith(LOGS_MOUNT)
      ? url.pathname.slice(LOGS_MOUNT.length)
      : url.pathname
    const headers = new Headers(init?.headers)
    headers.set('origin', url.origin)
    headers.set('host', url.host)
    return app.request(new Request(new URL(relative || '/', url), { ...init, headers }))
  })
  return createHttpLogsAdapter('/api/logs')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

runLogsAdapterContract('http', makeHttpAdapter)

describe('HTTP 日志端点接线', () => {
  it('四个端点各自落在 /api/logs 下的约定路径上', async () => {
    const app = createLogsApp({ service: createFakeLogsService() })
    const calls: { url: string; method: string; body: unknown }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
      const url = new URL(String(input), 'http://localhost')
      const headers = new Headers(init?.headers)
      headers.set('origin', url.origin)
      headers.set('host', url.host)
      return app.request(
        new Request(new URL(url.pathname.slice(LOGS_MOUNT.length) || '/', url), { ...init, headers }),
      )
    })
    const adapter = createHttpLogsAdapter()
    await adapter.runtimeLog()
    await adapter.operationLogs()
    await adapter.loginLogs()
    await adapter.clearLogs('operation')
    expect(calls).toEqual([
      { url: '/api/logs/runtime', method: 'GET', body: undefined },
      { url: '/api/logs/operation', method: 'GET', body: undefined },
      { url: '/api/logs/login', method: 'GET', body: undefined },
      { url: '/api/logs/operation/clear', method: 'POST', body: '{}' },
    ])
  })
})

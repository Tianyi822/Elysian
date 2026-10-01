import type {
  LogClearReport,
  LogStorageStats,
  LogListQuery,
  LoginLogListQuery,
  OperationLogEntry,
  OperationLogListQuery,
  RuntimeLogEntry,
} from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS, pageByQuery } from '@elysian/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLogsAdapterContract } from '../logsAdapterContract'
import { SEED_LOGIN_LOGS, SEED_OPERATION_LOGS, SEED_RUNTIME_LOGS } from '../mock/logsData'
import { createHttpLogsAdapter } from './logsHttpAdapter'

/*
 * 同一套日志契约断言对 HTTP 实现再跑一遍（「mock 可替换」的验证在日志域不能缺一半）。
 *
 * TS 后端删除后，「真实服务端路由」的保证由 Go 侧自轨承担（apps/server-go/internal/logs/
 * router_test.go 锚路由、状态码与守卫，.zcode/go-migration 的 e2e 脚本锚端到端接线）；
 * 这里改用一个内存态的 /api/logs 端点桩驱动同一套契约断言：桩与真实实现共用种子数据集、
 * 响应形状（存储统计、`{ cleared }` 包裹、清空自指留痕）与 `pageByQuery` 分页口径，
 * 被检验的仍是 adapter 的请求接线、JSON 形状校验与状态映射，而不是一份手抄的响应。
 */

const UTF8 = new TextEncoder()

/** 两类条目的字节数：与界面「日志大小」同口径（jsonl 一行的 UTF-8 字节和）。 */
function bytesOf(entries: readonly object[]): number {
  return entries.reduce((sum, entry) => sum + UTF8.encode(`${JSON.stringify(entry)}\n`).length, 0)
}

/** 与服务端 collectStorageStats 同口径：总量为两类之和，最旧时间取两类合并后的最小值。 */
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

/**
 * 内存态的 /api/logs 端点桩：种子数据 + 与真实服务端同形的清空留痕（规格 7.2）。
 * 运行日志的留痕由服务层在清空后写；操作日志的留痕在生产里由 app 层采集中间件记录
 * （清空本身是写端点），这里由桩代替——两种留痕的形状与真实实现一致。
 * 分页与筛选直接复用契约的 pageByQuery（与 mock、真实服务端同一口径）。
 */
function createLogsApiStub() {
  let runtime: RuntimeLogEntry[] = [...SEED_RUNTIME_LOGS]
  let operation: OperationLogEntry[] = [...SEED_OPERATION_LOGS]
  let seq = 1000

  const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const query: LogListQuery = {
      q: url.searchParams.get('q') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      before: url.searchParams.get('before') ?? undefined,
      beforeId: url.searchParams.get('beforeId') ? Number(url.searchParams.get('beforeId')) : undefined,
    }
    const recordTrace = (category: 'runtime' | 'operation', rowCount: number): void => {
      const at = new Date().toISOString()
      seq += 1
      const label = PLATFORM_LOG_CATEGORY_LABELS[category]
      if (category === 'runtime') {
        runtime = [
          ...runtime,
          { id: `${at}#${seq}`, at, level: 'warning', source: 'logs.clear', message: `${label}已清空：删除 ${rowCount} 个文件` },
        ]
      } else {
        // 清空操作日志的留痕由采集中间件写（它记录的正是这次 POST），倒序排在最前。
        operation = [
          {
            id: `${at}#${seq}`,
            at,
            category: 'logs',
            action: `清空${label}`,
            target: null,
            summary: `删除 ${rowCount} 个文件`,
            result: 'success',
            method: 'POST',
            path: `/api/logs/${category}/clear`,
            httpStatus: 200,
          },
          ...operation,
        ]
      }
    }

    if (url.pathname === '/api/logs/runtime' && method === 'GET') {
      const page = pageByQuery(runtime, query, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        return entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)
      })
      return respond({ ...page, skippedLines: 0, skippedFiles: 0, storage: storageOf(runtime, operation) })
    }
    if (url.pathname === '/api/logs/operation' && method === 'GET') {
      const operationQuery = query as OperationLogListQuery
      const category = url.searchParams.get('category')
      const result = url.searchParams.get('result')
      const page = pageByQuery(operation, operationQuery, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        if (category && entry.category !== category) return false
        if (result && entry.result !== result) return false
        return (
          entry.action.toLowerCase().includes(needle)
          || entry.summary.toLowerCase().includes(needle)
          || (entry.target?.toLowerCase().includes(needle) ?? false)
        )
      })
      return respond({ ...page, skippedLines: 0, skippedFiles: 0, storage: storageOf(runtime, operation) })
    }
    if (url.pathname === '/api/logs/login' && method === 'GET') {
      const loginQuery = query as LoginLogListQuery
      const status = url.searchParams.get('status')
      const rows = SEED_LOGIN_LOGS.filter((entry) => !status || entry.status === status)
      return respond({
        entries: rows.slice(0, loginQuery.limit ?? rows.length),
        total: rows.length,
        truncated: false,
        skippedLines: 0,
        skippedFiles: 0,
      })
    }
    const clearMatch = /^\/api\/logs\/(runtime|operation)\/clear$/.exec(url.pathname)
    if (clearMatch && method === 'POST') {
      const category = clearMatch[1] as 'runtime' | 'operation'
      const cleared = category === 'runtime' ? runtime : operation
      const report: LogClearReport = {
        category,
        rowCount: cleared.length,
        totalBytes: bytesOf(cleared),
        oldestAt: [...cleared].map((entry) => entry.at).sort()[0] ?? null,
        clearedAt: new Date().toISOString(),
      }
      if (category === 'runtime') {
        runtime = []
      } else {
        operation = []
      }
      recordTrace(category, report.rowCount)
      return respond({ cleared: report })
    }
    return respond({ error: `未知日志端点：${method} ${url.pathname}` }, 404)
  }
}

/** 每次新建一份端点桩（连同其内存状态）并装好 fetch 桩：清空会改写状态，用例之间不能共用。 */
function makeHttpAdapter() {
  const handle = createLogsApiStub()
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => handle(input, init))
  return createHttpLogsAdapter('/api/logs')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

runLogsAdapterContract('http', makeHttpAdapter)

describe('HTTP 日志端点接线', () => {
  it('四个端点各自落在 /api/logs 下的约定路径上', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const handle = createLogsApiStub()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
      return handle(input, init)
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

import { describe, expect, it } from 'vitest'
import {
  pageByQuery,
  type LoginLogEntry,
  type LoginLogListQuery,
  type LogClearReport,
  type LogListQuery,
  type OperationLogEntry,
  type OperationLogListQuery,
  type RuntimeLogEntry,
} from '@elysian/contracts'
import { LOG_SWEEP_INTERVAL_MS, createLogsService, type LogsService } from './logsService'
import type {
  LoginInsert,
  LogClearCategory,
  LogStore,
  LogSweepCategory,
  LogSweepResult,
  OperationInsert,
  RuntimeInsert,
} from './logStoreTypes'

/*
 * 服务编排的行为测试：内存版 LogStore 替身，注入时钟与定时器出口。
 * 覆盖筛选下传、清空留痕、失败不留痕、巡检合并与互斥、登录归一。
 */

const NOW = new Date('2026-09-23T12:00:00.000Z')

type FakeStore = LogStore & {
  runtimeInserts: RuntimeInsert[]
  loginInserts: LoginInsert[]
  operationInserts: OperationInsert[]
  queries: Array<LogListQuery | LoginLogListQuery | OperationLogListQuery>
}

type Harness = {
  service: LogsService
  store: FakeStore
  queries: FakeStore['queries']
  state: {
    timers: { onTick: () => void; intervalMs: number }[]
    clock: Date
  }
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function createFakeStore(options: { clearFails?: boolean; failInserts?: boolean } = {}): FakeStore {
  let nextId = 1
  const runtimes: Array<RuntimeLogEntry & { bytes: number }> = []
  const operations: Array<OperationLogEntry & { bytes: number }> = []
  const logins: Array<LoginLogEntry & { at: string; bytes: number }> = []
  const runtimeInserts: RuntimeInsert[] = []
  const loginInserts: LoginInsert[] = []
  const operationInserts: OperationInsert[] = []
  const queries: FakeStore['queries'] = []
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

  const store: FakeStore = {
    runtimeInserts,
    loginInserts,
    operationInserts,
    queries,
    insertRuntime(input) {
      runtimeInserts.push(input)
      if (options.failInserts) {
        failedWrites += 1
        return
      }
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
    },
    insertLogin(input) {
      loginInserts.push(input)
      if (options.failInserts) {
        failedWrites += 1
        return
      }
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
    },
    insertOperation(input) {
      operationInserts.push(input)
      if (options.failInserts) {
        failedWrites += 1
        return
      }
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
    },
    importFile() {
      return { inserted: 0, skipped: 0 }
    },
    queryRuntime(query) {
      queries.push(query)
      return pageByQuery(runtimes, query, (entry, keyword) => {
        const needle = keyword.toLowerCase()
        return (
          entry.source.toLowerCase().includes(needle) || entry.message.toLowerCase().includes(needle)
        )
      })
    },
    queryLogin(query) {
      queries.push(query)
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
      queries.push(query)
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
      if (options.clearFails) throw new Error('日志数据库不可用')
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
  return store
}

function createHarness(
  overrides: { clearFails?: boolean; failInserts?: boolean } = {},
): Harness {
  const state: Harness['state'] = {
    timers: [],
    clock: new Date(NOW),
  }

  const store = createFakeStore(overrides)
  const service = createLogsService({
    store,
    now: () => state.clock,
    startTimer: (onTick, intervalMs) => {
      state.timers.push({ onTick, intervalMs })
    },
  })

  return { service, store, queries: store.queries, state }
}

function yieldToQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('写运行日志与列表', () => {
  it('log 写入运行日志；列表倒序（新 → 旧）、字段齐全、带存储统计', async () => {
    const { service } = createHarness()

    await service.log('info', 'logs.test', '第一条')
    await service.log('warning', 'logs.test', '第二条')

    const report = await service.runtimeLog()

    expect(report.entries.map((entry) => entry.message)).toEqual(['第二条', '第一条'])
    expect(report.entries.map((entry) => entry.level)).toEqual(['warning', 'info'])
    expect(report.entries[0]).toMatchObject({
      at: NOW.toISOString(),
      source: 'logs.test',
    })
    expect(report).toMatchObject({ truncated: false, skippedLines: 0, skippedFiles: 0, total: 2 })
    expect(report.storage).toMatchObject({
      operationBytes: 0,
      runtimeRowCount: 2,
      operationRowCount: 0,
      rowCount: 2,
      lastSweepAt: null,
      trimmedBySize: false,
      droppedRecords: 0,
      failedWrites: 0,
    })
    expect(report.storage.totalBytes).toBe(report.storage.runtimeBytes)
    expect(report.storage.runtimeBytes).toBeGreaterThan(0)
  })

  it('recordOperation 写入操作日志，列表倒序（新 → 旧）', async () => {
    const { service } = createHarness()

    await service.recordOperation({
      category: 'security',
      action: '修改 SSH 监听端口',
      result: 'success',
      httpStatus: 200,
      method: 'PUT',
      path: '/api/security/ssh/port',
      summary: '端口 2222',
    })
    await service.recordOperation({ category: 'files', action: '复制文件', result: 'failure', httpStatus: 500 })
    await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success' })

    const report = await service.operationLog()

    expect(report.entries.map((entry) => entry.action)).toEqual(['清空运行日志', '复制文件', '修改 SSH 监听端口'])
    expect(report.entries[2]).toMatchObject({
      category: 'security',
      target: null,
      summary: '端口 2222',
      method: 'PUT',
      path: '/api/security/ssh/port',
      httpStatus: 200,
      result: 'success',
    })
    expect(report.storage.operationBytes).toBeGreaterThan(0)
    expect(report.storage.runtimeBytes).toBe(0)
    expect(report.storage.operationRowCount).toBe(3)
    expect(report.storage.rowCount).toBe(3)
  })

  it('operationLog 把筛选交给 store，并带回 total', async () => {
    const { service, queries } = createHarness()
    await service.recordOperation({ category: 'files', action: '复制文件', result: 'success' })
    const report = await service.operationLog({ category: 'files', q: '复制' })
    expect(queries.at(-1)).toEqual({ category: 'files', q: '复制' })
    expect(report.total).toBe(report.entries.length)
    expect(report.skippedLines).toBe(0)
    expect(report.storage.rowCount).toBe(report.storage.runtimeRowCount + report.storage.operationRowCount)
  })

  it('写失败只计数（storage.failedWrites），不影响调用方', async () => {
    const { service } = createHarness({ failInserts: true })
    await expect(service.log('info', 'logs.test', '写不进去')).resolves.toBeUndefined()
    await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success' })

    const report = await service.runtimeLog()
    expect(report.storage.failedWrites).toBe(2)
    expect(report.storage.droppedRecords).toBe(0)
  })
})

describe('清空', () => {
  it('清空删除该类别全部记录并回报告，然后留下运行与操作留痕', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史一')
    await service.log('info', 'logs.test', '历史二')

    const report = await service.clear('runtime')

    expect(report).toMatchObject({
      category: 'runtime',
      rowCount: 2,
      oldestAt: NOW.toISOString(),
      clearedAt: NOW.toISOString(),
    } satisfies Partial<LogClearReport>)
    expect(report.totalBytes).toBeGreaterThan(0)

    const after = await service.runtimeLog()
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]?.level).toBe('warning')
    expect(after.entries[0]?.source).toBe('logs.clear')
    expect(after.entries[0]?.message).toMatch(/^运行日志已清空：删除 2 条记录，释放 [\d.]+ (KB|MB|GB)$/)

    const operations = await service.operationLog()
    expect(operations.entries[0]).toMatchObject({
      category: 'logs',
      action: '清空运行日志',
      result: 'success',
    })
    expect(operations.entries[0]?.summary).toMatch(/^删除 2 条记录，释放 /)
  })

  it('清空失败时不写留痕', async () => {
    const { service, store } = createHarness({ clearFails: true })
    await expect(service.clear('runtime')).rejects.toThrow()
    expect(store.runtimeInserts).toHaveLength(0)
  })

  it('连清两次状态等价：第二次删掉的正是第一次的留痕', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    const first = await service.clear('runtime')
    const second = await service.clear('runtime')

    expect(first.rowCount).toBe(1)
    expect(second.rowCount).toBe(1)
    expect((await service.runtimeLog()).entries).toHaveLength(1)
  })

  it('清空从未写过日志的类别：rowCount 与字节都是 0，oldestAt 为 null', async () => {
    const { service } = createHarness()

    const report = await service.clear('operation')

    expect(report).toMatchObject({ category: 'operation', rowCount: 0, totalBytes: 0, oldestAt: null })
    expect(report.clearedAt).toBe(NOW.toISOString())
  })

  it('清空只清本类别：另一个类别的记录不动', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '运行一条')
    await service.recordOperation({ category: 'logs', action: '清空操作日志', result: 'success' })

    const report = await service.clear('operation')

    expect(report.rowCount).toBe(1)
    const runtime = await service.runtimeLog()
    expect(runtime.entries.some((entry) => entry.message === '运行一条')).toBe(true)
    expect(runtime.entries.some((entry) => entry.source === 'logs.clear')).toBe(true)
  })
})

describe('巡检', () => {
  it('runSweep 写入巡检状态，留痕不再提压缩', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '一条')

    const result = await service.runSweep('runtime', 'manual')

    expect(result.compressed).toBe(0)
    expect(result.removedTmp).toBe(0)
    const report = await service.runtimeLog()
    expect(report.storage.lastSweepAt).toBe(NOW.toISOString())
    expect(report.storage.trimmedBySize).toBe(false)
    expect(
      report.entries.some(
        (entry) => entry.source === 'logs.retention' && entry.message.includes('保留巡检完成：删除'),
      ),
    ).toBe(true)
    expect(report.entries.some((entry) => entry.message.includes('压缩'))).toBe(false)
  })

  it('首次巡检请求注册定时器（每类别一次，间隔 5 分钟）', async () => {
    const { service, state } = createHarness()
    expect(state.timers).toHaveLength(0)

    await service.runSweep('runtime', 'manual')
    await service.runSweep('runtime', 'manual')
    expect(state.timers).toHaveLength(1)

    await service.runSweep('operation', 'manual')
    expect(state.timers).toHaveLength(2)
    expect(LOG_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000)
    expect(state.timers[0]?.intervalMs).toBe(LOG_SWEEP_INTERVAL_MS)
  })

  it('并发触发同一类别合并到同一次（返回同一个结果）', async () => {
    const harness = createHarness()
    const first = harness.service.runSweep('runtime', 'manual')
    const second = harness.service.runSweep('runtime', 'manual')
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
  })

  it('after-clear 的巡检不再重复写摘要行（清空后正好一条运行留痕）', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    await service.clear('runtime')

    const report = await service.runtimeLog()
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]?.source).toBe('logs.clear')
    expect(report.storage.lastSweepAt).toBe(NOW.toISOString())
  })

  it('登录日志按时间倒序读回，地址归一、归属地由地址推导、用户代理单行化', async () => {
    const { service, state } = createHarness()
    await service.recordLogin({ ip: '127.0.0.1', userAgent: 'Browser/1', status: 'failure' })
    state.clock = new Date(NOW.getTime() + 1000)
    await service.recordLogin({ ip: '10.1.2.3', userAgent: 'Browser/2', status: 'success' })
    state.clock = new Date(NOW.getTime() + 2000)
    await service.recordLogin({ ip: 'not-an-ip', userAgent: 'bad\nagent', status: 'success' })

    const report = await service.loginLog()
    expect(report.entries.map((entry) => entry.ip)).toEqual(['未知', '10.1.2.3', '127.0.0.1'])
    expect(report.entries.map((entry) => entry.location)).toEqual(['未知', '内网', '本机'])
    expect(report.entries.map((entry) => entry.status)).toEqual(['success', 'success', 'failure'])
    expect(report.entries[0]?.userAgent).toBe('bad agent')
    expect(report.entries[2]?.userAgent).toBe('Browser/1')
    expect(report.truncated).toBe(false)
    expect(report.skippedLines).toBe(0)
  })
})

describe('维护锁', () => {
  it('clear 与 sweep 互斥：并发时先后完成且不清空结果丢失', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    const sweeping = service.runSweep('runtime', 'manual')
    await yieldToQueue()
    const clearing = service.clear('runtime')
    const [sweep, cleared] = await Promise.all([sweeping, clearing])

    expect(sweep.at).toBeTruthy()
    expect(cleared.rowCount).toBeGreaterThanOrEqual(0)
    expect((await service.runtimeLog()).entries.some((entry) => entry.source === 'logs.clear')).toBe(true)
  })
})

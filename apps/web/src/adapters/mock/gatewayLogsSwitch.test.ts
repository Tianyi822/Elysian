import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { MockFilesAdapter, MockLogsAdapter } from './mockAdapters'
import { SEED_RUNTIME_LOGS } from './logsData'

/*
 * gateway 日志片的分流断言：容器内三类日志都走真实端点，缺省仍是内存演示。
 * 事件流固定 'memory'，不创建指向不存在端点的 EventSource。
 */

/** 端点形状的最小合法响应：两个 GET 都用它，够验证接线与解析放行。 */
const EMPTY_REPORT = {
  entries: [],
  total: 0,
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  storage: {
    totalBytes: 0,
    runtimeBytes: 0,
    operationBytes: 0,
    runtimeRowCount: 0,
    operationRowCount: 0,
    rowCount: 0,
    oldestAt: null,
    lastSweepAt: null,
    trimmedBySize: false,
    droppedRecords: 0,
    failedWrites: 0,
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createMockGateway 日志片分流', () => {
  it('缺省装配：日志是内存演示实现', () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.logs).toBeInstanceOf(MockLogsAdapter)
  })

  it("显式 logs: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', logs: 'mock' })
    expect(gateway.logs).toBeInstanceOf(MockLogsAdapter)
  })

  it("logs: 'http' 只把日志换成 HTTP adapter，其余片不受影响", () => {
    const gateway = createMockGateway({ eventStream: 'memory', logs: 'http' })
    expect(gateway.logs).not.toBeInstanceOf(MockLogsAdapter)
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
  })

  it("logs: 'http'：三类日志都落到同源 /api/logs", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(EMPTY_REPORT), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', logs: 'http' })

    await gateway.logs.runtimeLog()
    await gateway.logs.operationLogs()
    await gateway.logs.loginLogs()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/logs/runtime',
      '/api/logs/operation',
      '/api/logs/login',
    ])
  })

  it('reset() 把清空过的日志恢复回种子', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await gateway.logs.clearLogs('runtime')
    expect((await gateway.logs.runtimeLog()).entries).toHaveLength(1)

    await gateway.reset()
    expect((await gateway.logs.runtimeLog()).entries).toEqual(SEED_RUNTIME_LOGS)
  })
})

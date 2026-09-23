import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { MockFilesAdapter, MockLogsAdapter } from './mockAdapters'
import { SEED_LOGIN_LOGS, SEED_RUNTIME_LOGS } from './logsData'

/*
 * gateway 日志片的分流断言：运行与操作两类在容器内走真实端点，登录日志没有真实端点，
 * 两种取值下都读内存演示。事件流固定 'memory'，不创建指向不存在端点的 EventSource。
 */

/** 端点形状的最小合法响应：两个 GET 都用它，够验证接线与解析放行。 */
const EMPTY_REPORT = {
  entries: [],
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  storage: {
    totalBytes: 0,
    runtimeBytes: 0,
    operationBytes: 0,
    fileCount: 0,
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

  it("logs: 'http'：两类日志落到同源 /api/logs，登录日志不发请求", async () => {
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
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/logs/runtime',
      '/api/logs/operation',
    ])

    fetchMock.mockClear()
    expect(await gateway.logs.loginLogs()).toEqual(SEED_LOGIN_LOGS)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reset() 把清空过的日志恢复回种子', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await gateway.logs.clearLogs('runtime')
    expect((await gateway.logs.runtimeLog()).entries).toHaveLength(1)

    await gateway.reset()
    expect((await gateway.logs.runtimeLog()).entries).toEqual(SEED_RUNTIME_LOGS)
  })
})

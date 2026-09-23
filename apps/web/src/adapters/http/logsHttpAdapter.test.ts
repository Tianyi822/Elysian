import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEED_LOGIN_LOGS } from '../mock/logsData'
import {
  createHttpLogsAdapter,
  parseLogClearResponse,
  parseLogStorage,
  parseOperationLogEntry,
  parseOperationLogResponse,
  parseRuntimeLogEntry,
  parseRuntimeLogResponse,
} from './logsHttpAdapter'

/*
 * 纯解析函数的契约测试 + fetch 接线断言，不发任何真实请求。
 * 形状样例对齐规格的端点表：运行日志条目五字段、操作日志条目十一字段、
 * 报告带截断标记与存储统计、清空响应包在 `{ cleared }` 里。
 */

const realStorageRow = {
  totalBytes: 320 * 1024,
  runtimeBytes: 256 * 1024,
  operationBytes: 64 * 1024,
  fileCount: 3,
  oldestAt: '2026-09-22T17:29:58.611Z',
  lastSweepAt: null,
  trimmedBySize: false,
  droppedRecords: 0,
  failedWrites: 0,
}

const realRuntimeRow = {
  id: '2026-09-23T03:24:54.123Z#10241',
  at: '2026-09-23T03:24:54.123Z',
  level: 'info',
  source: 'server.lifecycle',
  message: 'Elysian 服务已启动：http://127.0.0.1:48101',
}

const realOperationRow = {
  id: '2026-09-23T03:25:10.004Z#7',
  at: '2026-09-23T03:25:10.004Z',
  category: 'security',
  action: '修改 SSH 监听端口',
  target: 'sshd',
  summary: '端口 2222',
  result: 'success',
  actor: 'panel',
  method: 'PUT',
  path: '/api/security/ssh/port',
  httpStatus: 200,
}

describe('parseRuntimeLogEntry', () => {
  it('接受真实形状的运行日志条目', () => {
    expect(parseRuntimeLogEntry(realRuntimeRow)).toEqual(realRuntimeRow)
  })

  it('等级不在契约表内、缺字段或类型不对时抛中文错误', () => {
    expect(() => parseRuntimeLogEntry(null)).toThrow('日志响应格式无效')
    expect(() => parseRuntimeLogEntry({ ...realRuntimeRow, level: 'fatal' })).toThrow(
      '运行日志等级响应无效',
    )
    expect(() => parseRuntimeLogEntry({ ...realRuntimeRow, id: 7 })).toThrow('日志id响应无效')
    expect(() => parseRuntimeLogEntry({ ...realRuntimeRow, at: undefined })).toThrow(
      '日志时间响应无效',
    )
    expect(() => parseRuntimeLogEntry({ ...realRuntimeRow, message: '' })).not.toThrow()
  })
})

describe('parseOperationLogEntry', () => {
  it('接受真实形状的操作日志条目，含没有对象与请求信息的条目', () => {
    expect(parseOperationLogEntry(realOperationRow)).toEqual(realOperationRow)
    const bare = {
      ...realOperationRow,
      target: null,
      method: null,
      path: null,
      httpStatus: null,
    }
    expect(parseOperationLogEntry(bare)).toEqual(bare)
  })

  it('分类或结果不在契约表内、状态码类型不对时抛中文错误', () => {
    expect(() => parseOperationLogEntry({ ...realOperationRow, category: 'network' })).toThrow(
      '操作日志分类响应无效',
    )
    expect(() => parseOperationLogEntry({ ...realOperationRow, result: 'skipped' })).toThrow(
      '操作日志结果响应无效',
    )
    expect(() => parseOperationLogEntry({ ...realOperationRow, httpStatus: '200' })).toThrow(
      '操作日志状态码响应无效',
    )
  })
})

describe('parseLogStorage', () => {
  it('接受真实形状的存储统计，Byte 计数非负', () => {
    expect(parseLogStorage(realStorageRow)).toEqual(realStorageRow)
  })

  it('计数为负、非数或布尔标志类型不对时抛中文错误', () => {
    expect(() => parseLogStorage({ ...realStorageRow, totalBytes: -1 })).toThrow(
      '日志大小统计响应无效',
    )
    expect(() => parseLogStorage({ ...realStorageRow, fileCount: '3' })).toThrow(
      '日志大小统计响应无效',
    )
    expect(() => parseLogStorage({ ...realStorageRow, trimmedBySize: 'false' })).toThrow(
      '日志大小统计响应无效',
    )
    expect(() => parseLogStorage({ ...realStorageRow, oldestAt: 0 })).toThrow(
      '日志可空字段响应无效',
    )
  })
})

describe('parseRuntimeLogResponse / parseOperationLogResponse', () => {
  it('接受两份报告：条目数组、截断标记、坏行计数与存储统计', () => {
    const runtime = {
      entries: [realRuntimeRow],
      truncated: true,
      skippedLines: 2,
      skippedFiles: 1,
      storage: realStorageRow,
    }
    const operation = {
      entries: [realOperationRow],
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: realStorageRow,
    }
    expect(parseRuntimeLogResponse(runtime)).toEqual(runtime)
    expect(parseOperationLogResponse(operation)).toEqual(operation)
  })

  it('entries 不是数组、缺 storage 或标记类型不对时抛中文错误', () => {
    const base = { entries: [], truncated: false, skippedLines: 0, skippedFiles: 0, storage: realStorageRow }
    expect(() => parseRuntimeLogResponse({ ...base, entries: null })).toThrow(
      '运行日志响应无效：应为数组',
    )
    expect(() => parseOperationLogResponse({ ...base, entries: {} })).toThrow(
      '操作日志响应无效：应为数组',
    )
    expect(() => parseRuntimeLogResponse({ ...base, storage: undefined })).toThrow(
      '日志响应格式无效',
    )
    expect(() => parseRuntimeLogResponse({ ...base, truncated: 1 })).toThrow(
      '日志截断标记响应无效',
    )
    expect(() => parseOperationLogResponse({ ...base, skippedFiles: -2 })).toThrow(
      '日志坏文件计数响应无效',
    )
  })
})

describe('parseLogClearResponse', () => {
  it('接受 `{ cleared }` 包裹的清空报告', () => {
    const report = {
      category: 'runtime',
      fileCount: 4,
      totalBytes: 33_000_000,
      oldestAt: '2026-09-16T11:24:54.000Z',
      clearedAt: '2026-09-23T04:00:00.000Z',
    }
    expect(parseLogClearResponse({ cleared: report })).toEqual(report)
  })

  it('缺 cleared、类别越界或时间缺失时抛中文错误', () => {
    expect(() => parseLogClearResponse({})).toThrow('日志响应格式无效')
    expect(() =>
      parseLogClearResponse({
        cleared: { category: 'login', fileCount: 0, totalBytes: 0, oldestAt: null, clearedAt: 'x' },
      }),
    ).toThrow('日志清空类别响应无效')
    expect(() =>
      parseLogClearResponse({
        cleared: { category: 'runtime', fileCount: 0, totalBytes: 0, oldestAt: null },
      }),
    ).toThrow('日志清空时间响应无效')
  })
})

describe('createHttpLogsAdapter 的请求接线', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('网络失败、非 JSON 与服务端错误消息都翻译成中文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('boom'))))
    await expect(createHttpLogsAdapter().runtimeLog()).rejects.toThrow('日志请求网络失败')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(createHttpLogsAdapter().operationLogs()).rejects.toThrow('日志响应不是有效 JSON')

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: '未知日志端点：GET /runtime' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    await expect(createHttpLogsAdapter().runtimeLog()).rejects.toThrow('未知日志端点：GET /runtime')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })))
    await expect(createHttpLogsAdapter().runtimeLog()).rejects.toThrow('日志请求失败：HTTP 503')
  })

  it('登录日志不发请求：本期没有登录端点，两套实现读同一份演示种子', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await createHttpLogsAdapter().loginLogs()).toEqual(SEED_LOGIN_LOGS)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

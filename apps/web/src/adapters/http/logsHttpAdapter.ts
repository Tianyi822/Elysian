import { withRequestDeadline } from './requestDeadline'
import type {
  LogClearReport,
  LogStorageStats,
  LoginLogEntry,
  LoginLogListQuery,
  LoginLogListReport,
  LoginLogStatus,
  LogListQuery,
  OperationLogCategory,
  OperationLogEntry,
  OperationLogListQuery,
  OperationLogListReport,
  OperationLogOutcome,
  PlatformLogCategory,
  PlatformLogLevel,
  RuntimeLogEntry,
  RuntimeLogListReport,
} from '@elysian/contracts'
import {
  LOGIN_LOG_STATUSES,
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_OUTCOMES,
  PLATFORM_LOG_CATEGORIES,
  PLATFORM_LOG_LEVELS,
} from '@elysian/contracts'
import type { LogsAdapter } from '../../contracts/adapters'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

/*
 * 浏览器侧同源平台日志（Docker 运行时）。服务端把运行日志与操作日志写进部署机器的
 * ~/.Elysian/logs/platform/{runtime,operation,login}/，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 filesHttpAdapter 一致。
 */

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('日志响应格式无效')
  }
  return value as Record<string, unknown>
}

/** 必填字符串字段；label 是报错文案里的中文字段名，缺省用 JSON 字段名。 */
function asString(row: Record<string, unknown>, key: string, label = key): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new Error(`日志${label}响应无效`)
  }
  return value
}

/** 可空字符串字段：null 与缺失都归一为 null（服务端没有对象或没有请求信息时给 null）。 */
function asNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new Error('日志可空字段响应无效')
  }
  return value
}

function asNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(`日志${field}响应无效`)
  }
  return value
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`日志${field}响应无效`)
  }
  return value
}

/** 校验存储统计：三项字节数与非负计数、两个可空时间、两个布尔标志。 */
export function parseLogStorage(value: unknown): LogStorageStats {
  const row = asObject(value)
  return {
    totalBytes: asNonNegativeNumber(row.totalBytes, '大小统计'),
    runtimeBytes: asNonNegativeNumber(row.runtimeBytes, '大小统计'),
    operationBytes: asNonNegativeNumber(row.operationBytes, '大小统计'),
    rowCount: asNonNegativeNumber(row.rowCount, '大小统计'),
    runtimeRowCount: asNonNegativeNumber(row.runtimeRowCount, '大小统计'),
    operationRowCount: asNonNegativeNumber(row.operationRowCount, '大小统计'),
    oldestAt: asNullableString(row.oldestAt),
    lastSweepAt: asNullableString(row.lastSweepAt),
    trimmedBySize: asBoolean(row.trimmedBySize, '大小统计'),
    droppedRecords: asNonNegativeNumber(row.droppedRecords, '大小统计'),
    failedWrites: asNonNegativeNumber(row.failedWrites, '大小统计'),
  }
}

/** 校验一条运行日志条目：等级取值必须在契约表内，时间与正文齐全。 */
export function parseRuntimeLogEntry(value: unknown): RuntimeLogEntry {
  const row = asObject(value)
  const level = row.level
  if (typeof level !== 'string' || !PLATFORM_LOG_LEVELS.includes(level as PlatformLogLevel)) {
    throw new Error('运行日志等级响应无效')
  }
  return {
    id: asString(row, 'id'),
    at: asString(row, 'at', '时间'),
    level: level as PlatformLogLevel,
    source: asString(row, 'source', '来源'),
    message: asString(row, 'message', '正文'),
  }
}

/** 校验 GET /runtime 响应：条目数组（倒序）、截断标记、坏行/坏文件计数与存储统计。 */
export function parseRuntimeLogResponse(body: unknown): RuntimeLogListReport {
  const row = asObject(body)
  const entries = row.entries
  if (!Array.isArray(entries)) {
    throw new Error('运行日志响应无效：应为数组')
  }
  return {
    entries: entries.map((entry) => parseRuntimeLogEntry(entry)),
    total: asNonNegativeNumber(row.total, '总数'),
    truncated: asBoolean(row.truncated, '截断标记'),
    skippedLines: asNonNegativeNumber(row.skippedLines, '坏行计数'),
    skippedFiles: asNonNegativeNumber(row.skippedFiles, '坏文件计数'),
    storage: parseLogStorage(row.storage),
  }
}

/** 校验一条登录日志条目：状态取值必须在契约表内。 */
export function parseLoginLogEntry(value: unknown): LoginLogEntry {
  const row = asObject(value)
  const status = row.status
  if (typeof status !== 'string' || !LOGIN_LOG_STATUSES.includes(status as LoginLogStatus)) {
    throw new Error('登录日志状态响应无效')
  }
  return {
    id: asString(row, 'id'),
    ip: asString(row, 'ip', '来源'),
    location: asString(row, 'location', '归属地'),
    userAgent: asString(row, 'userAgent', '用户代理'),
    status: status as LoginLogStatus,
    time: asString(row, 'time', '时间'),
  }
}

/** 校验 GET /login 响应：条目数组（倒序）、截断标记、坏行/坏文件计数。 */
export function parseLoginLogResponse(body: unknown): LoginLogListReport {
  const row = asObject(body)
  const entries = row.entries
  if (!Array.isArray(entries)) {
    throw new Error('登录日志响应无效：应为数组')
  }
  return {
    entries: entries.map((entry) => parseLoginLogEntry(entry)),
    total: asNonNegativeNumber(row.total, '总数'),
    truncated: asBoolean(row.truncated, '截断标记'),
    skippedLines: asNonNegativeNumber(row.skippedLines, '坏行计数'),
    skippedFiles: asNonNegativeNumber(row.skippedFiles, '坏文件计数'),
  }
}

/** 校验一条操作日志条目：分类与结果取值必须在契约表内。 */
export function parseOperationLogEntry(value: unknown): OperationLogEntry {
  const row = asObject(value)
  const category = row.category
  if (typeof category !== 'string' || !OPERATION_LOG_CATEGORIES.includes(category as OperationLogCategory)) {
    throw new Error('操作日志分类响应无效')
  }
  const result = row.result
  if (typeof result !== 'string' || !OPERATION_LOG_OUTCOMES.includes(result as OperationLogOutcome)) {
    throw new Error('操作日志结果响应无效')
  }
  const httpStatus = row.httpStatus
  if (httpStatus !== undefined && httpStatus !== null && typeof httpStatus !== 'number') {
    throw new Error('操作日志状态码响应无效')
  }
  return {
    id: asString(row, 'id'),
    at: asString(row, 'at', '时间'),
    category: category as OperationLogCategory,
    action: asString(row, 'action', '动作'),
    target: asNullableString(row.target),
    summary: asString(row, 'summary', '摘要'),
    result: result as OperationLogOutcome,
    method: asNullableString(row.method),
    path: asNullableString(row.path),
    httpStatus: httpStatus ?? null,
  }
}

/** 校验 GET /operation 响应：条目数组（倒序）、截断标记、坏行/坏文件计数与存储统计。 */
export function parseOperationLogResponse(body: unknown): OperationLogListReport {
  const row = asObject(body)
  const entries = row.entries
  if (!Array.isArray(entries)) {
    throw new Error('操作日志响应无效：应为数组')
  }
  return {
    entries: entries.map((entry) => parseOperationLogEntry(entry)),
    total: asNonNegativeNumber(row.total, '总数'),
    truncated: asBoolean(row.truncated, '截断标记'),
    skippedLines: asNonNegativeNumber(row.skippedLines, '坏行计数'),
    skippedFiles: asNonNegativeNumber(row.skippedFiles, '坏文件计数'),
    storage: parseLogStorage(row.storage),
  }
}

/** 校验清空响应 `{ cleared: LogClearReport }`：回的是已删除的事实。 */
export function parseLogClearResponse(body: unknown): LogClearReport {
  const row = asObject(asObject(body).cleared)
  const category = row.category
  if (typeof category !== 'string' || !PLATFORM_LOG_CATEGORIES.includes(category as PlatformLogCategory)) {
    throw new Error('日志清空类别响应无效')
  }
  return {
    category: category as PlatformLogCategory,
    rowCount: asNonNegativeNumber(row.rowCount, '清空文件数'),
    totalBytes: asNonNegativeNumber(row.totalBytes, '清空大小'),
    oldestAt: asNullableString(row.oldestAt),
    clearedAt: asString(row, 'clearedAt', '清空时间'),
  }
}

/** 列表 GET 的查询串：只追加有值的字段，全空则返回空字符串（URL 不以 ? 结尾）。 */
function appendLogListQueryParams(params: URLSearchParams, query: LogListQuery): void {
  if (query.q !== undefined) params.set('q', query.q)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.before !== undefined) params.set('before', query.before)
  if (query.beforeId !== undefined) params.set('beforeId', String(query.beforeId))
}

function operationLogQueryString(query?: OperationLogListQuery): string {
  if (!query) return ''
  const params = new URLSearchParams()
  if (query.category !== undefined) params.set('category', query.category)
  if (query.result !== undefined) params.set('result', query.result)
  appendLogListQueryParams(params, query)
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function loginLogQueryString(query?: LoginLogListQuery): string {
  if (!query) return ''
  const params = new URLSearchParams()
  appendLogListQueryParams(params, query)
  if (query.status !== undefined) params.set('status', query.status)
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function runtimeLogQueryString(query?: LogListQuery): string {
  if (!query) return ''
  const params = new URLSearchParams()
  appendLogListQueryParams(params, query)
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  return withRequestDeadline(init, (bounded) => readJson(url, bounded))
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchWithSession(url, init)
  } catch {
    throw new Error('日志请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `日志请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('日志响应不是有效 JSON')
  }
}

/**
 * Docker 运行时的日志 adapter：运行、操作与登录三类都落到 /api/logs/*。
 * 清空是写端点，请求体固定空对象 `{}`——统一守卫链要求非 GET 请求有可读的请求体，
 * 类别取自路径（服务端的清空路由由契约常量推导），请求体不参与路由决策。
 * 登录日志不在可清空类别里。
 */
export function createHttpLogsAdapter(baseUrl = '/api/logs'): LogsAdapter {
  return {
    async runtimeLog(query?: LogListQuery) {
      return parseRuntimeLogResponse(await requestJson(`${baseUrl}/runtime${runtimeLogQueryString(query)}`))
    },

    async loginLogs(query?: LoginLogListQuery) {
      return parseLoginLogResponse(await requestJson(`${baseUrl}/login${loginLogQueryString(query)}`))
    },

    async operationLogs(query?: OperationLogListQuery) {
      return parseOperationLogResponse(
        await requestJson(`${baseUrl}/operation${operationLogQueryString(query)}`),
      )
    },

    async clearLogs(category: PlatformLogCategory) {
      return parseLogClearResponse(
        await requestJson(`${baseUrl}/${category}/clear`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    },
  }
}

import {
  LOG_ENTRY_FETCH_LIMIT,
  LOGIN_LOG_STATUSES,
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_OUTCOMES,
  type LogListQuery,
  type LoginLogListQuery,
  type LoginLogStatus,
  type OperationLogCategory,
  type OperationLogListQuery,
  type OperationLogOutcome,
} from '@elysian/contracts'
import { invalidRequest } from '../middleware/guard.ts'

const BEFORE_ID_RE = /^[1-9]\d*$/

function isEnumValue<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value)
}

function parseSharedListQuery(searchParams: URLSearchParams): LogListQuery {
  const query: LogListQuery = {}

  if (searchParams.has('q')) {
    const q = searchParams.get('q') ?? ''
    if (q !== '') query.q = q
  }

  if (searchParams.has('limit')) {
    const raw = searchParams.get('limit') ?? ''
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > LOG_ENTRY_FETCH_LIMIT) {
      throw invalidRequest(`limit 无效：应为 1 到 ${LOG_ENTRY_FETCH_LIMIT} 的整数`)
    }
    query.limit = n
  }

  const hasBefore = searchParams.has('before')
  const hasBeforeId = searchParams.has('beforeId')
  if (hasBefore !== hasBeforeId) {
    throw invalidRequest('before 与 beforeId 必须成对提供')
  }
  if (hasBefore && hasBeforeId) {
    const before = searchParams.get('before') ?? ''
    if (Number.isNaN(Date.parse(before))) {
      throw invalidRequest('before 无效：应为可解析的时间')
    }
    const beforeIdRaw = searchParams.get('beforeId') ?? ''
    if (!BEFORE_ID_RE.test(beforeIdRaw)) {
      throw invalidRequest('beforeId 无效：应为正整数')
    }
    query.before = before
    query.beforeId = Number(beforeIdRaw)
  }

  return query
}

export function parseRuntimeListQuery(searchParams: URLSearchParams): LogListQuery {
  return parseSharedListQuery(searchParams)
}

export function parseOperationListQuery(searchParams: URLSearchParams): OperationLogListQuery {
  const query: OperationLogListQuery = parseSharedListQuery(searchParams)

  if (searchParams.has('category')) {
    const category = searchParams.get('category') ?? ''
    if (!isEnumValue(OPERATION_LOG_CATEGORIES, category)) {
      throw invalidRequest(`操作日志分类无效：${category}`)
    }
    query.category = category as OperationLogCategory
  }

  if (searchParams.has('result')) {
    const result = searchParams.get('result') ?? ''
    if (!isEnumValue(OPERATION_LOG_OUTCOMES, result)) {
      throw invalidRequest(`操作结果无效：${result}`)
    }
    query.result = result as OperationLogOutcome
  }

  return query
}

export function parseLoginListQuery(searchParams: URLSearchParams): LoginLogListQuery {
  const query: LoginLogListQuery = parseSharedListQuery(searchParams)

  if (searchParams.has('status')) {
    const status = searchParams.get('status') ?? ''
    if (!isEnumValue(LOGIN_LOG_STATUSES, status)) {
      throw invalidRequest(`登录状态无效：${status}`)
    }
    query.status = status as LoginLogStatus
  }

  return query
}

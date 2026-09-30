import type { LoginLogStatus } from './logs.ts'
import type { OperationLogCategory, OperationLogOutcome } from './platformLogs.ts'
import { LOG_ENTRY_FETCH_LIMIT } from './platformLogs.ts'

export type LogListQuery = {
  q?: string
  limit?: number
  before?: string
  beforeId?: number
}

export type OperationLogListQuery = LogListQuery & {
  category?: OperationLogCategory
  result?: OperationLogOutcome
}

export type LoginLogListQuery = LogListQuery & {
  status?: LoginLogStatus
}

export type LogPage<T> = {
  entries: readonly T[]
  total: number
  truncated: boolean
}

/** 排序与翻页游标用的数字键：纯数字 id 直接解析，否则取末尾 `#<digits>`。 */
function logNumericSortKey(id: string): number {
  if (/^\d+$/.test(id)) {
    return Number(id)
  }
  const suffix = id.match(/#(\d+)$/)
  if (suffix) {
    return Number(suffix[1])
  }
  return Number.NaN
}

function compareLogEntries<T extends { id: string; at: string }>(a: T, b: T): number {
  if (a.at !== b.at) {
    return a.at > b.at ? -1 : 1
  }
  const idA = logNumericSortKey(a.id)
  const idB = logNumericSortKey(b.id)
  if (idA !== idB) {
    return idA > idB ? -1 : 1
  }
  return 0
}

export function pageByQuery<T extends { id: string; at: string }>(
  entries: readonly T[],
  query: LogListQuery,
  matches: (entry: T, keyword: string) => boolean,
): LogPage<T> {
  const keyword = query.q?.trim() ?? ''
  const matched = entries.filter((entry) => matches(entry, keyword))
  const sorted = [...matched].sort(compareLogEntries)
  const total = sorted.length

  let window = sorted
  if (query.before !== undefined && query.beforeId !== undefined) {
    const before = query.before
    const beforeId = query.beforeId
    window = sorted.filter(
      (entry) =>
        entry.at < before || (entry.at === before && logNumericSortKey(entry.id) < beforeId),
    )
  }

  const limit = Math.min(query.limit ?? LOG_ENTRY_FETCH_LIMIT, LOG_ENTRY_FETCH_LIMIT)
  const truncated = window.length > limit
  const pageEntries = window.slice(0, limit)

  return {
    entries: pageEntries,
    total,
    truncated,
  }
}

import type { LoginLogStatus } from './logs.ts'
import type { OperationLogCategory, OperationLogOutcome } from './platformLogs.ts'

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

function compareLogEntries<T extends { id: string; at: string }>(a: T, b: T): number {
  if (a.at !== b.at) {
    return a.at > b.at ? -1 : 1
  }
  const idA = Number(a.id)
  const idB = Number(b.id)
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
  const matched = entries.filter((entry) => keyword === '' || matches(entry, keyword))
  const sorted = [...matched].sort(compareLogEntries)
  const total = sorted.length

  let window = sorted
  if (query.before !== undefined && query.beforeId !== undefined) {
    const before = query.before
    const beforeId = query.beforeId
    window = sorted.filter(
      (entry) =>
        entry.at < before || (entry.at === before && Number(entry.id) < beforeId),
    )
  }

  const limit = query.limit ?? 1000
  const truncated = window.length > limit
  const pageEntries = window.slice(0, limit)

  return {
    entries: pageEntries,
    total,
    truncated,
  }
}

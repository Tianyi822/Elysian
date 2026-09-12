import { AUDIT_KINDS } from '@elysian/contracts'
import type { AuditRecord } from '@elysian/contracts'

/** 审计日志的筛选条件与地址之间的转换，规则与事件中心一致。 */

export type AuditQuery = {
  kinds: readonly string[]
  q: string
}

export const AUDIT_QUERY_KINDS = AUDIT_KINDS

function splitParam(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort()
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  return {
    kinds: splitParam(params.get('kind')).filter((kind) =>
      (AUDIT_QUERY_KINDS as readonly string[]).includes(kind),
    ),
    q: (params.get('q') ?? '').trim(),
  }
}

export function toAuditSearchParams(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.kinds.length > 0) params.set('kind', [...query.kinds].sort().join(','))
  if (query.q.length > 0) params.set('q', query.q)
  return params
}

/** 关键词在摘要、详情、对象与操作者四个字段里匹配，大小写不敏感。 */
export function matchesAuditQuery(record: AuditRecord, query: AuditQuery): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(record.kind)) return false
  if (query.q.length === 0) return true

  const needle = query.q.toLowerCase()
  return [record.summary, record.detail, record.subject, record.actor, record.traceId].some(
    (field) => field.toLowerCase().includes(needle),
  )
}

export function hasActiveAuditFilters(query: AuditQuery): boolean {
  return query.kinds.length > 0 || query.q.length > 0
}

export function toggleKind(kinds: readonly string[], kind: string): string[] {
  return kinds.includes(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind]
}

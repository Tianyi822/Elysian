import type { IncidentSort, IncidentListQuery } from '../../contracts/adapters'

/**
 * 事件中心筛选条件与地址之间的双向转换。筛选进地址，所以这一层是纯函数，
 * 单独测试即可覆盖。
 */

export const INCIDENT_SORTS: readonly IncidentSort[] = ['detected-desc', 'detected-asc', 'severity']

export const INCIDENT_SORT_LABELS: Record<IncidentSort, string> = {
  'detected-desc': '按发生时间（新到旧）',
  'detected-asc': '按发生时间（旧到新）',
  severity: '按严重等级',
}

export const DEFAULT_INCIDENT_SORT: IncidentSort = 'detected-desc'

function splitParam(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort()
}

export function parseIncidentQuery(params: URLSearchParams): IncidentListQuery {
  const sortParam = params.get('sort')
  const sort = INCIDENT_SORTS.find((candidate) => candidate === sortParam) ?? DEFAULT_INCIDENT_SORT
  return {
    severities: splitParam(params.get('severity')),
    statuses: splitParam(params.get('status')),
    sources: splitParam(params.get('source')),
    sort,
  }
}

export function toIncidentSearchParams(query: IncidentListQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.severities && query.severities.length > 0) {
    params.set('severity', [...query.severities].sort().join(','))
  }
  if (query.statuses && query.statuses.length > 0) {
    params.set('status', [...query.statuses].sort().join(','))
  }
  if (query.sources && query.sources.length > 0) {
    params.set('source', [...query.sources].sort().join(','))
  }
  if (query.sort && query.sort !== DEFAULT_INCIDENT_SORT) {
    params.set('sort', query.sort)
  }
  return params
}

export function toggleValue(list: readonly string[] | undefined, value: string): string[] {
  const current = list ?? []
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
}

export function hasActiveFilters(query: IncidentListQuery): boolean {
  return Boolean(
    (query.severities && query.severities.length > 0) ||
      (query.statuses && query.statuses.length > 0) ||
      (query.sources && query.sources.length > 0),
  )
}

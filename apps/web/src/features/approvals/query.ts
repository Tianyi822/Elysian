import { APPROVAL_STATUSES, RISK_LEVELS, RISK_RANK } from '@elysian/contracts'
import type { ApprovalRequest } from '@elysian/contracts'

/** 审批队列的筛选、排序与定位，全部走地址，规则与事件中心一致。 */

export const APPROVAL_SORTS = ['requested-desc', 'risk-desc', 'risk-asc'] as const
export type ApprovalSort = (typeof APPROVAL_SORTS)[number]

export const APPROVAL_SORT_LABELS: Record<ApprovalSort, string> = {
  'requested-desc': '按提出时间（新到旧）',
  'risk-desc': '按风险等级（高到低）',
  'risk-asc': '按风险等级（低到高）',
}

export const DEFAULT_APPROVAL_SORT: ApprovalSort = 'risk-desc'

export type ApprovalQuery = {
  statuses: readonly string[]
  risks: readonly string[]
  sort: ApprovalSort
  /** 从事故详情跳过来时要定位的审批条目。 */
  focus?: string
}

function splitParam(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort()
}

export function parseApprovalQuery(params: URLSearchParams): ApprovalQuery {
  const sortParam = params.get('sort')
  const sort = APPROVAL_SORTS.find((candidate) => candidate === sortParam) ?? DEFAULT_APPROVAL_SORT
  const focus = params.get('focus')?.trim()

  return {
    statuses: splitParam(params.get('status')).filter((status) =>
      (APPROVAL_STATUSES as readonly string[]).includes(status),
    ),
    risks: splitParam(params.get('risk')).filter((risk) =>
      (RISK_LEVELS as readonly string[]).includes(risk),
    ),
    sort,
    ...(focus ? { focus } : {}),
  }
}

export function toApprovalSearchParams(query: ApprovalQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.statuses.length > 0) params.set('status', [...query.statuses].sort().join(','))
  if (query.risks.length > 0) params.set('risk', [...query.risks].sort().join(','))
  if (query.sort !== DEFAULT_APPROVAL_SORT) params.set('sort', query.sort)
  if (query.focus) params.set('focus', query.focus)
  return params
}

export function matchesApprovalQuery(approval: ApprovalRequest, query: ApprovalQuery): boolean {
  if (query.statuses.length > 0 && !query.statuses.includes(approval.status)) return false
  if (query.risks.length > 0 && !query.risks.includes(approval.riskLevel)) return false
  return true
}

export function hasActiveApprovalFilters(query: ApprovalQuery): boolean {
  return query.statuses.length > 0 || query.risks.length > 0
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/**
 * 排序后把被定位的那一条钉到最前：从事故详情跳过来时，
 * 用户要看的正是这一条，不该让他在长列表里自己找。
 */
export function sortApprovals(
  approvals: readonly ApprovalRequest[],
  sort: ApprovalSort,
  focus?: string,
): ApprovalRequest[] {
  const sorted = [...approvals]
  switch (sort) {
    case 'risk-asc':
      sorted.sort(
        (a, b) =>
          RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel] || compareRequestedDesc(a, b),
      )
      break
    case 'risk-desc':
      sorted.sort(
        (a, b) =>
          RISK_RANK[b.riskLevel] - RISK_RANK[a.riskLevel] || compareRequestedDesc(a, b),
      )
      break
    case 'requested-desc':
    default:
      sorted.sort(compareRequestedDesc)
      break
  }

  if (focus) {
    const index = sorted.findIndex((approval) => approval.id === focus)
    if (index > 0) {
      const [focused] = sorted.splice(index, 1)
      if (focused) sorted.unshift(focused)
    }
  }

  return sorted
}

function compareRequestedDesc(a: ApprovalRequest, b: ApprovalRequest): number {
  return a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0
}

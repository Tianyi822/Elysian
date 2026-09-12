import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import {
  DEFAULT_APPROVAL_SORT,
  hasActiveApprovalFilters,
  matchesApprovalQuery,
  parseApprovalQuery,
  sortApprovals,
  toApprovalSearchParams,
  toggleValue,
} from './query'

const dataset = createMockDataset()

describe('审批筛选条件与地址的互转', () => {
  it('空地址解析为默认排序、空筛选、无定位', () => {
    expect(parseApprovalQuery(new URLSearchParams(''))).toEqual({
      statuses: [],
      risks: [],
      sort: DEFAULT_APPROVAL_SORT,
    })
  })

  it('多值与未知取值都按规则处理', () => {
    const query = parseApprovalQuery(
      new URLSearchParams('status=approved,pending&risk=critical,不存在&sort=risk-asc'),
    )
    expect(query.statuses).toEqual(['approved', 'pending'])
    expect(query.risks).toEqual(['critical'])
    expect(query.sort).toBe('risk-asc')
  })

  it('未知排序回落默认值', () => {
    expect(parseApprovalQuery(new URLSearchParams('sort=乱写')).sort).toBe(DEFAULT_APPROVAL_SORT)
  })

  it('定位参数单独解析，不被当成筛选条件', () => {
    const query = parseApprovalQuery(new URLSearchParams('focus=INC-2100-A-1-APR'))
    expect(query.focus).toBe('INC-2100-A-1-APR')
    expect(query.statuses).toEqual([])
    expect(query.risks).toEqual([])
  })

  it('序列化与解析互为逆运算，默认值不写进地址', () => {
    const query = {
      statuses: ['approved', 'pending'],
      risks: ['high'],
      sort: 'risk-asc' as const,
      focus: 'APR-1',
    }
    expect(parseApprovalQuery(toApprovalSearchParams(query))).toEqual(query)
    expect(toApprovalSearchParams({ statuses: [], risks: [], sort: DEFAULT_APPROVAL_SORT }).toString()).toBe('')
  })

  it('筛选判定按状态与风险两个维度取交集', () => {
    const pending = dataset.approvals.find((approval) => approval.status === 'pending')
    expect(pending).toBeDefined()
    if (!pending) return

    expect(matchesApprovalQuery(pending, { statuses: [], risks: [], sort: 'risk-desc' })).toBe(true)
    expect(
      matchesApprovalQuery(pending, { statuses: ['pending'], risks: [], sort: 'risk-desc' }),
    ).toBe(true)
    expect(
      matchesApprovalQuery(pending, { statuses: ['expired'], risks: [], sort: 'risk-desc' }),
    ).toBe(false)
    expect(
      matchesApprovalQuery(pending, {
        statuses: [],
        risks: [pending.riskLevel === 'critical' ? 'low' : 'critical'],
        sort: 'risk-desc',
      }),
    ).toBe(false)
  })

  it('toggleValue 与 hasActiveApprovalFilters 行为符合预期', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a'], 'a')).toEqual([])
    expect(hasActiveApprovalFilters({ statuses: [], risks: [], sort: 'risk-desc' })).toBe(false)
    expect(
      hasActiveApprovalFilters({ statuses: [], risks: [], sort: 'risk-desc', focus: 'APR-1' }),
    ).toBe(false)
    expect(hasActiveApprovalFilters({ statuses: ['pending'], risks: [], sort: 'risk-desc' })).toBe(
      true,
    )
  })
})

describe('审批排序', () => {
  it('风险从高到低', () => {
    const sorted = sortApprovals(dataset.approvals, 'risk-desc')
    const ranks = sorted.map((approval) =>
      approval.riskLevel === 'critical' ? 4 : approval.riskLevel === 'high' ? 3 : approval.riskLevel === 'medium' ? 2 : 1,
    )
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
  })

  it('风险从低到高', () => {
    const sorted = sortApprovals(dataset.approvals, 'risk-asc')
    const ranks = sorted.map((approval) =>
      approval.riskLevel === 'critical' ? 4 : approval.riskLevel === 'high' ? 3 : approval.riskLevel === 'medium' ? 2 : 1,
    )
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('按提出时间从新到旧', () => {
    const sorted = sortApprovals(dataset.approvals, 'requested-desc')
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]
      const current = sorted[index]
      expect(previous && current && previous.requestedAt >= current.requestedAt).toBe(true)
    }
  })

  it('被定位的条目钉到最前，其余顺序不变', () => {
    const base = sortApprovals(dataset.approvals, 'risk-desc')
    const last = base[base.length - 1]
    expect(last).toBeDefined()
    if (!last) return

    const pinned = sortApprovals(dataset.approvals, 'risk-desc', last.id)
    expect(pinned[0]?.id).toBe(last.id)
    expect(pinned).toHaveLength(base.length)
    expect(pinned.slice(1).map((approval) => approval.id)).toEqual(
      base.filter((approval) => approval.id !== last.id).map((approval) => approval.id),
    )
  })

  it('定位到不存在的条目时保持原顺序', () => {
    const base = sortApprovals(dataset.approvals, 'risk-desc')
    expect(sortApprovals(dataset.approvals, 'risk-desc', '不存在的标识')).toEqual(base)
  })
})

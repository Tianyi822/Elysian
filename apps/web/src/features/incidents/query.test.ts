import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INCIDENT_SORT,
  hasActiveFilters,
  parseIncidentQuery,
  toIncidentSearchParams,
  toggleValue,
} from './query'

describe('事件中心筛选条件与地址的互转', () => {
  it('空地址解析为默认排序与空筛选', () => {
    expect(parseIncidentQuery(new URLSearchParams(''))).toEqual({
      severities: [],
      statuses: [],
      sources: [],
      sort: DEFAULT_INCIDENT_SORT,
    })
  })

  it('多值参数按逗号拆开并去空白', () => {
    const query = parseIncidentQuery(
      new URLSearchParams('severity=sev1, sev2&status=open&source=prometheus,cloud'),
    )
    expect(query.severities).toEqual(['sev1', 'sev2'])
    expect(query.statuses).toEqual(['open'])
    expect(query.sources).toEqual(['cloud', 'prometheus'])
  })

  it('未知排序回落默认值，不把无效值带进查询', () => {
    expect(parseIncidentQuery(new URLSearchParams('sort=whatever')).sort).toBe(
      DEFAULT_INCIDENT_SORT,
    )
  })

  it('序列化与解析互为逆运算', () => {
    // 取值在地址里按字典序排列，解析结果因此是规范化的顺序。
    const query = {
      severities: ['sev1', 'sev2'],
      statuses: ['analyzing', 'open'],
      sources: ['cloud'],
      sort: 'severity' as const,
    }
    expect(parseIncidentQuery(toIncidentSearchParams(query))).toEqual(query)
  })

  it('默认排序与空筛选都不写进地址，保持地址干净', () => {
    expect(toIncidentSearchParams({ sort: DEFAULT_INCIDENT_SORT }).toString()).toBe('')
    expect(
      toIncidentSearchParams({ severities: [], statuses: [], sources: [] }).toString(),
    ).toBe('')
  })

  it('toggleValue 返回新数组，不修改入参', () => {
    const base = ['a']
    expect(toggleValue(base, 'b')).toEqual(['a', 'b'])
    expect(toggleValue(base, 'a')).toEqual([])
    expect(base).toEqual(['a'])
    expect(toggleValue(undefined, 'a')).toEqual(['a'])
  })

  it('hasActiveFilters 只在真有筛选时为真', () => {
    expect(hasActiveFilters({ sort: 'severity' })).toBe(false)
    expect(hasActiveFilters({ severities: [], statuses: [], sources: [] })).toBe(false)
    expect(hasActiveFilters({ severities: ['sev1'] })).toBe(true)
    expect(hasActiveFilters({ sources: ['cloud'] })).toBe(true)
  })
})

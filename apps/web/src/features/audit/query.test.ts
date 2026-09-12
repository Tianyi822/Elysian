import { describe, expect, it } from 'vitest'
import {
  AUDIT_QUERY_KINDS,
  hasActiveAuditFilters,
  matchesAuditQuery,
  parseAuditQuery,
  toAuditSearchParams,
  toggleKind,
} from './query'

describe('审计筛选条件与地址的互转', () => {
  it('空地址解析为空条件', () => {
    expect(parseAuditQuery(new URLSearchParams(''))).toEqual({ kinds: [], q: '' })
  })

  it('多值类型参数按逗号拆开并规范化顺序', () => {
    expect(parseAuditQuery(new URLSearchParams('kind=tool-call,event')).kinds).toEqual([
      'event',
      'tool-call',
    ])
  })

  it('未知类型被丢弃，不会让界面出现空筛选维度', () => {
    expect(parseAuditQuery(new URLSearchParams('kind=event,不存在')).kinds).toEqual(['event'])
    expect(AUDIT_QUERY_KINDS).toHaveLength(5)
  })

  it('关键词两端空白被去掉', () => {
    expect(parseAuditQuery(new URLSearchParams('q=%20重启%20')).q).toBe('重启')
  })

  it('序列化与解析互为逆运算，空条件不写进地址', () => {
    const query = { kinds: ['approval', 'event'], q: '重启' }
    expect(parseAuditQuery(toAuditSearchParams(query))).toEqual(query)
    expect(toAuditSearchParams({ kinds: [], q: '' }).toString()).toBe('')
  })

  it('关键词在摘要、详情、对象、操作者与追踪标识里匹配，大小写不敏感', () => {
    const record = {
      id: 'INC-2100-AUD-1',
      at: '2026-09-12T08:00:00.000Z',
      kind: 'event' as const,
      actor: '监控',
      subject: 'INC-2100',
      summary: '事故创建：order-service sev1',
      detail: '来源 alertmanager',
      traceId: 'trace-INC-2100',
    }
    expect(matchesAuditQuery(record, { kinds: [], q: '' })).toBe(true)
    expect(matchesAuditQuery(record, { kinds: [], q: 'ORDER-SERVICE' })).toBe(true)
    expect(matchesAuditQuery(record, { kinds: [], q: 'alertmanager' })).toBe(true)
    expect(matchesAuditQuery(record, { kinds: [], q: '监控' })).toBe(true)
    expect(matchesAuditQuery(record, { kinds: [], q: 'trace-INC' })).toBe(true)
    expect(matchesAuditQuery(record, { kinds: [], q: '不存在' })).toBe(false)
    expect(matchesAuditQuery(record, { kinds: ['approval'], q: '' })).toBe(false)
    expect(matchesAuditQuery(record, { kinds: ['event'], q: 'order' })).toBe(true)
  })

  it('toggleKind 增删都返回新数组', () => {
    const base = ['event']
    expect(toggleKind(base, 'approval')).toEqual(['event', 'approval'])
    expect(toggleKind(base, 'event')).toEqual([])
    expect(base).toEqual(['event'])
  })

  it('hasActiveAuditFilters 只在真有筛选时为真', () => {
    expect(hasActiveAuditFilters({ kinds: [], q: '' })).toBe(false)
    expect(hasActiveAuditFilters({ kinds: ['event'], q: '' })).toBe(true)
    expect(hasActiveAuditFilters({ kinds: [], q: 'x' })).toBe(true)
  })
})

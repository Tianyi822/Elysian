import { describe, expect, it } from 'vitest'
import { LOG_ENTRY_FETCH_LIMIT, logRetentionText, pageByQuery, type LogListQuery } from '@elysian/contracts'

const rows = [
  { id: '3', at: '2026-09-23T00:00:02.000Z', message: 'Alpha' },
  { id: '2', at: '2026-09-23T00:00:02.000Z', message: 'beta' },
  { id: '1', at: '2026-09-23T00:00:01.000Z', message: '100%_ok' },
]

const match = (entry: (typeof rows)[number], keyword: string) =>
  entry.message.toLowerCase().includes(keyword.toLowerCase())

describe('pageByQuery', () => {
  it('按 at 降序、同一时刻按数字 id 降序，total 不计翻页', () => {
    const page = pageByQuery(rows, { limit: 2 }, match)
    expect(page.total).toBe(3)
    expect(page.truncated).toBe(true)
    expect(page.entries.map((entry) => entry.id)).toEqual(['3', '2'])
  })

  it('before 与 beforeId 取严格更早的行', () => {
    const query: LogListQuery = { limit: 2, before: '2026-09-23T00:00:02.000Z', beforeId: 3 }
    const page = pageByQuery(rows, query, match)
    expect(page.entries.map((entry) => entry.id)).toEqual(['2', '1'])
    expect(page.total).toBe(3)
    expect(page.truncated).toBe(false)
  })

  it('关键字大小写不敏感，% 与 _ 按字面匹配', () => {
    expect(pageByQuery(rows, { q: 'ALPHA' }, match).entries.map((entry) => entry.id)).toEqual(['3'])
    expect(pageByQuery(rows, { q: '100%_ok' }, match).total).toBe(1)
  })

  it('缺省 limit 是 1000', () => {
    expect(pageByQuery(rows, {}, match).entries).toHaveLength(3)
  })

  it('同一 at 下 composite id 按 # 后缀排序，before + beforeId 只取更旧行', () => {
    const composite = [
      { id: '2026-09-23T00:00:02.000Z#12', at: '2026-09-23T00:00:02.000Z', message: 'newer' },
      { id: '2026-09-23T00:00:02.000Z#11', at: '2026-09-23T00:00:02.000Z', message: 'older' },
      { id: '2026-09-23T00:00:01.000Z#1', at: '2026-09-23T00:00:01.000Z', message: 'prev' },
    ]
    const page = pageByQuery(
      composite,
      { before: '2026-09-23T00:00:02.000Z', beforeId: 12 },
      match,
    )
    expect(page.entries.map((entry) => entry.id)).toEqual(['2026-09-23T00:00:02.000Z#11', '2026-09-23T00:00:01.000Z#1'])
  })

  it('limit 超过 LOG_ENTRY_FETCH_LIMIT 时最多返回 LOG_ENTRY_FETCH_LIMIT 条', () => {
    const many = Array.from({ length: LOG_ENTRY_FETCH_LIMIT + 5 }, (_, index) => ({
      id: String(LOG_ENTRY_FETCH_LIMIT + 5 - index),
      at: `2026-09-23T00:00:${String(index).padStart(2, '0')}.000Z`,
      message: 'x',
    }))
    const page = pageByQuery(many, { limit: 5000 }, match)
    expect(page.entries).toHaveLength(LOG_ENTRY_FETCH_LIMIT)
    expect(page.truncated).toBe(true)
    expect(page.total).toBe(LOG_ENTRY_FETCH_LIMIT + 5)
  })
})

describe('logRetentionText', () => {
  it('保留说明含从最旧记录自动删除', () => {
    expect(logRetentionText('runtime')).toContain('超出后从最旧的记录开始自动删除')
  })
})

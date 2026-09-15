import { describe, expect, it } from 'vitest'
import { formatResultTable } from './formatResultTable'

describe('结果表格排版', () => {
  it('按单元格显示宽度补齐，中文按两格宽计', () => {
    const lines = formatResultTable(['id', 'name'], [['1', '爱丽丝'], ['2', 'bob']])

    expect(lines).toEqual([
      '+----+--------+',
      '| id | name   |',
      '+----+--------+',
      '| 1  | 爱丽丝 |',
      '| 2  | bob    |',
      '+----+--------+',
    ])
  })

  it('没有行时只给表头与分隔线', () => {
    expect(formatResultTable(['n'], [])).toEqual(['+---+', '| n |', '+---+'])
  })
})

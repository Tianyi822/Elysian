import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  LATIN_ADVANCE_EM,
  LEVEL_COLUMN_PX,
  LEVEL_LABEL_CHARS,
  LOG_CELL_FONT_PX,
  LOG_CELL_PADDING_PX,
  LogTable,
  MESSAGE_COLUMN_MIN_PX,
  MONO_ADVANCE_EM,
  RUNTIME_LOG_TABLE_MIN_PX,
  STATUS_TAG_CHROME_PX,
  TIMESTAMP_CHARS,
  TIMESTAMP_COLUMN_PX,
  fixedColumnDemand,
} from './LogTable'
import type { LogColumn } from './LogTable'

/*
 * 列宽不是估的：时间与等级两列的内容是固定字符数，单元格用等宽字体加 tabular-nums，
 * 每个字符的前进宽度因此相同，「列宽 = 字符数 × 字宽 + 内距」是一条能断言的算式。
 * 第一组用例把算式与取定的列宽钉在一起——改字号或改列宽会让断言先红。
 */

describe('固定列宽的取值依据', () => {
  it('时间列：19 个字符 × 0.6em × 12px + 24px 内距 ≤ 176px', () => {
    expect(fixedColumnDemand().timestamp).toBe(
      TIMESTAMP_CHARS * MONO_ADVANCE_EM * LOG_CELL_FONT_PX + LOG_CELL_PADDING_PX,
    )
    expect(fixedColumnDemand().timestamp).toBeLessThanOrEqual(TIMESTAMP_COLUMN_PX)
  })

  it('等级列：最长等级 warning 7 个拉丁字符 × 0.62em × 12px + 标签与单元格内距 ≤ 96px', () => {
    expect(fixedColumnDemand().level).toBe(
      LEVEL_LABEL_CHARS * LATIN_ADVANCE_EM * LOG_CELL_FONT_PX + STATUS_TAG_CHROME_PX + LOG_CELL_PADDING_PX,
    )
    expect(fixedColumnDemand().level).toBeLessThanOrEqual(LEVEL_COLUMN_PX)
    expect(LEVEL_LABEL_CHARS).toBe(7)
  })

  it('表格最小宽度是三列之和（176 + 96 + 560 = 832）', () => {
    expect(RUNTIME_LOG_TABLE_MIN_PX).toBe(832)
    expect(TIMESTAMP_COLUMN_PX + LEVEL_COLUMN_PX + MESSAGE_COLUMN_MIN_PX).toBe(RUNTIME_LOG_TABLE_MIN_PX)
  })
})

type Row = { id: string; first: string; second: string; message: string }

const COLUMNS: readonly LogColumn<Row>[] = [
  { label: '第一列', widthClass: 'w-44', cell: (row) => <td className="font-mono tabular-nums">{row.first}</td> },
  { label: '第二列', widthClass: 'w-24', cell: (row) => <td>{row.second}</td> },
  { label: '第三列', cell: (row) => <td className="truncate">{row.message}</td> },
]

function renderTable(rows: readonly Row[]) {
  return render(
    <LogTable
      label="测试日志表"
      minWidthClass="min-w-[832px]"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.id}
      emptyMessage="没有匹配的记录"
    />,
  )
}

function region(): HTMLElement {
  return screen.getByRole('region', { name: '测试日志表' })
}

describe('日志表格', () => {
  const rows: readonly Row[] = [
    { id: 'a', first: '2026-09-23 11:24:54', second: '信息', message: '第一条' },
    { id: 'b', first: '2026-09-23 11:25:54', second: '警告', message: '第二条' },
  ]

  it('渲染固定列表格：列宽写在 col 上，表头吸顶，表格有最小宽度', () => {
    renderTable(rows)

    const table = within(region()).getByRole('table')
    expect(table).toHaveClass('table-fixed', 'min-w-[832px]')

    const cols = table.querySelectorAll('col')
    expect(cols).toHaveLength(3)
    expect(cols[0]).toHaveClass('w-44')
    expect(cols[1]).toHaveClass('w-24')
    // 最后一列不给宽度：吃掉剩余空间，由表格的 min-width 兜住下限。
    expect(cols[2]?.getAttribute('class')).toBeFalsy()

    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).toHaveClass('sticky', 'top-0')
    }

    // 表头 + 两条数据行
    expect(within(table).getAllByRole('row')).toHaveLength(3)
  })

  it('没有行时给出一条跨列的空提示，而不是空表', () => {
    renderTable([])

    const table = within(region()).getByRole('table')
    const cell = within(table).getByRole('cell')
    expect(cell).toHaveTextContent('没有匹配的记录')
    expect(cell).toHaveAttribute('colspan', '3')
  })
})

import { terminalTextWidth } from '@elysian/contracts'

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - terminalTextWidth(text)))
}

/**
 * 把结果集排版成对齐的文本表格：列宽取该列所有单元格的最大显示宽度，
 * 中文与全角字符按终端栅格口径计两格，否则等宽字体下会错位。
 */
export function formatResultTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const widths = columns.map((column, index) =>
    Math.max(terminalTextWidth(column), ...rows.map((row) => terminalTextWidth(row[index] ?? ''))),
  )
  const rule = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`
  const renderRow = (cells: readonly string[]) =>
    `|${widths.map((width, index) => ` ${pad(cells[index] ?? '', width)} `).join('|')}|`

  const lines = [rule, renderRow(columns), rule, ...rows.map(renderRow)]
  if (rows.length > 0) lines.push(rule)
  return lines
}

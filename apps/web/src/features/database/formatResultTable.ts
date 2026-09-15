/**
 * 把结果集排版成对齐的文本表格：列宽取该列所有单元格的最大显示宽度，
 * 中文与全角字符按两格宽计，否则等宽字体下会错位。
 */
const FULL_WIDTH = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

/** 单元格的显示宽度：半角 1、全角（含中文）2。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += FULL_WIDTH.test(char) ? 2 : 1
  return width
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

export function formatResultTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  )
  const rule = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`
  const renderRow = (cells: readonly string[]) =>
    `|${widths.map((width, index) => ` ${pad(cells[index] ?? '', width)} `).join('|')}|`

  const lines = [rule, renderRow(columns), rule, ...rows.map(renderRow)]
  if (rows.length > 0) lines.push(rule)
  return lines
}

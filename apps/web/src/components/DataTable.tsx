import type { ReactNode } from 'react'

/**
 * 密集表格原语。列宽由 columns 显式给出并用 colgroup 固定，
 * 因此筛选、排序或状态变化都不会引起列宽跳动；数字列右对齐并使用等宽数字。
 */

export type DataTableColumn = {
  key: string
  header: string
  /** 显式列宽，例如 '88px' 或 '26%'。 */
  width: string
  numeric?: boolean
}

export function DataTable({
  label,
  columns,
  children,
}: {
  label: string
  columns: readonly DataTableColumn[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded border border-line bg-surface">
      <table aria-label={label} className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead className="bg-surface-raised text-xs text-fg-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`border-b border-line px-2 py-1.5 font-medium ${column.numeric ? 'text-right' : 'text-left'}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function DataRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-line/60 last:border-b-0 hover:bg-surface-raised/60">{children}</tr>
  )
}

export function DataCell({
  children,
  numeric = false,
  muted = false,
}: {
  children: ReactNode
  numeric?: boolean
  muted?: boolean
}) {
  return (
    <td
      className={`px-2 py-1.5 align-top ${numeric ? 'text-right tabular-nums' : ''} ${muted ? 'text-fg-muted' : ''}`}
    >
      {children}
    </td>
  )
}

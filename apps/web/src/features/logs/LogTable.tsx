import type { ReactNode } from 'react'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

/** Existing timestamp formatting remains 19 characters. */
export const TIMESTAMP_CHARS = 19

/** Log requests remain server-owned; this wrapper only supplies table behavior. */
export type LogColumn<T> = DataTableColumn<T>
export function LogTable<T>({ label, columns, rows, rowKey, emptyMessage, busy, query, onQueryChange, selectionKey }: {
  label: string; columns: readonly LogColumn<T>[]; rows: readonly T[];
  rowKey: (row: T) => string; emptyMessage: ReactNode; busy?: boolean;
  query?: string; onQueryChange?: (query: string) => void;
  selectionKey?: string;
}) {
  return <DataTable ariaLabel={label} columns={columns} rows={rows} getRowId={rowKey}
    busy={busy} query={query} onQueryChange={onQueryChange} filterMode="external"
    searchPlaceholder={`搜索${label.replace(/表$/, '')}`} selectionKey={selectionKey}
    emptyState={<p className="text-sm text-fg-muted">{emptyMessage}</p>} />
}

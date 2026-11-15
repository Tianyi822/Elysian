import { DataTableActivityContext } from './dataTableActivity'
import { DataTable as EasyUIDataTable, type DataTableProps as EasyUIDataTableProps } from './easyui/DataTable'
export type { DataTableColumn, SortState, Id } from './easyui/DataTable'

export type DataTableProps<T> = EasyUIDataTableProps<T>

/** One adapter for every business table; callers retain data and request ownership. */
export function DataTable<T>(props: DataTableProps<T>) {
  return <DataTableActivityContext.Provider value={{ active: props.active ?? true, scope: `${props.selectionKey ?? ''}\0${props.query ?? ''}` }}><EasyUIDataTable {...props} /></DataTableActivityContext.Provider>
}

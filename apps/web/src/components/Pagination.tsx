import type { ReactNode } from 'react'
import { SlidePagination } from './easyui/SlidePagination'
import { cn } from './easyui/utils'

export interface PaginationProps {
  label?: string
  summary: ReactNode
  pageSize: number
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  showControls?: boolean
  disabled?: boolean
  className?: string
}

/** 全站页码分页：调用方拥有数据、当前页和搜索复位，统一摘要与 EasyUI 展示。 */
export function Pagination({
  label = '分页', summary, pageSize, page, pageCount, onPageChange,
  showControls = true, disabled = false, className,
}: PaginationProps) {
  return <div className={cn('flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-muted', className)}>
    <span className="tabular-nums">{summary} · 每页 {pageSize} 条</span>
    <SlidePagination ariaLabel={label} pageCount={pageCount} page={page} onChange={onPageChange}
      showControls={showControls} disabled={disabled} />
  </div>
}

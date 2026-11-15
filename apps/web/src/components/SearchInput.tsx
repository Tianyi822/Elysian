import { forwardRef } from 'react'
import { IOSSearchBar, type IOSSearchBarProps } from './easyui/IOSSearchBar'
import { cn } from './easyui/utils'

export interface SearchInputProps extends Omit<IOSSearchBarProps, 'inputRef' | 'label'> {
  label: string
  /** Menus and narrow table cells keep their existing fixed search slot. */
  expandOnFocus?: boolean
}

/** 全局受控搜索：页面继续拥有过滤、防抖、请求与输入限制，仅复用 EasyUI 展示和清空交互。 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({
  className, size = 'sm', expandOnFocus = true, collapsedWidth = '220px', expandedWidth = '340px', label, placeholder, ...props
}, ref) {
  return <div className={cn('flex w-[340px] min-w-0 max-w-full items-center', className)}>
    <IOSSearchBar {...props} label={label} placeholder={placeholder ?? label} inputRef={ref} size={size}
      collapsedWidth={expandOnFocus ? collapsedWidth : '100%'}
      expandedWidth={expandOnFocus ? expandedWidth : '100%'} />
  </div>
})

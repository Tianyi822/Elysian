import { useEffect, useRef } from 'react'

/** 首载与仅切换筛选不等待；尚未提交的新关键词继续走原有 300 ms 防抖。 */
export function useDebouncedSearch(search: string, reload: () => void, filterKey?: string): string {
  const query = search.trim()
  const committedSearch = useRef(query)

  useEffect(() => {
    const delay = query === committedSearch.current ? 0 : 300
    const timer = setTimeout(() => {
      committedSearch.current = query
      reload()
    }, delay)
    return () => clearTimeout(timer)
  }, [query, reload, filterKey])

  return query
}

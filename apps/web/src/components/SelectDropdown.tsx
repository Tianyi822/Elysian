import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FORM_CONTROL_HEIGHT_CLASS } from './formControl'
import { IconButton } from './IconButton'
import { Check, ChevronDown, Search, X } from './icons'

/**
 * 自定义单选下拉：Radix 触发器 + 候选项，不使用原生 select，因此不会呼出操作系统的下拉控件。
 * 值集合由调用方决定，在这里收窄回联合类型。
 *
 * 工具栏里的筛选下拉给 `label`（字段名前缀）与 `active`（筛选生效中）：只有当前值时，
 * 一排下拉读起来就是几个重复的词，看不出各自在筛什么。
 * 表单用 `fullWidth`，顶栏收起后的页签用 `triggerClassName` 自己控制显隐，菜单仍走这里。
 * 浮层不锁页面滚动：默认的模态锁会按滚动条宽度给 body 加 margin，窄屏上会把整页挤窄。
 * 菜单通过 Portal 挂到 body。对话框自己的滚动锁会在 document 上取消滚轮默认行为，
 * 因此可滚动的菜单要拦下 wheel / touchmove，否则列表滚不动。
 * 候选项文字一律靠左；选中勾放在文字后面，不在左侧留空列。
 * 版本等长列表可给 search：搜索固定在浮层顶部，本地过滤防抖 300ms；输入法组合期间
 * 不过滤，清空与 Enter 立即生效，关闭后重置，不改变已选值。
 */

/** 对话框滚动锁在 document 冒泡阶段取消滚轮。菜单自己能滚时拦住事件，滚轮才作用在列表上。 */
function bindMenuScroll(node: HTMLDivElement | null, cleanup: { current: (() => void) | null }) {
  cleanup.current?.()
  cleanup.current = null
  if (!node) return
  const canScroll = () => node.scrollHeight > node.clientHeight + 1
  const onWheel = (event: WheelEvent) => {
    if (!canScroll()) return
    const atTop = node.scrollTop <= 0
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) event.preventDefault()
    event.stopPropagation()
  }
  const onTouchMove = (event: TouchEvent) => {
    if (!canScroll()) return
    event.stopPropagation()
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  node.addEventListener('touchmove', onTouchMove, { passive: true })
  cleanup.current = () => {
    node.removeEventListener('wheel', onWheel)
    node.removeEventListener('touchmove', onTouchMove)
  }
}

/** 方向键聚焦用了 preventScroll，这里只滚动菜单自身，避免把外层对话框一起带动。 */
function revealFocusedItem(event: FocusEvent<HTMLDivElement>) {
  const item = event.target
  const container = event.currentTarget
  if (!(item instanceof HTMLElement) || item === container) return
  const containerRect = container.getBoundingClientRect()
  const itemRect = item.getBoundingClientRect()
  if (itemRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - itemRect.top
  } else if (itemRect.bottom > containerRect.bottom) {
    container.scrollTop += itemRect.bottom - containerRect.bottom
  }
}

export function SelectDropdown<T extends string>({
  ariaLabel,
  label,
  active = false,
  items,
  value,
  onSelect,
  fallbackLabel,
  fullWidth = false,
  disabled = false,
  id,
  emptyLabel,
  mono = false,
  className,
  triggerClassName,
  valueClassName,
  align = 'start',
  search,
}: {
  id?: string
  ariaLabel: string
  /** 触发器里的字段名前缀，如「分类」；与当前值并排显示。 */
  label?: string
  /** 筛选生效中：描边、底色与文字走 accent，让「有筛选」不只在浮层里看得见。 */
  active?: boolean
  items: readonly { value: T; label: string }[]
  /** undefined 表示尚未选择，触发器显示 fallbackLabel。 */
  value: T | undefined
  onSelect: (value: T) => void
  /** 值不在候选项里时触发器显示的占位文案。 */
  fallbackLabel?: string
  /** 表单场景拉满可用宽度；工具栏保持内容宽度。 */
  fullWidth?: boolean
  disabled?: boolean
  /** 候选项为空时浮层里的说明，避免点开是一个看不见的空盒。 */
  emptyLabel?: string
  /** 值与候选项用等宽字体，适合账号名、文件所有者。 */
  mono?: boolean
  /** 追加到默认触发器上，例如表单行里的上边距。triggerClassName 存在时忽略。 */
  className?: string
  /**
   * 整段替换触发器类名。顶栏收起态要在 hidden 与 inline-flex 之间切换，
   * 不能再叠一层默认的 inline-flex。
   */
  triggerClassName?: string
  /** 当前值文字的附加类名，顶栏收起态用来把值从触发器的次要色里提亮。 */
  valueClassName?: string
  align?: 'start' | 'end'
  /** 浮层内搜索；候选项由组件过滤，调用方始终提供完整集合。 */
  search?: { ariaLabel: string; placeholder: string }
}) {
  const [open, setOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [committedSearch, setCommittedSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusAfterFilter = useRef<'first' | 'last' | null>(null)
  const searchable = Boolean(search)
  const focusOption = (direction: 'first' | 'last') => {
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    const option = direction === 'first' ? options?.[0] : options?.[options.length - 1]
    option?.focus()
  }

  useEffect(() => {
    if (!open || !searchable || composing) return
    const query = searchText.trim()
    if (!query) { setCommittedSearch(''); return }
    const timer = setTimeout(() => setCommittedSearch(query), 300)
    return () => clearTimeout(timer)
  }, [open, searchable, searchText, composing])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
    if (focusAfterFilter.current) {
      focusOption(focusAfterFilter.current)
      focusAfterFilter.current = null
    }
  }, [committedSearch])

  const visibleItems = searchable
    ? items.filter((item) => item.label.toLowerCase().includes(committedSearch.toLowerCase()))
    : items
  const clearSearch = () => {
    setSearchText('')
    setCommittedSearch('')
    setComposing(false)
    searchInput.current?.focus()
  }
  const matched = value !== undefined ? items.find((item) => item.value === value) : undefined
  const valueLabel = matched?.label || fallbackLabel || value || ''
  const showPlaceholder = !matched && Boolean(fallbackLabel)
  const selected = active && !fullWidth
  const fieldTrigger =
    `inline-flex ${FORM_CONTROL_HEIGHT_CLASS} w-full items-center justify-between gap-1.5 rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-60`
  const filterTrigger = `inline-flex ${FORM_CONTROL_HEIGHT_CLASS} shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors ${
    selected
      ? 'border-accent/50 bg-accent/10 text-accent'
      : 'border-line bg-surface-raised text-fg hover:border-fg-subtle'
  }`
  const triggerClass =
    triggerClassName ?? `${fullWidth ? fieldTrigger : filterTrigger}${className ? ` ${className}` : ''}`
  const valueClass = [
    'min-w-0 truncate tabular-nums',
    mono ? 'font-mono' : '',
    valueClassName ?? '',
    showPlaceholder ? 'text-fg-subtle' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const scrollCleanup = useRef<(() => void) | null>(null)
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node
    bindMenuScroll(node, scrollCleanup)
  }, [])

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={(next) => {
      setOpen(next)
      setSearchText('')
      setCommittedSearch('')
      setComposing(false)
      focusAfterFilter.current = null
    }}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={`${ariaLabel}：${valueLabel}`}
          className={triggerClass}
        >
          {label && !fullWidth && !triggerClassName ? (
            <span className={selected ? 'text-accent' : 'text-fg-muted'}>{label}</span>
          ) : null}
          <span className={valueClass}>{valueLabel}</span>
          <ChevronDown aria-hidden size={13} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={ariaLabel}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onFocus={searchable ? (event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault()
              searchInput.current?.focus()
            }
          } : undefined}
          className={`z-[70] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface text-left text-sm shadow-lg ${
            fullWidth ? 'w-[var(--radix-dropdown-menu-trigger-width)]' : 'min-w-32 text-xs'
          }`}
        >
          {search ? <div className="border-b border-line p-2">
            <div className="relative">
              <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                ref={searchInput}
                aria-label={search.ariaLabel}
                autoComplete="off"
                placeholder={search.placeholder}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(event) => { setSearchText(event.currentTarget.value); setComposing(false) }}
                onKeyDown={(event) => {
                  // 保留 Escape 交给 Radix；文字输入不能触发菜单 typeahead 或空格选项。
                  if (event.key === 'Escape' && !composing && !event.nativeEvent.isComposing) return
                  event.stopPropagation()
                  if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Enter') { event.preventDefault(); setCommittedSearch(searchText.trim()) }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const direction = event.key === 'ArrowDown' ? 'first' : 'last'
                    const query = searchText.trim()
                    if (query !== committedSearch) {
                      focusAfterFilter.current = direction
                      setCommittedSearch(query)
                    } else focusOption(direction)
                  }
                }}
                className={`${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-line bg-surface-raised pl-8 pr-9 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`}
              />
              {searchText ? <IconButton
                label="清空搜索"
                variant="ghost"
                onPress={clearSearch}
                onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
                className="absolute right-1 top-1/2 -translate-y-1/2"
              ><X aria-hidden size={13} /></IconButton> : null}
            </div>
          </div> : null}
          <div
            ref={attachScroll}
            onFocus={revealFocusedItem}
            className="hover-scrollbar max-h-60 overflow-y-auto overscroll-contain p-1"
            style={{ maxHeight: searchable ? 'min(15rem, calc(var(--radix-dropdown-menu-content-available-height, 20rem) - 5rem))' : 'min(15rem, var(--radix-dropdown-menu-content-available-height, 15rem))' }}
          >
            {visibleItems.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-fg-muted">{emptyLabel ?? '没有可选项'}</p>
            ) : (
              <DropdownMenu.RadioGroup value={value ?? ''} onValueChange={(next) => onSelect(next as T)}>
                {visibleItems.map((item, index) => (
                  <DropdownMenu.RadioItem
                    key={item.value}
                    value={item.value}
                    onPointerMove={searchable ? (event) => { if (document.activeElement === searchInput.current) event.preventDefault() } : undefined}
                    onKeyDown={searchable ? (event) => {
                      if (event.key === 'ArrowUp' && index === 0) {
                        event.preventDefault()
                        event.stopPropagation()
                        searchInput.current?.focus()
                      }
                    } : undefined}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left outline-none text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                  >
                    <span className={`min-w-0 truncate text-left tabular-nums ${mono ? 'font-mono' : ''}`}>{item.label}</span>
                    {item.value === value ? <Check aria-hidden size={13} className="shrink-0" /> : null}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            )}
          </div>
          {search ? <p role="status" className="border-t border-line px-3 py-1.5 text-xs text-fg-muted tabular-nums">
            {searchText.trim() !== committedSearch ? '正在筛选…' : `显示 ${visibleItems.length} / ${items.length} 项`}
          </p> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

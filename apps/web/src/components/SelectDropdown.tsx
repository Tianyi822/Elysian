import { useCallback, useRef, type FocusEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FORM_CONTROL_HEIGHT_CLASS } from './formControl'
import { Check, ChevronDown } from './icons'

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
}) {
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
    bindMenuScroll(node, scrollCleanup)
  }, [])

  return (
    <DropdownMenu.Root modal={false}>
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
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={`z-[70] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface text-left text-sm shadow-lg ${
            fullWidth ? 'min-w-[var(--radix-dropdown-menu-trigger-width)]' : 'min-w-32 text-xs'
          }`}
        >
          <div
            ref={attachScroll}
            onFocus={revealFocusedItem}
            className="hover-scrollbar max-h-60 overflow-y-auto overscroll-contain p-1"
            style={{ maxHeight: 'min(15rem, var(--radix-dropdown-menu-content-available-height, 15rem))' }}
          >
            {items.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-fg-muted">{emptyLabel ?? '没有可选项'}</p>
            ) : (
              <DropdownMenu.RadioGroup value={value ?? ''} onValueChange={(next) => onSelect(next as T)}>
                {items.map((item) => (
                  <DropdownMenu.RadioItem
                    key={item.value}
                    value={item.value}
                    className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-left outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                  >
                    <span className={`min-w-0 truncate text-left tabular-nums ${mono ? 'font-mono' : ''}`}>{item.label}</span>
                    {item.value === value ? <Check aria-hidden size={13} className="shrink-0" /> : null}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from './icons'

/**
 * 自定义单选下拉：Radix 触发器 + 候选项，不使用原生 select，因此不会呼出操作系统的下拉控件。
 * 值集合由调用方决定，在这里收窄回联合类型。
 *
 * 工具栏里的筛选下拉给 `label`（字段名前缀）与 `active`（筛选生效中）：只有当前值时，
 * 一排下拉读起来就是几个重复的词，看不出各自在筛什么。
 * 表单用 `fullWidth`，顶栏收起后的页签用 `triggerClassName` 自己控制显隐，菜单仍走这里。
 * 浮层不锁页面滚动：默认的模态锁会按滚动条宽度给 body 加 margin，窄屏上会把整页挤窄。
 */
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
    'inline-flex w-full items-center justify-between gap-1.5 rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-60'
  const filterTrigger = `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
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
          className={`z-[70] max-h-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-sm shadow-lg ${
            fullWidth ? 'min-w-[var(--radix-dropdown-menu-trigger-width)]' : 'min-w-32 text-xs'
          }`}
        >
          {items.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">{emptyLabel ?? '没有可选项'}</p>
          ) : (
            <DropdownMenu.RadioGroup value={value ?? ''} onValueChange={(next) => onSelect(next as T)}>
              {items.map((item) => (
                <DropdownMenu.RadioItem
                  key={item.value}
                  value={item.value}
                  className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                >
                  {item.value === value ? (
                    <Check aria-hidden size={13} />
                  ) : (
                    <span aria-hidden className="w-[13px]" />
                  )}
                  <span className={`min-w-0 truncate tabular-nums ${mono ? 'font-mono' : ''}`}>{item.label}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

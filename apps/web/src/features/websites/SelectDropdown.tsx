import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from '../../components/icons'

/**
 * 自定义单选下拉：Radix 触发器 + 候选项，不使用原生 select。
 * 值集合由调用方决定，在这里收窄回联合类型。
 */
export function SelectDropdown<T extends string>({
  ariaLabel,
  items,
  value,
  onSelect,
  fallbackLabel,
  fullWidth = false,
}: {
  ariaLabel: string
  items: readonly { value: T; label: string }[]
  /** undefined 表示尚未选择，触发器显示 fallbackLabel。 */
  value: T | undefined
  onSelect: (value: T) => void
  /** 值不在候选项里时触发器显示的占位文案。 */
  fallbackLabel?: string
  /** 表单场景拉满可用宽度；工具栏保持内容宽度。 */
  fullWidth?: boolean
}) {
  const label = (value !== undefined && items.find((item) => item.value === value)?.label) || fallbackLabel || value || ''
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${ariaLabel}：${label}`}
          className={
            fullWidth
              ? 'inline-flex w-full items-center justify-between gap-1.5 rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors hover:border-fg-subtle'
              : 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg'
          }
        >
          <span className="min-w-0 truncate tabular-nums">{label}</span>
          <ChevronDown aria-hidden size={13} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={`z-[60] rounded-lg border border-line bg-surface p-1 text-sm shadow-lg ${
            fullWidth ? 'min-w-[var(--radix-dropdown-menu-trigger-width)]' : 'min-w-32 text-xs'
          }`}
        >
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
                <span className="tabular-nums">{item.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

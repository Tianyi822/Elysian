import { PillNavigation } from './easyui/PillNavigation'

/** 单选分段与全局页签共用 Pill Navigation，保留调用方的受控值和禁用状态。 */
export function ChipGroup<T extends string>({
  ariaLabel,
  items,
  value,
  onSelect,
  className,
  itemClassName,
  disabled = false,
}: {
  /** 分组的无障碍名，读屏用它区分各组单选（如时间范围、规则类型、更新策略）。 */
  ariaLabel: string
  items: readonly { value: T; label: string }[]
  value: T
  onSelect: (value: T) => void
  /** 追加到胶囊组容器上的类名：宽度、外边距之类语境差异。 */
  className?: string
  /** 追加到每个成员上的类名：字号一类语境差异。 */
  itemClassName?: string
  /** 整组禁用（如更新进行中）。 */
  disabled?: boolean
}) {
  return <PillNavigation ariaLabel={ariaLabel}
    items={items.map(item => ({ id: item.value, label: item.label }))}
    value={value} disabled={disabled} className={className} itemClassName={itemClassName}
    onChange={id => { const item = items.find(candidate => candidate.value === id); if (item) onSelect(item.value) }} />
}

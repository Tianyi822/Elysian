import { CTL_CHIP, CTL_GROUP } from './formControl'
import { useSlidingThumb } from './slidingThumb'

/**
 * 单选胶囊组：选中态是一块跟着选中项走的底色（滑块），组内成员共用胶囊边框。
 * 与顶栏页签条（app/layout/HeaderTabs）同源——同一套滑块机制，外壳与成员样式各自不同：
 * 这里外壳是 CTL_GROUP、成员是芯片 CTL_CHIP，底色形状走控制层的 `.ctl-chip-thumb`。
 * 成员自己不再上选中底色（见 styles/index.css 的 ctl-group 段），选中只由滑块与文字表达。
 *
 * 会换行的芯片云（如容器页的状态筛选）不用这个组件：滑块要求成员在同一行上排开。
 */
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
  const activeIndex = items.findIndex((item) => item.value === value)
  const { groupRef, buttonRef, thumb, sliding, startSliding } = useSlidingThumb(activeIndex)

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={ariaLabel}
      className={[CTL_GROUP, className].filter(Boolean).join(' ')}
    >
      {/* 选中滑块：排在成员之前，成员各自 relative 抬到上层，文字因此压在滑块上面。 */}
      <span
        aria-hidden
        className={`ctl-chip-thumb motion-reduce:transition-none ${
          sliding ? 'transition-[left,top,width,height] duration-200' : ''
        }`}
        style={{ left: thumb.left, top: thumb.top, width: thumb.width, height: thumb.height }}
      />
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={buttonRef(index)}
          type="button"
          aria-pressed={value === item.value}
          disabled={disabled}
          onClick={() => {
            startSliding()
            onSelect(item.value)
          }}
          className={[CTL_CHIP, 'relative', itemClassName].filter(Boolean).join(' ')}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

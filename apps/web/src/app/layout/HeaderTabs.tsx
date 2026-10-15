import { useSlidingThumb } from '../../components/slidingThumb'

/** 页签项：值进 store 与回调，中文文案只在各页的页签表里维护。 */
export type HeaderTabItem<T extends string> = { value: T; label: string }

/**
 * 页面内容区的紧凑页签：一块选中底色（滑块）跟着选中项走，文字颜色随选中态变化。
 * 组件不自己记账选中值，值由调用方经 store 提供。
 *
 * 滑块的测量与过渡时机在 components/slidingThumb.ts，这里只负责页签条的外壳与成员样式；
 * 窄屏下调小的页签高度与圆角不会让它错位，因为滑块量的是按钮的盒子。
 */
export function HeaderTabs<T extends string>({
  items,
  value,
  onSelect,
  groupLabel,
}: {
  items: readonly HeaderTabItem<T>[]
  value: T
  onSelect: (value: T) => void
  /** 分组的无障碍名，读屏用它区分各区的页签条（如安全页签、视图切换、数据库类型）。 */
  groupLabel: string
}) {
  const activeIndex = items.findIndex((item) => item.value === value)
  const { groupRef, buttonRef, thumb, sliding, startSliding } = useSlidingThumb(activeIndex)

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={groupLabel}
      className="relative flex h-11 max-w-full items-stretch gap-1 rounded-lg border border-line bg-surface/80 p-1"
    >
      {/* 选中滑块：排在按钮之前，按钮各自 relative 抬到上层，文字因此压在滑块上面。 */}
      <span
        aria-hidden
        className={`header-tabs-thumb absolute rounded-md bg-nav-selected motion-reduce:transition-none ${
          sliding ? 'transition-[left,top,width,height] duration-200' : ''
        }`}
        style={{ left: thumb.left, top: thumb.top, width: thumb.width, height: thumb.height }}
      />
      {items.map(({ value: itemValue, label }, index) => (
        <button
          key={itemValue}
          ref={buttonRef(index)}
          type="button"
          aria-pressed={value === itemValue}
          onClick={() => {
            startSliding()
            onSelect(itemValue)
          }}
          className={`relative whitespace-nowrap rounded-md px-3 text-sm font-semibold transition-colors ${
            value === itemValue ? 'text-accent-fg' : 'text-fg-muted hover:bg-nav-hover hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

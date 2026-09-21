import { useLayoutEffect, useRef, useState } from 'react'

/** 页签项：值进 store 与回调，中文文案只在各页的页签表里维护。 */
export type HeaderTabItem<T extends string> = { value: T; label: string }

/**
 * 顶栏标题位的大字页签条：无外框与分割线，字号字重与顶栏标题一致，
 * 选中与未选中只靠颜色区分；选中效果是一条贴着页签底边的亮色指示条，
 * 位置由选中按钮量出：首次渲染直接落在选中页签下方（刷新恢复选中态不会滑一次），
 * 用户点过页签之后切换才靠 CSS 过渡滑过去。
 *
 * 高度撑满顶栏一行（h-14 抵掉行的上下内边距），指示条因此贴着页签底边、
 * 压在顶栏的下边框上。使用本组件的页面通常同时经路由 handle 声明藏掉可视标题。
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
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })
  /**
   * 滑动开关：用户点过页签之后才启用过渡。
   * 刷新恢复选中页签时指示条直接落在目标位置——不挂过渡，浏览器就不会把首次定位
   * 当成一次动画从左侧滑过来。不用「首帧之后」判定，是因为那依赖布局与绘制的时序：
   * 首次定位若和过渡类的挂上落在同一次提交，浏览器仍会滑一次。
   */
  const [sliding, setSliding] = useState(false)

  // 指示条贴着选中按钮：换页签或任何一项尺寸变化（字体加载、窗口缩放）时重量。
  useLayoutEffect(() => {
    const list = listRef.current
    const button = buttonRefs.current[activeIndex]
    if (!list || !button) return

    const measure = () => {
      setIndicator({ left: button.offsetLeft, width: button.offsetWidth })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const element of buttonRefs.current) if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [activeIndex])

  return (
    <div
      ref={listRef}
      role="group"
      aria-label={groupLabel}
      className="relative -my-3 flex h-14 items-stretch"
    >
      {items.map(({ value: itemValue, label }, index) => (
        <button
          key={itemValue}
          ref={(element) => {
            buttonRefs.current[index] = element
          }}
          type="button"
          aria-pressed={value === itemValue}
          onClick={() => {
            setSliding(true)
            onSelect(itemValue)
          }}
          className={`whitespace-nowrap px-3 text-base font-semibold transition-colors ${
            value === itemValue ? 'text-fg' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
      {/* 选中指示条：不占布局，left/width 跟着选中按钮走，用户切换时滑过去。 */}
      <span
        aria-hidden
        className={`absolute bottom-0 h-0.5 rounded-full bg-accent motion-reduce:transition-none ${
          sliding ? 'transition-[left,width] duration-200' : ''
        }`}
        style={{ left: indicator.left, width: indicator.width }}
      />
    </div>
  )
}

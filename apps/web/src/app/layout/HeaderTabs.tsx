import { useLayoutEffect, useRef, useState } from 'react'

/** 页签项：值进 store 与回调，中文文案只在各页的页签表里维护。 */
export type HeaderTabItem<T extends string> = { value: T; label: string }

/**
 * 页面内容区的紧凑页签：一块选中底色（滑块）跟着选中项走，文字颜色随选中态变化。
 * 组件不自己记账选中值，值由调用方经 store 提供。
 *
 * 滑块不占布局：位置与尺寸都从选中按钮量出（offsetLeft/Top/Width/Height 相对的就是这个容器），
 * 因此顶栏在窄屏下调小的页签高度与圆角不会让它错位；字体加载、窗口缩放等尺寸变化由 ResizeObserver 重量。
 * 过渡只在用户点过页签之后启用：刷新恢复选中页签时滑块直接落位，浏览器就不会把首次定位
 * 当成一次动画从上一处滑过来。不用「首帧之后」判定，是因为那依赖布局与绘制的时序：
 * 首次定位若和过渡类的挂上落在同一次提交，浏览器仍会滑一次。
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
  const [thumb, setThumb] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [sliding, setSliding] = useState(false)

  // 滑块贴着选中按钮：换页签或任何一项尺寸变化（字体加载、窗口缩放、顶栏宽度档位切换）时重量。
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return

    const measure = () => {
      const button = buttonRefs.current[activeIndex]
      // 选中值不在项里时把滑块收成 0：留着上一处的位置会在别的页签下面凭空浮一块底色。
      setThumb(
        button
          ? {
              left: button.offsetLeft,
              top: button.offsetTop,
              width: button.offsetWidth,
              height: button.offsetHeight,
            }
          : { left: 0, top: 0, width: 0, height: 0 },
      )
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
          ref={(element) => {
            buttonRefs.current[index] = element
          }}
          type="button"
          aria-pressed={value === itemValue}
          onClick={() => {
            setSliding(true)
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

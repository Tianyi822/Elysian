import { createContext, useContext, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * 顶栏「标题旁附属控件」（数据库类型切换、容器/镜像切换）的宽度预算。
 *
 * 预算由外壳量出、经 context 交给控件：行的内容宽度减去标题固有宽度、右侧功能簇与两处行间距，
 * 剩下的才是附属控件能占的位置。控件拿自己的摊开宽度与预算比较，摆得下就摊开、摆不下才收起。
 * 量而不设断点，是因为同一视口宽度下可用宽度并不固定——侧边栏收展、标题长短、
 * 内存数值的位数都会改变它，而断点只看视口。
 *
 * 未量出时（测试环境里一切尺寸都是 0）取无限，按摊开呈现。
 */
export const HeaderAccessoryWidthContext = createContext(Number.POSITIVE_INFINITY)

/** 附属控件读自己的宽度预算。 */
export function useHeaderAccessoryWidth(): number {
  return useContext(HeaderAccessoryWidthContext)
}

/**
 * 量出元素自身的固有宽度。元素须自带 `w-max`：否则量到的是它被挤压后的盒宽，
 * 挤得越紧数越小，折叠判断会跟着失真。
 *
 * enabled 为 false 时不启动测量（宽度保持 0）：目标元素挂在带加载态提前返回的
 * 分支下时，首帧 ref 还是 null，等分支就绪再以 enabled 翻转触发测量。
 */
export function useIntrinsicWidth(ref: RefObject<HTMLElement | null>, enabled = true): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return

    return observeSize([element], () => setWidth(element.getBoundingClientRect().width))
  }, [ref, enabled])

  return width
}

type HeaderRowRefs = {
  /** 顶栏那一行。 */
  row: RefObject<HTMLElement | null>
  /** 行内标题：量它截断容器的滚动宽度，即标题不被挤压时所需的宽度。页签式标题的页面不渲染标题，量 0。 */
  title: RefObject<HTMLElement | null>
  /** 右侧功能簇：系统负载与用户占位。 */
  actions: RefObject<HTMLElement | null>
  /** 标题文本。文本变长变短不改标题的盒宽，ResizeObserver 因此不触发，用它显式重算。 */
  titleText: string
}

/** 外壳调用：量出附属控件的宽度预算。 */
export function useHeaderAccessoryWidthMeasurement({
  row,
  title,
  actions,
  titleText,
}: HeaderRowRefs): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)

  useLayoutEffect(() => {
    const rowElement = row.current
    const titleElement = title.current
    const actionsElement = actions.current
    if (!rowElement || !actionsElement) return

    const measure = () => {
      const style = getComputedStyle(rowElement)
      const content =
        rowElement.clientWidth - toPixels(style.paddingLeft) - toPixels(style.paddingRight)
      setWidth(
        content -
          (titleElement?.scrollWidth ?? 0) -
          actionsElement.getBoundingClientRect().width -
          toPixels(style.columnGap) * 2,
      )
    }

    const observed = [rowElement, actionsElement]
    if (titleElement) observed.push(titleElement)
    return observeSize(observed, measure)
  }, [row, title, actions, titleText])

  return width
}

/** 先按当前布局量一次，再在元素尺寸变化（窗口缩放、侧边栏收展、内容增减）时重量。 */
function observeSize(elements: HTMLElement[], measure: () => void): () => void {
  measure()
  if (typeof ResizeObserver !== 'function') return () => {}

  const observer = new ResizeObserver(measure)
  for (const element of elements) observer.observe(element)
  return () => observer.disconnect()
}

function toPixels(value: string): number {
  return Number.parseFloat(value) || 0
}

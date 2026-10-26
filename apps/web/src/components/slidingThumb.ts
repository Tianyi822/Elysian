import { useLayoutEffect, useRef, useState } from 'react'
import { observeElementSize } from '../utils/observeElementSize'

/** 滑块的内联几何：四个值都取自选中项按钮的盒子。 */
export type SlidingThumbBox = { left: number; top: number; width: number; height: number }

/**
 * 单选组里那块跟着选中项走的底色，机制由顶栏页签条（app/layout/HeaderTabs）与芯片单选组
 * （components/ChipGroup）共用：两处外壳与成员样式不同，滑块的行为是同一套。
 *
 * 位置与尺寸都从选中项量出（offsetLeft/Top/Width/Height 相对的就是这个组容器），
 * 因此各组在窄屏下调小的成员高度与圆角不会让滑块错位；字体加载、窗口缩放等尺寸变化由 ResizeObserver 重量。
 * 过渡只在用户点过之后启用：刷新恢复选中项时滑块直接落位，浏览器就不会把首次定位
 * 当成一次动画从上一处滑过来。不用「首帧之后」判定，是因为那依赖布局与绘制的时序：
 * 首次定位若和过渡类的挂上落在同一次提交，浏览器仍会滑一次。
 *
 * 用法：groupRef 挂到组容器，buttonRef(index) 挂到每个选项，thumb 与 sliding 交给滑块元素，
 * 选项的 onClick 里先调 startSliding() 再改选中值。
 */
export function useSlidingThumb(activeIndex: number) {
  const groupRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLElement | null)[]>([])
  const [thumb, setThumb] = useState<SlidingThumbBox>({ left: 0, top: 0, width: 0, height: 0 })
  const [sliding, setSliding] = useState(false)

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return

    const measure = () => {
      const button = buttonRefs.current[activeIndex]
      // 选中值不在项里时把滑块收成 0：留着上一处的位置会在别的选项下面凭空浮一块底色。
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
    return observeElementSize([group, ...buttonRefs.current.filter((element): element is HTMLElement => element !== null)], measure)
  }, [activeIndex])

  return {
    groupRef,
    buttonRef: (index: number) => (element: HTMLElement | null) => {
      buttonRefs.current[index] = element
    },
    thumb,
    sliding,
    startSliding: () => setSliding(true),
  }
}

import { useEffect, useState } from 'react'

/**
 * 窄屏线：与样式里的窄屏断点同一条（`@media (max-width: 767.98px)`，即 md 之下）。
 * 顶栏页签与仪表盘时间范围在窄屏一律收进下拉，不再看顶栏还剩多少宽度——这是产品约定，
 * 与 app/layout/headerAccessoryWidth.ts 的宽度预算各管一半：预算管「宽屏下摆得下吗」，
 * 这里管「屏幕是不是已经窄到该换形态」。
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 767.98px)'

/**
 * 视口是否窄于 768px，随窗口缩放更新。
 *
 * 读不到媒体查询时按宽屏处理，与宽度预算量不出时按「放得下」处理同一口径：两者都是
 * 「量不着就不改形态」，形态因此只在真的量到窄屏时才收。jsdom 恰好走这条路径
 * （`matchMedia` 取到 undefined），测试要断言窄屏形态得显式打桩。
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.(NARROW_VIEWPORT_QUERY)?.matches ?? false,
  )

  useEffect(() => {
    const media = window.matchMedia?.(NARROW_VIEWPORT_QUERY)
    if (!media) return
    const update = () => setNarrow(media.matches)
    update()
    // 测试里的打桩可能只给 matches，没有监听接口。
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  return narrow
}

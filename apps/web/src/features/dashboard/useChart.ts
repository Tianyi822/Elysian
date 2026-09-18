import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { readChartPalette } from './chartOptions'
import type { ChartPalette } from './chartOptions'

/**
 * 图表实例管理只有一个关注点：挂载（SVG 渲染器、随容器缩放）、随 rebuildKey 更新、卸载释放。
 *
 * option 在被动 effect 里经 buildOption 现做现用，配色在那一刻读取语义令牌：
 * 主题属性由 ThemeProvider 的 insertion effect 翻转，先于全部被动 effect，
 * 因此读取到的一定是新主题——在渲染期读取会滞后一次切换，这是评审发现的真实浏览器缺陷。
 */
export function useChart(
  buildOption: () => EChartsCoreOption,
  rebuildKey: string,
  resetZoomSignal?: number,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | undefined>(undefined)
  const buildRef = useRef(buildOption)
  buildRef.current = buildOption

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'svg' })
    chartRef.current = chart

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => chart.resize()) : undefined
    if (observer) observer.observe(containerRef.current)

    // 保留默认 merge，让 ECharts 根据稳定的 series id 保留模型并对新旧数据做 diff。
    chart.setOption(buildRef.current(), { notMerge: false, lazyUpdate: false })

    return () => {
      observer?.disconnect()
      chart.dispose()
      chartRef.current = undefined
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(buildRef.current(), { notMerge: false, lazyUpdate: false })
  }, [rebuildKey])

  useEffect(() => {
    if (resetZoomSignal === undefined || resetZoomSignal === 0) return
    chartRef.current?.dispatchAction({
      type: 'dataZoom',
      start: 0,
      end: 100,
    })
  }, [resetZoomSignal])

  return containerRef
}

/** 图表配色随主题收敛：effect 在属性翻转之后读取令牌，随后一次渲染刷新图例色点。 */
export function useChartPalette(theme: 'dark' | 'light'): ChartPalette {
  const [palette, setPalette] = useState(() => readChartPalette(theme))
  useEffect(() => {
    setPalette(readChartPalette(theme))
  }, [theme])
  return palette
}

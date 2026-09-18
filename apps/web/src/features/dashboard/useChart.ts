import { useCallback, useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { readChartPalette } from './chartOptions'
import type { ChartPalette } from './chartOptions'

function readZoomed(chart: echarts.ECharts): boolean {
  const option = chart.getOption() as {
    dataZoom?: ReadonlyArray<{ start?: number; end?: number }>
  }
  const zoom = option.dataZoom?.[0]
  if (!zoom) return false
  const start = zoom.start ?? 0
  const end = zoom.end ?? 100
  return start > 0.5 || end < 99.5
}

/**
 * 图表实例：首屏完整 option；后续只补丁 series/yAxis，避免 dataZoom 被冲掉、数值从 0 重播。
 * 可选 Brush（lineX）框选后转成 dataZoom；缩放后由调用方展示复位。
 */
export function useChart(
  buildOption: () => EChartsCoreOption,
  rebuildKey: string,
  options: { enableBrush?: boolean } = {},
) {
  const { enableBrush = false } = options
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | undefined>(undefined)
  const buildRef = useRef(buildOption)
  buildRef.current = buildOption
  const readyRef = useRef(false)
  const [isZoomed, setIsZoomed] = useState(false)

  const resetZoom = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    if (enableBrush) {
      chart.dispatchAction({ type: 'brush', areas: [] })
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      })
    }
    setIsZoomed(false)
  }, [enableBrush])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'svg' })
    chartRef.current = chart

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => chart.resize()) : undefined
    if (observer) observer.observe(containerRef.current)

    chart.setOption(buildRef.current(), { notMerge: false, lazyUpdate: false })
    if (enableBrush) {
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      })
    }
    readyRef.current = true
    setIsZoomed(false)

    const syncZoomed = () => setIsZoomed(readZoomed(chart))

    const onBrushEnd = (...args: unknown[]) => {
      if (!enableBrush) return
      const params = args[0] as { areas?: ReadonlyArray<{ coordRange?: [number, number] }> }
      const range = params.areas?.[0]?.coordRange
      if (!range || range.length < 2) return
      const [startValue, endValue] = range[0] <= range[1] ? range : [range[1], range[0]]
      if (startValue === endValue) return
      chart.dispatchAction({
        type: 'dataZoom',
        startValue,
        endValue,
      })
      chart.dispatchAction({ type: 'brush', areas: [] })
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      })
      syncZoomed()
    }

    const onDataZoom = () => syncZoomed()

    if (enableBrush) chart.on('brushEnd', onBrushEnd)
    chart.on('datazoom', onDataZoom)

    return () => {
      if (enableBrush) chart.off('brushEnd', onBrushEnd)
      chart.off('datazoom', onDataZoom)
      observer?.disconnect()
      chart.dispose()
      chartRef.current = undefined
      readyRef.current = false
    }
  }, [enableBrush])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !readyRef.current) return
    const next = buildRef.current()
    chart.setOption(
      {
        series: next.series,
        yAxis: next.yAxis,
        tooltip: next.tooltip,
      },
      { notMerge: false, lazyUpdate: false },
    )
  }, [rebuildKey])

  return { containerRef, isZoomed, resetZoom }
}

/** 图表配色随主题收敛：effect 在属性翻转之后读取令牌，随后一次渲染刷新图例色点。 */
export function useChartPalette(theme: 'dark' | 'light'): ChartPalette {
  const [palette, setPalette] = useState(() => readChartPalette(theme))
  useEffect(() => {
    setPalette(readChartPalette(theme))
  }, [theme])
  return palette
}

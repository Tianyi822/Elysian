import { useEffect, useMemo, useRef } from 'react'
import { PieChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { useTheme } from '../../app/theme/ThemeProvider'
import { buildDistributionOption, buildTrendOption, readChartPalette } from './chartOptions'
import type { SeverityDistribution } from '../../adapters/mock/aggregations'
import { sliceTrend } from '../../adapters/mock/timeseries'
import type { DailyIncidents, TimeRange } from '../../adapters/mock/timeseries'

echarts.use([PieChart, LineChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer])

/** 图表实例管理只有一个关注点：挂载、随 option 更新、卸载时释放。 */
function useChart(option: EChartsCoreOption) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | undefined>(undefined)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'svg' })
    chartRef.current = chart
    return () => {
      chart.dispose()
      chartRef.current = undefined
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return containerRef
}

function ChartPanel({ title, option }: { title: string; option: EChartsCoreOption }) {
  const ref = useChart(option)
  return (
    <article aria-label={title} className="rounded-lg border border-line bg-surface p-3">
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      <div ref={ref} className="h-56 w-full" />
    </article>
  )
}

export function ChartsSection({
  distribution,
  trend,
  range,
}: {
  distribution: SeverityDistribution
  trend: readonly DailyIncidents[]
  range: TimeRange
}) {
  const { theme } = useTheme()

  // 配色在渲染期按主题读取：attr 翻转在 ThemeProvider 的 insertion effect 里，
  // 先于本组件的被动 effect，因此 setOption 时读到的已是新主题的令牌。
  const palette = useMemo(() => readChartPalette(theme), [theme])
  const days = useMemo(() => sliceTrend(trend, range), [trend, range])
  const distributionOption = useMemo(
    () => buildDistributionOption(distribution, palette),
    [distribution, palette],
  )
  const trendOption = useMemo(() => buildTrendOption(days, palette), [days, palette])

  return (
    <section aria-label="图表" className="mb-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
      <ChartPanel title="严重等级分布" option={distributionOption} />
      <ChartPanel title="事故趋势" option={trendOption} />
    </section>
  )
}

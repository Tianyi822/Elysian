import { useMemo } from 'react'
import { PieChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { SEVERITY_LABELS } from '@elysian/contracts'
import type { Severity } from '@elysian/contracts'
import { useTheme } from '../../app/theme/ThemeProvider'
import { buildDistributionOption, buildTrendOption, readChartPalette } from './chartOptions'
import type { ChartPalette } from './chartOptions'
import { useChart, useChartPalette } from './useChart'
import type { SeverityDistribution } from '../../adapters/mock/aggregations'
import { sliceTrend } from '../../adapters/mock/timeseries'
import type { DailyIncidents, TimeRange } from '../../adapters/mock/timeseries'

echarts.use([PieChart, LineChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer])

function severityTable(distribution: SeverityDistribution, palette: ChartPalette) {
  return (Object.keys(distribution) as Severity[]).map((severity) => (
    <div key={severity} className="flex items-baseline justify-between gap-3">
      <dt className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span
          aria-hidden
          className="inline-block size-2 rounded-full"
          style={{ backgroundColor: palette.sev[severity] }}
        />
        {SEVERITY_LABELS[severity]}
      </dt>
      <dd className="text-sm tabular-nums">{distribution[severity]}</dd>
    </div>
  ))
}

function DistributionPanel({
  distribution,
  theme,
}: {
  distribution: SeverityDistribution
  theme: 'dark' | 'light'
}) {
  const palette = useChartPalette(theme)
  const ref = useChart(
    () => buildDistributionOption(distribution, readChartPalette(theme)),
    `${theme}:${JSON.stringify(distribution)}`,
  )

  return (
    <article aria-label="严重等级分布" className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 text-base font-semibold">严重等级分布</h2>
      <div className="grid grid-cols-[1fr_auto] items-center gap-5">
        <div ref={ref} className="h-64 w-full" />
        <dl className="min-w-32 space-y-2 border-l border-line pl-4">
          {severityTable(distribution, palette)}
        </dl>
      </div>
    </article>
  )
}

function TrendPanel({
  trend,
  range,
  theme,
}: {
  trend: readonly DailyIncidents[]
  range: TimeRange
  theme: 'dark' | 'light'
}) {
  const days = useMemo(() => sliceTrend(trend, range), [trend, range])
  const ref = useChart(
    () => buildTrendOption(days, readChartPalette(theme)),
    `${theme}:${range}`,
  )

  return (
    <article aria-label="事故趋势" className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 text-base font-semibold">事故趋势</h2>
      <div ref={ref} className="h-64 w-full" />
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

  return (
    <section aria-label="图表" className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <DistributionPanel distribution={distribution} theme={theme} />
      <TrendPanel trend={trend} range={range} theme={theme} />
    </section>
  )
}

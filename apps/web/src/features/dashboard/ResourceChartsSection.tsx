import { useMemo } from 'react'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { useTheme } from '../../app/theme/ThemeProvider'
import {
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  sliceResourceMetrics,
  type TimeRange,
} from '../../adapters/mock/resourceMetrics'
import type {
  DailyResourceMetrics,
  ResourceMetricKey,
} from '../../adapters/mock/resourceMetrics'
import { buildResourceTrendOption, readChartPalette } from './chartOptions'
import { useChart } from './useChart'

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer])

/** 百分比紧跟数值，吞吐量类单位用空格隔开。 */
function formatValue(value: number, unit: string): string {
  return unit === '%' ? `${value}%` : `${value} ${unit}`
}

function ResourcePanel({
  metricKey,
  days,
  theme,
}: {
  metricKey: ResourceMetricKey
  days: readonly DailyResourceMetrics[]
  theme: 'dark' | 'light'
}) {
  const latest = days[days.length - 1]
  const unit = RESOURCE_METRIC_UNITS[metricKey]
  const hot = (metricKey === 'cpu' || metricKey === 'memory') && (latest?.[metricKey] ?? 0) >= 80
  const ref = useChart(
    () => buildResourceTrendOption(days, metricKey, readChartPalette(theme)),
    `${theme}:${metricKey}:${days.length}:${latest?.[metricKey] ?? ''}`,
  )

  return (
    <article
      aria-label={RESOURCE_METRIC_LABELS[metricKey]}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-sm font-semibold">{RESOURCE_METRIC_LABELS[metricKey]}</h2>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums leading-none ${hot ? 'text-warning' : 'text-fg'}`}
      >
        {latest ? formatValue(latest[metricKey], unit) : '—'}
      </p>
      <div ref={ref} className="mt-3 h-20 w-full" />
    </article>
  )
}

export function ResourceChartsSection({
  resources,
  range,
}: {
  resources: readonly DailyResourceMetrics[]
  range: TimeRange
}) {
  const { theme } = useTheme()
  const days = useMemo(() => sliceResourceMetrics(resources, range), [resources, range])

  return (
    <section
      aria-label="资源监控"
      className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {(Object.keys(RESOURCE_METRIC_LABELS) as ResourceMetricKey[]).map((metricKey) => (
        <ResourcePanel key={metricKey} metricKey={metricKey} days={days} theme={theme} />
      ))}
    </section>
  )
}

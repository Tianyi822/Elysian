import { BarChart, LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { useTheme } from '../../app/theme/ThemeProvider'
import {
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  type ResourceMetricKey,
  type ResourceSamplePoint,
} from '../../adapters/mock/resourceMetrics'
import type { DiskUsage, SystemLoad } from '../../adapters/mock/resourceMetrics'
import {
  buildDiskBarsOption,
  buildLoadBarsOption,
  buildResourceTrendOption,
  readChartPalette,
} from './chartOptions'
import { useChart } from './useChart'

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, DataZoomComponent, SVGRenderer])

/** 百分比紧跟数值，吞吐量类单位用空格隔开。 */
function formatValue(value: number, unit: string): string {
  return unit === '%' ? `${value}%` : `${value} ${unit}`
}

function ResourcePanel({
  metricKey,
  points,
  theme,
  resetZoomSignal,
}: {
  metricKey: ResourceMetricKey
  points: readonly ResourceSamplePoint[]
  theme: 'dark' | 'light'
  resetZoomSignal: number
}) {
  const latest = points[points.length - 1]
  const unit = RESOURCE_METRIC_UNITS[metricKey]
  const hot = (metricKey === 'cpu' || metricKey === 'memory') && (latest?.[metricKey] ?? 0) >= 80
  const ref = useChart(
    () => buildResourceTrendOption(points, metricKey, readChartPalette(theme)),
    `${theme}:${metricKey}:${points.length}:${latest?.ts ?? ''}:${latest?.[metricKey] ?? ''}`,
    resetZoomSignal,
  )

  return (
    <article
      aria-label={RESOURCE_METRIC_LABELS[metricKey]}
      className="rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold">{RESOURCE_METRIC_LABELS[metricKey]}</h2>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums leading-none ${hot ? 'text-warning' : 'text-fg'}`}
      >
        {latest ? formatValue(latest[metricKey], unit) : '—'}
      </p>
      <div ref={ref} className="mt-4 h-52 w-full sm:h-56" />
    </article>
  )
}

function BarsPanel({
  title,
  option,
  rebuildKey,
}: {
  title: string
  option: EChartsCoreOption
  rebuildKey: string
}) {
  const ref = useChart(() => option, rebuildKey)

  return (
    <article
      aria-label={title}
      className="rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <div ref={ref} className="mt-4 h-40 w-full sm:h-44" />
    </article>
  )
}

export function ResourceChartsSection({
  resources,
  system,
  resetZoomSignal,
}: {
  resources: readonly ResourceSamplePoint[]
  system: { load: SystemLoad; disks: readonly DiskUsage[] }
  resetZoomSignal: number
}) {
  const { theme } = useTheme()

  return (
    <section aria-label="服务器状态" className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-fg-muted">服务器状态</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(Object.keys(RESOURCE_METRIC_LABELS) as ResourceMetricKey[]).map((metricKey) => (
          <ResourcePanel
            key={metricKey}
            metricKey={metricKey}
            points={resources}
            theme={theme}
            resetZoomSignal={resetZoomSignal}
          />
        ))}

        <BarsPanel
          title="运行负载"
          option={buildLoadBarsOption(system.load, readChartPalette(theme))}
          rebuildKey={`load:${theme}:${JSON.stringify(system.load)}`}
        />
        <BarsPanel
          title="磁盘占用"
          option={buildDiskBarsOption(system.disks, readChartPalette(theme))}
          rebuildKey={`disk:${theme}:${JSON.stringify(system.disks)}`}
        />
      </div>
    </section>
  )
}

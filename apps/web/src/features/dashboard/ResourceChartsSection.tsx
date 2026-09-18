import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
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
  buildDiskRingOption,
  buildLoadBarsOption,
  buildResourceTrendOption,
  readChartPalette,
} from './chartOptions'
import { formatResourceMetricValue } from './formatMetricDisplay'
import { useChart } from './useChart'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  BrushComponent,
  SVGRenderer,
])

function ResourcePanel({
  metricKey,
  points,
  theme,
}: {
  metricKey: ResourceMetricKey
  points: readonly ResourceSamplePoint[]
  theme: 'dark' | 'light'
}) {
  const latest = points[points.length - 1]
  const unit = RESOURCE_METRIC_UNITS[metricKey]
  const hot = (metricKey === 'cpu' || metricKey === 'memory') && (latest?.[metricKey] ?? 0) >= 80
  const { containerRef, isZoomed, resetZoom } = useChart(
    () => buildResourceTrendOption(points, metricKey, readChartPalette(theme)),
    `${theme}:${metricKey}:${points.length}:${latest?.ts ?? ''}:${latest?.[metricKey] ?? ''}`,
    { enableBrush: true },
  )

  return (
    <article
      aria-label={RESOURCE_METRIC_LABELS[metricKey]}
      className="relative min-w-0 rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold leading-5">{RESOURCE_METRIC_LABELS[metricKey]}</h2>
      {isZoomed ? (
        <button
          type="button"
          onClick={resetZoom}
          className="absolute right-4 top-4 z-10 rounded border border-line bg-surface-raised px-2 text-xs leading-5 text-fg md:right-5 md:top-5"
        >
          复位
        </button>
      ) : null}
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums leading-none ${hot ? 'text-warning' : 'text-fg'}`}
      >
        {latest ? formatResourceMetricValue(latest[metricKey], unit) : '—'}
      </p>
      <div ref={containerRef} className="mt-4 h-52 w-full min-w-0 cursor-crosshair sm:h-56" />
    </article>
  )
}

function BarsPanel({
  title,
  buildOption,
  rebuildKey,
}: {
  title: string
  buildOption: () => EChartsCoreOption
  rebuildKey: string
}) {
  const { containerRef } = useChart(buildOption, rebuildKey)

  return (
    <article
      aria-label={title}
      className="rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <div ref={containerRef} className="mt-4 h-40 w-full sm:h-44" />
    </article>
  )
}

function BarsPlaceholder({ title }: { title: string }) {
  return (
    <article
      aria-label={title}
      className="rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-4 text-sm text-fg-muted">等待资源采样…</p>
    </article>
  )
}

export function ResourceChartsSection({
  resources,
  system,
}: {
  resources: readonly ResourceSamplePoint[]
  system?: { load: SystemLoad; disks: readonly DiskUsage[] }
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
          />
        ))}

        {system ? (
          <BarsPanel
            title="运行负载"
            buildOption={() => buildLoadBarsOption(system.load, readChartPalette(theme))}
            rebuildKey={`load:${theme}:${JSON.stringify(system.load)}`}
          />
        ) : (
          <BarsPlaceholder title="运行负载" />
        )}
        {system ? (
          <BarsPanel
            title="磁盘占用"
            buildOption={() => buildDiskRingOption(system.disks, readChartPalette(theme))}
            rebuildKey={`disk:${theme}:${JSON.stringify(system.disks)}`}
          />
        ) : (
          <BarsPlaceholder title="磁盘占用" />
        )}
      </div>
    </section>
  )
}

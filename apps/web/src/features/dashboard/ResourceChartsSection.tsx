import { useTheme } from '../../app/theme/ThemeProvider'
import {
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  type ResourceMetricKey,
  type ResourceSamplePoint,
} from '../../adapters/mock/resourceMetrics'
import './chartComponents'
import { BusyVeil } from '../../components/RefreshState'
import { buildResourceTrendOption, readChartPalette } from './chartOptions'
import { formatResourceMetricValue } from './formatMetricDisplay'
import { useChart } from './useChart'

function ResourcePanel({
  metricKey,
  points,
  theme,
  refreshing,
}: {
  metricKey: ResourceMetricKey
  points: readonly ResourceSamplePoint[]
  theme: 'dark' | 'light'
  refreshing: boolean
}) {
  const latest = points[points.length - 1]
  const { containerRef, isZoomed, resetZoom } = useChart(
    () => buildResourceTrendOption(points, metricKey, readChartPalette(theme)),
    `${theme}:${metricKey}:${points.length}:${latest?.ts ?? ''}:${latest?.[metricKey] ?? ''}`,
    { enableBrush: true },
  )

  return (
    <article
      aria-label={`${RESOURCE_METRIC_LABELS[metricKey]}趋势`}
      className="relative min-w-0 panel-surface p-4 md:p-5"
    >
      <BusyVeil busy={refreshing} />
      <h2 className="text-sm font-semibold leading-5">{RESOURCE_METRIC_LABELS[metricKey]}趋势</h2>
      {isZoomed ? (
        <button
          type="button"
          onClick={resetZoom}
          className="absolute right-4 top-4 z-10 rounded border border-control-line bg-surface-raised px-2 text-xs leading-5 text-fg md:right-5 md:top-5"
        >
          复位
        </button>
      ) : null}
      <div ref={containerRef} className="mt-3 h-52 w-full min-w-0 cursor-crosshair sm:h-56" />
    </article>
  )
}

export function ResourceChartsSection({
  resources,
  refreshing,
}: {
  resources: readonly ResourceSamplePoint[]
  refreshing: boolean
}) {
  const { theme } = useTheme()
  const latest = resources[resources.length - 1]
  const metricKeys = Object.keys(RESOURCE_METRIC_LABELS) as ResourceMetricKey[]

  return (
    <section aria-label="服务器状态" className="@container space-y-4">
      <div aria-label="当前资源读数" className="grid grid-cols-1 gap-4 @xs:grid-cols-2 @4xl:grid-cols-4">
        {metricKeys.map((metricKey) => {
          const hot = (metricKey === 'cpu' || metricKey === 'memory') && (latest?.[metricKey] ?? 0) >= 80
          return (
            <article key={metricKey} aria-label={RESOURCE_METRIC_LABELS[metricKey]} className="min-w-0 panel-surface px-4 py-5">
              <BusyVeil busy={refreshing} />
              <h2 className="text-sm font-medium text-fg-muted">{RESOURCE_METRIC_LABELS[metricKey]}</h2>
              <p className={`mt-2 text-2xl font-semibold tabular-nums leading-tight ${hot ? 'text-warning' : 'text-fg'}`}>
                {latest ? formatResourceMetricValue(latest[metricKey], RESOURCE_METRIC_UNITS[metricKey]) : '—'}
              </p>
            </article>
          )
        })}
      </div>
      {/* 以实际内容宽度决定列数：两列需至少 576px，单图保留约 280px。 */}
      <div aria-label="资源趋势" className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        {metricKeys.map((metricKey) => (
          <ResourcePanel
            key={metricKey}
            metricKey={metricKey}
            points={resources}
            theme={theme}
            refreshing={refreshing}
          />
        ))}
      </div>
    </section>
  )
}

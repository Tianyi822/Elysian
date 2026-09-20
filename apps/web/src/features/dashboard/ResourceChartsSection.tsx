import type { EChartsCoreOption } from 'echarts/core'
import { useTheme } from '../../app/theme/ThemeProvider'
import {
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
  type ResourceMetricKey,
  type ResourceSamplePoint,
} from '../../adapters/mock/resourceMetrics'
import type { DiskUsage, SystemLoad } from '../../adapters/mock/resourceMetrics'
import './chartComponents'
import {
  buildDiskRingOption,
  buildLoadBarsOption,
  buildResourceTrendOption,
  readChartPalette,
} from './chartOptions'
import type { ChartSize } from './chartOptions'
import { formatResourceMetricValue } from './formatMetricDisplay'
import { useChart } from './useChart'

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
  buildOption: (size: ChartSize) => EChartsCoreOption
  rebuildKey: string
}) {
  const { containerRef } = useChart(buildOption, rebuildKey)

  return (
    <article
      aria-label={title}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {/* 图吃满卡片剩余高度：与趋势卡同排时被拉高，小图跟着变大而不是缩在顶部。 */}
      <div ref={containerRef} className="mt-4 min-h-40 w-full flex-1" />
    </article>
  )
}

function BarsPlaceholder({ title }: { title: string }) {
  return (
    <article
      aria-label={title}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 md:p-5"
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
    <section aria-label="服务器状态" className="@container mb-6">
      <h2 className="mb-3 text-sm font-semibold text-fg-muted">服务器状态</h2>
      {/* 列数取内容区实测宽度而非视口：侧边栏收展改变可用宽度，卡片随之增减。
          两列要求单卡至少 ~280px，否则趋势图的横轴标签和负载轨道都会挤到不可读；
          宽屏加到三列把单卡宽度压回可读比例，负载条与磁盘环不再被拉成横幅。 */}
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @7xl:grid-cols-3">
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
            buildOption={(size) => buildLoadBarsOption(system.load, readChartPalette(theme), size)}
            rebuildKey={`load:${theme}:${JSON.stringify(system.load)}`}
          />
        ) : (
          <BarsPlaceholder title="运行负载" />
        )}
        {system ? (
          <BarsPanel
            title="磁盘占用"
            buildOption={(size) => buildDiskRingOption(system.disks, readChartPalette(theme), size)}
            rebuildKey={`disk:${theme}:${JSON.stringify(system.disks)}`}
          />
        ) : (
          <BarsPlaceholder title="磁盘占用" />
        )}
      </div>
    </section>
  )
}

import { useId, useMemo } from 'react'
import { StatCard } from '../../components/easyui/StatCard'
import { DEFAULT_TIME_RANGE, timeRangeDurationMs, RESOURCE_METRIC_LABELS, RESOURCE_METRIC_UNITS, type TimeRange, type ResourceMetricKey, type ResourceSamplePoint } from '../../contracts/resourceMetrics'
import { formatResourceMetricValue } from './formatMetricDisplay'

const COLORS: Record<ResourceMetricKey, string> = {
  cpu: 'var(--t-accent)', memory: 'var(--t-chart-secondary)',
  networkIo: 'var(--t-chart-tertiary)', diskIo: 'var(--t-chart-quaternary)',
}

const NETWORK_DIRECTIONS = [
  { field: 'networkRx', label: '下行', color: COLORS.networkIo },
  { field: 'networkTx', label: '上行', color: 'var(--t-chart-secondary)' },
] as const
const DISK_DIRECTIONS = [
  { field: 'diskRead', label: '读取', color: COLORS.diskIo },
  { field: 'diskWrite', label: '写入', color: 'var(--t-accent)' },
] as const
const PERCENT_DOMAIN = [0, 100] as const

/** Fixed time buckets retain sample identities while the live window advances. */
export function sampleResourceTrend(points: readonly ResourceSamplePoint[], windowMs: number) {
  if (points.length <= 64) return points
  const first = points[0]!
  const last = points.at(-1)!
  const bucketMs = Math.max(windowMs, last.ts - first.ts) / 61
  const buckets = new Map<number, ResourceSamplePoint>()
  for (const point of points.slice(1, -1)) buckets.set(Math.floor(point.ts / bucketMs), point)
  return [first, ...buckets.values(), last]
}

/** 前端展示适配：现有资源字段 → EasyUI StatCard，不更改任何数据契约。 */
export function ResourceStatCard({ metricKey, points, range = DEFAULT_TIME_RANGE }: {
  metricKey: ResourceMetricKey
  points: readonly ResourceSamplePoint[]
  range?: TimeRange
}) {
  const labelId = useId()
  const windowMs = timeRangeDurationMs(range)
  const sampled = useMemo(() => sampleResourceTrend(points, windowMs), [points, windowMs])
  const latest = points.at(-1)
  if (!latest) return null
  const directions = metricKey === 'networkIo' ? NETWORK_DIRECTIONS : metricKey === 'diskIo' ? DISK_DIRECTIONS : undefined
  return (
    <article aria-label={RESOURCE_METRIC_LABELS[metricKey]} className="h-full min-w-0">
      <StatCard
        label={RESOURCE_METRIC_LABELS[metricKey]}
        labelId={labelId}
        value={latest[metricKey]}
        trend={sampled.map(point => point[metricKey])}
        trendTimes={sampled.map(point => point.ts)}
        timeWindowMs={windowMs}
        valueDomain={metricKey === 'cpu' || metricKey === 'memory' ? PERCENT_DOMAIN : undefined}
        zeroBaseline
        trendLabels={sampled.map(point => new Date(point.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))}
        format={value => formatResourceMetricValue(value, RESOURCE_METRIC_UNITS[metricKey])}
        period="当前采样 · 移动查看趋势"
        color={COLORS[metricKey]}
        series={directions?.map(direction => ({ label: direction.label, color: direction.color, values: sampled.map(point => point[direction.field]) }))}
        renderDetails={directions ? activeIndex => {
          const selected = activeIndex === null ? latest : sampled[activeIndex] ?? latest
          return (
            <dl className="mt-3 mb-3 grid grid-cols-2 gap-x-3 px-4 text-xs tabular-nums">
              {directions.map(direction => (
                <div key={direction.field} className="min-w-0">
                  <dt className="flex items-center gap-1.5 text-fg-subtle">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: direction.color }} />
                    {direction.label}
                  </dt>
                  <dd aria-label={direction.label} className="mt-1 whitespace-nowrap font-medium text-fg">{formatResourceMetricValue(selected[direction.field], 'MB/s')}</dd>
                </div>
              ))}
            </dl>
          )
        } : undefined}
        animated={false}
        showDelta={false}
        valueClassName={value => (metricKey === 'cpu' || metricKey === 'memory') && value >= 80 ? 'text-warning' : 'text-fg'}
      />
    </article>
  )
}

import { RESOURCE_METRIC_LABELS, type TimeRange, type ResourceMetricKey, type ResourceSamplePoint } from '../../contracts/resourceMetrics'
import { ResourceStatCard } from './ResourceStatCard'

export function ResourceStatsSection({ resources, refreshing, range }: {
  resources: readonly ResourceSamplePoint[]
  refreshing: boolean
  range: TimeRange
}) {
  const metricKeys = Object.keys(RESOURCE_METRIC_LABELS) as ResourceMetricKey[]
  return (
    <section aria-label="服务器状态" aria-busy={refreshing} className="@container">
      <div aria-label="当前资源读数" className="grid grid-cols-1 gap-4 md:@xs:grid-cols-2 md:@4xl:grid-cols-4">
        {metricKeys.map(metricKey => <ResourceStatCard key={metricKey} metricKey={metricKey} points={resources} range={range} />)}
      </div>
    </section>
  )
}

import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useDashboardStore } from '../../stores/dashboardStore'
import { FilterBar } from './FilterBar'
import { ResourceStatsSection } from './ResourceStatsSection'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const resources = useDashboardStore((state) => state.resources)
  const range = useDashboardStore((state) => state.range)
  const refreshing = useDashboardStore((state) => state.refreshing)
  const errorMessage = useDashboardStore((state) => state.errorMessage)
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)
  const setRange = useDashboardStore((state) => state.setRange)

  useFeedbackMessage(resources ? errorMessage : undefined)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void refresh(gateway)}
        refreshing={refreshing}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-6 md:pb-6">
        {resources ? resources.length > 0 ? (
          <ResourceStatsSection resources={resources} refreshing={refreshing} />
        ) : (
          <EmptyState title="暂无资源数据" description="当前时间范围没有可展示的采样。可以切换时间范围或刷新重试。" />
        ) : status === 'error' ? (
          <ErrorState title="仪表盘加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
        ) : <LoadingState label="正在加载仪表盘…" />}
      </div>
    </div>
  )
}

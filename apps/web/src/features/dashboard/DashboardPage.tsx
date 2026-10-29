import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ShellPageFallback } from '../../app/layout/ShellLayoutContext'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useDashboardStore } from '../../stores/dashboardStore'
import { FilterBar } from './FilterBar'
import { ResourceChartsSection } from './ResourceChartsSection'

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

  if (!resources) {
    if (status === 'error') {
      return (
        <ShellPageFallback><ErrorState
          title="仪表盘加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        /></ShellPageFallback>
      )
    }
    return <ShellPageFallback><LoadingState label="正在加载仪表盘…" /></ShellPageFallback>
  }

  if (resources.length === 0) {
    return (
      <ShellPageFallback><EmptyState
        title="暂无资源数据"
        description="没有可展示的资源采样。可以刷新重试。"
        action={<RefreshButton onPress={() => void load(gateway)} />}
      /></ShellPageFallback>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void refresh(gateway)}
        refreshing={refreshing}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-6 md:pb-6">
        <ResourceChartsSection resources={resources} refreshing={refreshing} />
      </div>
    </div>
  )
}

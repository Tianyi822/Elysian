import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { useDashboardStore } from '../../stores/dashboardStore'
import { FilterBar } from './FilterBar'
import { ResourceChartsSection } from './ResourceChartsSection'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const resources = useDashboardStore((state) => state.resources)
  const system = useDashboardStore((state) => state.system)
  const range = useDashboardStore((state) => state.range)
  const refreshing = useDashboardStore((state) => state.refreshing)
  const errorMessage = useDashboardStore((state) => state.errorMessage)
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)
  const setRange = useDashboardStore((state) => state.setRange)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (!resources || !system) {
    if (status === 'error') {
      return (
        <ErrorState
          title="仪表盘加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        />
      )
    }
    return <LoadingState label="正在加载仪表盘…" />
  }

  if (resources.length === 0) {
    return (
      <EmptyState
        title="演示数据集为空"
        description="没有可展示的资源采样。可以刷新重试，或在快捷操作里重置演示数据。"
        action={
          <button
            type="button"
            onClick={() => void load(gateway)}
            className="mt-1 rounded-lg border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
          >
            刷新
          </button>
        }
      />
    )
  }

  return (
    <>
      {errorMessage ? (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          {errorMessage}
        </p>
      ) : null}
      <FilterBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void refresh(gateway)}
        refreshing={refreshing}
      />
      <ResourceChartsSection resources={resources} range={range} system={system} />
    </>
  )
}

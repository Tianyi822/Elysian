import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { useDashboardStore } from '../../stores/dashboardStore'
import { ChartsSection } from './ChartsSection'
import { FilterBar } from './FilterBar'
import { QuickActionsSection, RecentActivitySection } from './QuickActions'
import { ModuleCardsSection, StatCardsSection } from './StatCards'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const stats = useDashboardStore((state) => state.stats)
  const modules = useDashboardStore((state) => state.modules)
  const distribution = useDashboardStore((state) => state.distribution)
  const trend = useDashboardStore((state) => state.trend)
  const auditRecords = useDashboardStore((state) => state.auditRecords)
  const range = useDashboardStore((state) => state.range)
  const refreshing = useDashboardStore((state) => state.refreshing)
  const errorMessage = useDashboardStore((state) => state.errorMessage)
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)
  const setRange = useDashboardStore((state) => state.setRange)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (!stats || !modules || !distribution || !trend || !auditRecords) {
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

  if (stats.totalIncidents === 0 && auditRecords.length === 0) {
    return (
      <EmptyState
        title="演示数据集为空"
        description="没有可展示的事故与活动。可以刷新重试，或在快捷操作里重置演示数据。"
        action={
          <button
            type="button"
            onClick={() => void load(gateway)}
            className="mt-1 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
          >
            刷新
          </button>
        }
      />
    )
  }

  return (
    <>
      {/* 刷新失败但已有内容时，横幅提示而不清空内容。 */}
      {errorMessage ? (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          {errorMessage}
        </p>
      ) : null}
      <StatCardsSection stats={stats} />
      <ModuleCardsSection modules={modules} />
      <FilterBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void refresh(gateway)}
        refreshing={refreshing}
      />
      <ChartsSection distribution={distribution} trend={trend} range={range} />

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <RecentActivitySection records={auditRecords} />
        <QuickActionsSection />
      </div>
    </>
  )
}

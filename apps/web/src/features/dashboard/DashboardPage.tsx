import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useDashboardStore } from '../../stores/dashboardStore'
import { ChartsSection } from './ChartsSection'
import { FilterBar } from './FilterBar'
import { ModuleCardsSection, StatCardsSection } from './StatCards'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const stats = useDashboardStore((state) => state.stats)
  const modules = useDashboardStore((state) => state.modules)
  const distribution = useDashboardStore((state) => state.distribution)
  const trend = useDashboardStore((state) => state.trend)
  const range = useDashboardStore((state) => state.range)
  const refreshing = useDashboardStore((state) => state.refreshing)
  const errorMessage = useDashboardStore((state) => state.errorMessage)
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)
  const setRange = useDashboardStore((state) => state.setRange)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (!stats || !modules || !distribution || !trend) {
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

  return (
    <>
      {status === 'error' && errorMessage ? (
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
    </>
  )
}

import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useDashboardStore } from '../../stores/dashboardStore'
import { ModuleCardsSection, StatCardsSection } from './StatCards'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const stats = useDashboardStore((state) => state.stats)
  const modules = useDashboardStore((state) => state.modules)
  const errorMessage = useDashboardStore((state) => state.errorMessage)
  const load = useDashboardStore((state) => state.load)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (!stats || !modules) {
    return (
      <>
        {status === 'error' ? (
          <ErrorState
            title="仪表盘加载失败"
            description={errorMessage}
            onRetry={() => void load(gateway)}
          />
        ) : (
          <LoadingState label="正在加载仪表盘…" />
        )}
      </>
    )
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
    </>
  )
}

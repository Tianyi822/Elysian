import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { useDashboardStore } from '../../stores/dashboardStore'
import { FilterBar } from './FilterBar'
import { RecentActivitySection } from './RecentActivity'
import { ModuleCardsSection, StatCardsSection } from './StatCards'
import { ResourceChartsSection } from './ResourceChartsSection'
import type { ModuleCard, StatCards } from '../../adapters/mock/aggregations'

export function DashboardPage() {
  const gateway = useGateway()
  const status = useDashboardStore((state) => state.status)
  const stats = useDashboardStore((state) => state.stats)
  const modules = useDashboardStore((state) => state.modules)
  const resources = useDashboardStore((state) => state.resources)
  const system = useDashboardStore((state) => state.system)
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

  if (!stats || !modules || !resources || !system || !auditRecords) {
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
      {/* 刷新失败但已有内容时，横幅提示而不清空内容。 */}
      {errorMessage ? (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          {errorMessage}
        </p>
      ) : null}
      <ResourceChartsSection resources={resources} range={range} system={system} />
      <StatCardsSection stats={stats} />
      <ModuleCardsSection modules={modules} />
      <FilterBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void refresh(gateway)}
        refreshing={refreshing}
      />
      <section aria-label="运营工作区" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,1fr)]">
        <RecentActivitySection records={auditRecords} />
        <OperationsOverview stats={stats} modules={modules} />
      </section>
    </>
  )
}

function OperationsOverview({
  stats,
  modules,
}: {
  stats: StatCards
  modules: readonly ModuleCard[]
}) {
  const activeModules = modules.filter((module) => module.runStatus).length
  const overview = [
    ['实时事件流', '由页头状态标识提供连接状态'],
    ['活跃职责模块', `${activeModules} / ${modules.length} 个模块正在处理`],
    ['待审批动作', `${stats.pendingApprovals} 项动作等待决策`],
    ['受影响服务', `${stats.affectedServices} 个服务处于关注范围`],
  ] as const

  return (
    <section aria-label="运行概览" className="rounded-xl border border-line bg-surface p-4 md:p-5">
      <div className="mb-3 border-b border-line pb-2">
        <h2 className="text-base font-semibold">运行概览</h2>
        <p className="mt-1 text-sm text-fg-muted">当前演示会话的关键工作状态</p>
      </div>
      <dl className="divide-y divide-line">
        {overview.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <dt className="text-sm text-fg-muted">{label}</dt>
            <dd className="text-right text-sm font-medium text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

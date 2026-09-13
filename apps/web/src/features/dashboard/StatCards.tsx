import { RUN_STATUS_LABELS, responsibilityModuleName } from '@elysian/contracts'
import { Bot, Gauge, ScrollText, Server, ShieldCheck, Siren, Timer, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { RiskTag } from '../../components/RiskTag'
import { StatusTag } from '../../components/StatusTag'
import type { ModuleCard, StatCards } from '../../adapters/mock/aggregations'

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint?: ReactNode
  icon: LucideIcon
}) {
  return (
    <article
      aria-label={`${label}指标卡`}
      className="min-h-28 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg-subtle">{label}</span>
        <Icon aria-hidden size={15} className="text-fg-subtle" />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums leading-none">{value}</p>
      {hint ? <p className="mt-2 text-sm text-fg-muted">{hint}</p> : null}
    </article>
  )
}

export function StatCardsSection({ stats }: { stats: StatCards }) {
  const cards: ReadonlyArray<{
    label: string
    value: string
    hint?: ReactNode
    icon: LucideIcon
  }> = [
    { label: '事故总数', value: String(stats.totalIncidents), icon: Siren },
    { label: '待处理事故', value: String(stats.openIncidents), icon: Timer },
    { label: '执行中运行', value: String(stats.runningRuns), icon: Bot },
    { label: '等待审批运行', value: String(stats.waitingRuns), icon: Workflow },
    {
      label: '待审批动作',
      value: String(stats.pendingApprovals),
      icon: ShieldCheck,
      hint: stats.highestPendingRisk ? (
        <span className="flex items-center gap-1.5">
          最高风险
          <RiskTag level={stats.highestPendingRisk} />
        </span>
      ) : undefined,
    },
    { label: '今日审计事件', value: String(stats.todayAuditEvents), icon: ScrollText },
    { label: '启用技能', value: String(stats.enabledSkills), icon: Gauge },
    { label: '受影响服务', value: String(stats.affectedServices), icon: Server },
  ]

  return (
    <section aria-label="关键指标" className="mb-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            hint={card.hint}
            icon={card.icon}
          />
        ))}
      </div>
    </section>
  )
}

function ModuleRunStatus({ runStatus }: { runStatus: ModuleCard['runStatus'] }) {
  if (!runStatus) return <StatusTag label="空闲" />
  return (
    <StatusTag
      label={RUN_STATUS_LABELS[runStatus]}
      tone={runStatus === 'running' ? 'info' : runStatus === 'waiting-approval' ? 'warning' : 'neutral'}
    />
  )
}

export function ModuleCardsSection({ modules }: { modules: readonly ModuleCard[] }) {
  const moduleCount = modules.length
  return (
    <section aria-label="按职责模块拆分" className="mb-6">
      <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
        <h2 className="text-base font-semibold">按职责模块拆分</h2>
        <span className="text-sm text-fg-muted">{moduleCount} 个模块</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {modules.map((module) => (
          <article
            key={module.moduleId}
            aria-label={`${responsibilityModuleName(module.moduleId)}模块卡`}
            className="min-h-24 rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-medium">{responsibilityModuleName(module.moduleId)}</h3>
              <ModuleRunStatus runStatus={module.runStatus} />
            </div>
            <dl className="mt-3 flex gap-5 text-sm text-fg-muted">
              <div className="flex items-baseline gap-1">
                <dt>未归档事故</dt>
                <dd className="text-base tabular-nums text-fg">{module.activeIncidents}</dd>
              </div>
              <div className="flex items-baseline gap-1">
                <dt>待审批</dt>
                <dd className="text-base tabular-nums text-fg">{module.pendingApprovals}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  )
}

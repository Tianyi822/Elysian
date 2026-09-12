import {
  AUDIT_KIND_LABELS,
  RISK_LEVEL_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
} from '@elysian/contracts'
import { useEffect } from 'react'
import { Link } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { RiskTag } from '../../components/RiskTag'
import { Section } from '../../components/Section'
import { SeverityTag, StatusTag } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useOverviewStore } from '../../stores/overviewStore'

const SERVICE_COLUMNS = [
  { key: 'service', header: '服务', width: '40%' },
  { key: 'open', header: '未归档事故', width: '120px', numeric: true },
  { key: 'severity', header: '最高严重等级', width: '140px' },
]

export function OverviewPage() {
  const gateway = useGateway()
  const status = useOverviewStore((state) => state.status)
  const data = useOverviewStore((state) => state.data)
  const errorMessage = useOverviewStore((state) => state.errorMessage)
  const refreshing = useOverviewStore((state) => state.refreshing)
  const load = useOverviewStore((state) => state.load)
  const refresh = useOverviewStore((state) => state.refresh)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  // 有内容就先把内容留着，错误只作为横幅提示；没有内容才占满屏。
  if (status === 'error' && !data) {
    return (
      <>
        <PageHeader title="总览" description="当前事故、Agent 运行、待审批动作与服务健康摘要。" />
        <ErrorState
          title="总览加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        />
      </>
    )
  }

  if (!data) {
    return (
      <>
        <PageHeader title="总览" description="当前事故、Agent 运行、待审批动作与服务健康摘要。" />
        <LoadingState label="正在加载总览…" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="总览"
        description="一眼看清当前态势：事故分布、Agent 运行、待审批动作与服务健康。"
        actions={
          <>
            {refreshing ? (
              <span role="status" className="text-xs text-fg-muted">
                正在刷新…
              </span>
            ) : null}
            {errorMessage ? (
              <span role="alert" className="text-xs text-danger">
                {errorMessage}
              </span>
            ) : null}
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void refresh(gateway)}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg disabled:opacity-50"
            >
              刷新
            </button>
          </>
        }
      />

      <Section
        title="事故严重等级分布"
        description="只统计事故，不含告警与待处理任务；点击某一档可以直接下钻到事件中心对应筛选。"
      >
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {SEVERITIES.map((severity) => (
            <li key={severity} className="flex items-center gap-2">
              <SeverityTag severity={severity} />
              <span className="text-lg tabular-nums">{data.severityCounts[severity]}</span>
              <Link
                className="text-xs text-accent underline"
                to={`/incidents?severity=${severity}`}
                aria-label={`查看${SEVERITY_LABELS[severity]}的条目`}
              >
                查看
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-fg-muted">
          事故共 {data.incidentTotal} 条；事件中心共 {data.eventTotal} 条（含告警与待处理任务）。
          <Link className="ml-1 text-accent underline" to="/incidents">
            打开事件中心
          </Link>
        </p>
      </Section>

      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <h2 className="text-xs text-fg-subtle">Agent 运行</h2>
          <p className="text-sm">
            执行中 {data.runningRuns} 次运行 · 等待审批 {data.waitingRuns} 次运行 ·{' '}
            {data.activeModules} 个模块有活跃运行
          </p>
          <Link className="text-xs text-accent underline" to="/runs">
            查看 Agent 运行
          </Link>
        </div>

        <div>
          <h2 className="text-xs text-fg-subtle">待审批动作</h2>
          <p className="flex items-center gap-2 text-sm">
            {data.pendingApprovals} 条
            {data.highestPendingRisk ? (
              <>
                <span className="text-xs text-fg-muted">最高风险</span>
                <RiskTag level={data.highestPendingRisk} />
              </>
            ) : null}
          </p>
          <Link
            className="text-xs text-accent underline"
            to={
              data.highestPendingRisk
                ? `/approvals?status=pending&risk=${data.highestPendingRisk}`
                : '/approvals?status=pending'
            }
          >
            处理审批队列
          </Link>
        </div>
      </div>

      <Section
        title="服务健康摘要"
        description="按未归档事故推算，只反映演示数据集的状况。"
      >
        <DataTable label="服务健康" columns={SERVICE_COLUMNS}>
          {data.serviceHealth.map((service) => (
            <DataRow key={service.service}>
              <DataCell muted>{service.service}</DataCell>
              <DataCell numeric muted>
                {service.openCount}
              </DataCell>
              <DataCell>
                {service.worstSeverity ? (
                  <SeverityTag severity={service.worstSeverity} />
                ) : (
                  <StatusTag label="正常" tone="success" />
                )}
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      </Section>

      <Section
        title="最近活动"
        description="事件、Agent 决策、工具调用、审批与执行结果的最新记录。"
        actions={
          <Link className="text-xs text-accent underline" to="/audit">
            打开审计日志
          </Link>
        }
      >
        {data.recentActivity.length === 0 ? (
          <EmptyState title="还没有活动记录" description="数据集里没有任何审计记录。" />
        ) : (
          <ol className="space-y-1">
            {data.recentActivity.map((record) => (
              <li key={record.id} className="flex flex-wrap items-baseline gap-2">
                <time className="text-xs tabular-nums text-fg-subtle">
                  {formatDateTime(record.at)}
                </time>
                <StatusTag label={AUDIT_KIND_LABELS[record.kind]} tone="info" />
                <span className="text-sm">{record.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {data.highestPendingRisk === 'critical' ? (
        <p className="text-xs text-fg-muted">
          提示：当前有致命风险动作等待审批，最高风险为 {RISK_LEVEL_LABELS.critical}。
        </p>
      ) : null}
    </>
  )
}

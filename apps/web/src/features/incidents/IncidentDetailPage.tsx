import {
  APPROVAL_OUTCOME_LABELS,
  APPROVAL_STATUS_LABELS,
  INCIDENT_STATUS_LABELS,
} from '@elysian/contracts'
import type { ApprovalRequest, ExecutionResult, Incident } from '@elysian/contracts'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { RiskTag } from '../../components/RiskTag'
import { Section } from '../../components/Section'
import { INCIDENT_STATUS_TONE, SeverityTag, StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { Timeline } from '../../components/Timeline'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'

const EVIDENCE_KIND_LABELS = {
  metric: '指标',
  log: '日志',
  change: '变更',
  topology: '拓扑',
} as const

const CONFIDENCE_LABELS = {
  low: '置信度低',
  medium: '置信度中',
  high: '置信度高',
} as const

const EXECUTION_STATUS_LABELS: Record<ExecutionResult['status'], string> = {
  'awaiting-integration': '待接入真实执行',
  succeeded: '执行成功',
  failed: '执行失败',
  'rolled-back': '已回滚',
}

/** 色调随执行状态走，不写死一个警告色：否则将来出现成功或回滚的结果会显示成同一种颜色。 */
const EXECUTION_STATUS_TONES: Record<ExecutionResult['status'], StatusTone> = {
  'awaiting-integration': 'warning',
  succeeded: 'success',
  failed: 'danger',
  'rolled-back': 'warning',
}

const ACTION_COLUMNS = [
  { key: 'action', header: '动作', width: '26%' },
  { key: 'target', header: '目标', width: '16%' },
  { key: 'risk', header: '风险等级', width: '96px' },
  { key: 'blast', header: '影响范围', width: '28%' },
  { key: 'approval', header: '审批状态', width: '18%' },
]

type DetailState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; incident: Incident; approvals: ReadonlyMap<string, ApprovalRequest> }

export function IncidentDetailPage() {
  const gateway = useGateway()
  const { incidentId = '' } = useParams<{ incidentId: string }>()
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    void (async () => {
      try {
        const [incident, approvals] = await Promise.all([
          gateway.incidents.find(incidentId),
          gateway.approvals.list(),
        ])
        if (cancelled) return
        if (!incident) {
          setState({ status: 'not-found' })
          return
        }
        setState({
          status: 'ready',
          incident,
          approvals: new Map(approvals.map((approval) => [approval.id, approval])),
        })
      } catch (error) {
        if (cancelled) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : '读取事故详情失败',
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gateway, incidentId, reloadToken])

  if (state.status === 'loading') {
    return (
      <>
        <PageHeader title="事故详情" description={incidentId} />
        <LoadingState label="正在加载事故详情…" />
      </>
    )
  }

  if (state.status === 'error') {
    return (
      <>
        <PageHeader title="事故详情" description={incidentId} />
        <ErrorState
          title="事故详情加载失败"
          description={state.message}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </>
    )
  }

  if (state.status === 'not-found') {
    return (
      <>
        <PageHeader title="事故详情" description={incidentId} />
        <EmptyState
          title="没有这条事故"
          description={`数据集里找不到 ${incidentId}，它可能已被归档或标识写错了。`}
          action={
            <Link className="text-accent underline" to="/incidents">
              返回事件中心
            </Link>
          }
        />
      </>
    )
  }

  const { incident, approvals } = state

  return (
    <>
      <PageHeader
        title={`${incident.id} ${incident.title}`}
        description={`受影响服务 ${incident.service} · 来源 ${incident.source}`}
        actions={
          <Link className="text-accent underline" to="/incidents">
            返回事件中心
          </Link>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <SeverityTag severity={incident.severity} />
        <StatusTag
          label={INCIDENT_STATUS_LABELS[incident.status]}
          tone={INCIDENT_STATUS_TONE[incident.status]}
        />
        <span>
          检测于 <time className="tabular-nums">{formatDateTime(incident.detectedAt)}</time>
        </span>
        <span>
          更新于 <time className="tabular-nums">{formatDateTime(incident.updatedAt)}</time>
        </span>
        <span>负责人 {incident.owner}</span>
        {incident.runId ? (
          <Link className="text-accent underline" to={`/runs?focus=${incident.runId}`}>
            查看 Agent 运行
          </Link>
        ) : (
          <span className="text-fg-subtle">本次事故尚无 Agent 运行</span>
        )}
      </div>

      <Section
        title="指标摘要"
        description="指标用于判断影响是否还在扩大，当前值来自演示数据。"
      >
        <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
          {incident.metrics.map((metric) => (
            <div key={metric.label} className="min-w-[9rem]">
              <dt className="text-xs text-fg-subtle">{metric.label}</dt>
              <dd className="text-sm tabular-nums">
                {metric.value}
                {metric.unit ? <span className="ml-0.5 text-xs text-fg-muted">{metric.unit}</span> : null}
                {metric.trend ? (
                  <span className="ml-1 text-xs text-fg-muted">
                    {metric.trend === 'rising' ? '上升' : metric.trend === 'falling' ? '下降' : '平稳'}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="时间线" description="按时间顺序呈现事故的演进过程。">
        <Timeline entries={incident.timeline} />
      </Section>

      <Section
        title="证据"
        description="每条证据都能指回来源，供人工核对，不代替判断。"
      >
        <ul className="space-y-1">
          {incident.evidence.map((evidence) => (
            <li key={evidence.id} className="flex flex-wrap items-baseline gap-2">
              <StatusTag label={EVIDENCE_KIND_LABELS[evidence.kind]} />
              <span className="text-sm">{evidence.summary}</span>
              <code className="text-xs text-fg-subtle">{evidence.sourceRef}</code>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="判断"
        description="判断基于上面的证据得出，与证据分开呈现，不伪装成已确认事实。"
      >
        <ul className="space-y-1">
          {incident.findings.map((finding) => (
            <li key={finding.id} className="flex flex-wrap items-baseline gap-2">
              <StatusTag label={CONFIDENCE_LABELS[finding.confidence]} tone="info" />
              <span className="text-sm">{finding.statement}</span>
              <span className="text-xs text-fg-subtle">依据 {finding.evidenceIds.length} 条证据</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="建议动作与审批状态"
        description="高风险动作必须经人工审批；未获批之前不会执行，也不显示为已执行。"
      >
        <DataTable label="建议动作" columns={ACTION_COLUMNS}>
          {incident.actions.map((action) => {
            const approval = action.approvalId ? approvals.get(action.approvalId) : undefined
            return (
              <DataRow key={action.id}>
                <DataCell>
                  <span className="block text-sm">{action.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-subtle">
                    {Object.entries(action.parameters)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' · ')}
                  </span>
                </DataCell>
                <DataCell muted>
                  <code className="text-xs">{action.target}</code>
                </DataCell>
                <DataCell>
                  <RiskTag level={action.riskLevel} />
                </DataCell>
                <DataCell muted>{action.blastRadius}</DataCell>
                <DataCell>
                  {approval ? (
                    <span className="flex flex-col gap-1">
                      <StatusTag
                        label={APPROVAL_STATUS_LABELS[approval.status]}
                        tone={
                          approval.status === 'approved'
                            ? 'success'
                            : approval.status === 'rejected'
                              ? 'danger'
                              : approval.status === 'expired'
                                ? 'neutral'
                                : 'warning'
                        }
                      />
                      {approval.outcome ? (
                        <span className="text-xs text-fg-muted">
                          决策结果 {APPROVAL_OUTCOME_LABELS[approval.outcome]}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-muted">未获批前不会执行</span>
                      )}
                      <Link
                        className="text-xs text-accent underline"
                        to={`/approvals?focus=${approval.id}`}
                      >
                        查看审批条目
                      </Link>
                    </span>
                  ) : (
                    <StatusTag label="不需审批" />
                  )}
                </DataCell>
              </DataRow>
            )
          })}
        </DataTable>
      </Section>

      <Section
        title="执行结果"
        description="演示环境未接入真实执行通道，这里只登记处置结论与回滚状态。"
      >
        {incident.executionResults.length === 0 ? (
          <p className="text-sm text-fg-muted">暂无执行结果记录。</p>
        ) : (
          <ul className="space-y-1">
            {incident.executionResults.map((result) => (
              <li key={result.id} className="flex flex-wrap items-baseline gap-2">
                <StatusTag
                  label={EXECUTION_STATUS_LABELS[result.status]}
                  tone={EXECUTION_STATUS_TONES[result.status]}
                />
                <span className="text-sm">{result.summary}</span>
                <span className="text-xs text-fg-subtle">所属动作 {result.actionId}</span>
                <time className="text-xs tabular-nums text-fg-subtle">
                  {formatDateTime(result.at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

import {
  APPROVAL_OUTCOME_LABELS,
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  RISK_LEVELS,
  RISK_LEVEL_LABELS,
} from '@elysian/contracts'
import type { ApprovalStatus } from '@elysian/contracts'
import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { RiskTag } from '../../components/RiskTag'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { ToggleChip } from '../../components/ToggleChip'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useApprovalQueueStore } from '../../stores/approvalQueueStore'
import {
  APPROVAL_SORTS,
  APPROVAL_SORT_LABELS,
  hasActiveApprovalFilters,
  matchesApprovalQuery,
  parseApprovalQuery,
  sortApprovals,
  toApprovalSearchParams,
  toggleValue,
} from './query'

const STATUS_TONE: Record<ApprovalStatus, StatusTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
}

const COLUMNS = [
  { key: 'risk', header: '风险等级', width: '92px' },
  { key: 'action', header: '动作与参数', width: '26%' },
  { key: 'blast', header: '影响范围', width: '22%' },
  { key: 'status', header: '队列状态', width: '96px' },
  { key: 'outcome', header: '决策结果', width: '104px' },
  { key: 'requester', header: '提出者与时效', width: '15%' },
  { key: 'actions', header: '操作', width: '132px' },
]

export function ApprovalQueuePage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()

  const queryKey = searchParams.toString()
  const query = useMemo(() => parseApprovalQuery(new URLSearchParams(queryKey)), [queryKey])

  const status = useApprovalQueueStore((state) => state.status)
  const approvals = useApprovalQueueStore((state) => state.approvals)
  const errorMessage = useApprovalQueueStore((state) => state.errorMessage)
  const actionError = useApprovalQueueStore((state) => state.actionError)
  const lastDecisionNote = useApprovalQueueStore((state) => state.lastDecisionNote)
  const busyApprovalId = useApprovalQueueStore((state) => state.busyApprovalId)
  const load = useApprovalQueueStore((state) => state.load)
  const decide = useApprovalQueueStore((state) => state.decide)

  useEffect(() => {
    void load(gateway.approvals)
  }, [gateway, load])

  const visible = useMemo(
    () =>
      sortApprovals(
        approvals.filter((approval) => matchesApprovalQuery(approval, query)),
        query.sort,
        query.focus,
      ),
    [approvals, query],
  )

  const pendingCount = approvals.filter((approval) => approval.status === 'pending').length
  const apply = (next: Parameters<typeof toApprovalSearchParams>[0]) => {
    setSearchParams(toApprovalSearchParams(next))
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="审批队列" description="待审批动作、影响范围与风险说明。" />
        <ErrorState
          title="审批队列加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway.approvals)}
        />
      </>
    )
  }

  if (status !== 'ready' && approvals.length === 0) {
    // 首次加载完成前不渲染空态：否则会先闪一下「没有审批条目」，而那是假的。
    return (
      <>
        <PageHeader title="审批队列" description="待审批动作、影响范围与风险说明。" />
        <LoadingState label="正在加载审批队列…" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="审批队列"
        description="高风险动作必须经人工审批。这里的批准与拒绝只改变演示状态，动作本身待接入真实执行通道。"
        actions={
          <>
            <span className="text-xs text-fg-muted">
              待审批 {pendingCount} 条 / 共 {approvals.length} 条
            </span>
            <button
              type="button"
              onClick={() => void load(gateway.approvals)}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
            >
              刷新
            </button>
          </>
        }
      />

      <div className="mb-3 space-y-1.5">
        <div role="group" aria-labelledby="approval-status" className="flex flex-wrap items-center gap-1.5">
          <span id="approval-status" className="mr-1 text-xs text-fg-subtle">
            队列状态
          </span>
          {APPROVAL_STATUSES.map((approvalStatus) => (
            <ToggleChip
              key={approvalStatus}
              label={APPROVAL_STATUS_LABELS[approvalStatus]}
              checked={query.statuses.includes(approvalStatus)}
              onChange={() =>
                apply({ ...query, statuses: toggleValue(query.statuses, approvalStatus) })
              }
            />
          ))}
        </div>

        <div role="group" aria-labelledby="approval-risk" className="flex flex-wrap items-center gap-1.5">
          <span id="approval-risk" className="mr-1 text-xs text-fg-subtle">
            风险等级
          </span>
          {RISK_LEVELS.map((risk) => (
            <ToggleChip
              key={risk}
              label={RISK_LEVEL_LABELS[risk]}
              checked={query.risks.includes(risk)}
              onChange={() => apply({ ...query, risks: toggleValue(query.risks, risk) })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="approval-sort" className="text-xs text-fg-subtle">
            排序
          </label>
          <select
            id="approval-sort"
            value={query.sort}
            onChange={(event) => apply({ ...query, sort: event.target.value as typeof query.sort })}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-fg"
          >
            {APPROVAL_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {APPROVAL_SORT_LABELS[sort]}
              </option>
            ))}
          </select>
          {hasActiveApprovalFilters(query) ? (
            <button
              type="button"
              onClick={() => apply({ ...query, statuses: [], risks: [] })}
              className="rounded border border-line px-2 py-0.5 text-xs text-fg-muted"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          审批操作失败：{actionError}
        </p>
      ) : null}

      {lastDecisionNote ? (
        <p
          role="status"
          className="mb-2 rounded border border-success/40 bg-success/10 px-2 py-1 text-xs text-success"
        >
          {lastDecisionNote}
        </p>
      ) : null}

      {query.focus ? (
        <p className="mb-2 text-xs text-fg-muted">
          已定位到审批条目 <code className="font-mono">{query.focus}</code>，它被排在最前。
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          title="当前筛选条件下没有审批条目"
          description={
            hasActiveApprovalFilters(query)
              ? '这不是队列为空，而是筛选条件排除了全部条目。清除筛选可以看回完整队列。'
              : '队列里还没有任何审批请求。'
          }
        />
      ) : (
        <DataTable label="审批条目" columns={COLUMNS}>
          {visible.map((approval) => (
            <DataRow key={approval.id}>
              <DataCell>
                <RiskTag level={approval.riskLevel} />
              </DataCell>
              <DataCell>
                <span className="block text-sm">{approval.actionTitle}</span>
                <span className="mt-0.5 block text-xs text-fg-subtle">
                  {Object.entries(approval.parameters)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' · ')}
                </span>
                <code className="mt-0.5 block text-xs text-fg-subtle">{approval.target}</code>
                <span className="mt-0.5 block text-xs text-fg-subtle">待接入真实执行</span>
              </DataCell>
              <DataCell muted>{approval.blastRadius}</DataCell>
              <DataCell>
                <StatusTag
                  label={APPROVAL_STATUS_LABELS[approval.status]}
                  tone={STATUS_TONE[approval.status]}
                />
              </DataCell>
              <DataCell>
                {approval.outcome ? (
                  <span className="flex flex-col gap-0.5">
                    <span className="text-xs text-fg-muted">
                      {APPROVAL_OUTCOME_LABELS[approval.outcome]}
                    </span>
                    {approval.note ? (
                      <span className="text-xs text-fg-subtle">决定说明：{approval.note}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </DataCell>
              <DataCell muted>
                <span className="block text-xs">提出 {approval.requestedBy}</span>
                <span className="block text-xs tabular-nums">
                  过期 {formatDateTime(approval.expiresAt)}
                </span>
                {approval.decidedBy ? (
                  <span className="block text-xs">
                    由 {approval.decidedBy} 于{' '}
                    {formatDateTime(approval.decidedAt ?? approval.requestedAt)}
                  </span>
                ) : null}
              </DataCell>
              <DataCell>
                {approval.status === 'pending' ? (
                  <span className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={busyApprovalId === approval.id}
                      onClick={() => void decide(gateway.approvals, approval.id, { outcome: 'allowed-once' })}
                      className="rounded border border-success/50 px-1.5 py-0.5 text-xs text-success disabled:opacity-50"
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      disabled={busyApprovalId === approval.id}
                      onClick={() => void decide(gateway.approvals, approval.id, { outcome: 'rejected' })}
                      className="rounded border border-danger/50 px-1.5 py-0.5 text-xs text-danger disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </span>
                ) : (
                  <span className="text-fg-subtle">已处理</span>
                )}
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}
    </>
  )
}

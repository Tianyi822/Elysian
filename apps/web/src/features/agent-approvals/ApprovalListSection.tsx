import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentApproval } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentApprovalStatusTag, AgentOperationStatusTag } from '../../components/agent/AgentStatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { JsonView } from '../../components/agent/JsonView'
import { BusyVeil } from '../../components/RefreshState'
import { CTL_PRIMARY, CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useNotificationStore } from '../../stores/notificationStore'
import { isQueueFullError, selectApprovalsByRun, useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { AGENT_OPERATION_POLICY_LABELS, formatApprovalCountdown } from './approvalsFormat'

/*
 * 「待审批」页签：服务端序（pending/approved 优先、最多 200 条）原样呈现，
 * runId 深链过滤在前端做；行内到期倒计时只作提示，过期权威状态以服务端
 * 下次列表读取回传的 expired 为准。详情弹窗展示 Operation 权威字段，
 * argumentsJson 用 JsonView 原文只读展示（不重序列化、附复制）。
 */

export function ApprovalListSection({
  runId,
  onOpenDetail,
}: {
  runId?: string
  onOpenDetail(approvalId: string): void
}) {
  const approvals = useAgentApprovalsStore((state) => state.approvals)
  const status = useAgentApprovalsStore((state) => state.approvalsStatus)
  const errorMessage = useAgentApprovalsStore((state) => state.approvalsError)
  const reloading = useAgentApprovalsStore((state) => state.approvalsReloading)
  const load = useAgentApprovalsStore((state) => state.loadApprovals)
  const gateway = useGateway()
  const [now, setNow] = useState(() => Date.now())

  // 倒计时每 30 秒刷新一次呈现；不驱动任何请求。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const visible = useMemo(() => selectApprovalsByRun(approvals, runId), [approvals, runId])

  if (status === 'loading' || status === 'idle') return <LoadingState label="正在读取审批列表…" />
  if (status === 'error') {
    return <ErrorState title="审批列表读取失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        title={runId ? '该运行没有审批记录' : '当前没有待处理的审批'}
        description={runId ? `运行 ${runId} 名下没有审批条目。` : 'Agent 的潜在写操作会先落审批，批准或拒绝后这里会留下记录。'}
      />
    )
  }
  return (
    <div className="busy-host">
      <BusyVeil busy={reloading} />
      {visible.length >= 200 ? (
        <p className="mb-2 text-xs text-fg-muted" role="note">仅显示最近 200 条</p>
      ) : null}
      <div role="region" aria-label="审批列表" className="overflow-x-auto panel-surface">
        <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
          <colgroup>
            <col className="w-[11%]" />
            <col className="w-[26%]" />
            <col className="w-[19%]" />
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead>
            <tr>
              {['状态', '能力 / 说明', 'Run / Task', '工作流节点', '到期倒计时', '操作'].map((label) => (
                <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} now={now} onOpenDetail={onOpenDetail} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ApprovalRow({ approval, now, onOpenDetail }: { approval: AgentApproval; now: number; onOpenDetail(approvalId: string): void }) {
  const countdown = formatApprovalCountdown(approval.expiresAt, now)
  const isGate = approval.kind === 'workflow-gate'
  const operation = isGate ? undefined : approval.operation
  return (
    <tr className="transition-colors hover:bg-surface-raised">
      <td className="border-b border-line px-3 py-2.5">
        <AgentApprovalStatusTag status={approval.status} />
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-fg" title={isGate ? approval.instruction : operation?.capability.name}>
            {isGate ? `工作流闸门 · ${approval.workflowStepId}` : operation?.capability.name}
          </span>
          <span className="truncate text-xs text-fg-muted" title={isGate ? approval.instruction : operation?.capability.description}>
            {isGate ? approval.instruction : operation?.capability.description}
          </span>
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">
        <span className="flex min-w-0 flex-col">
          {operation ? (
            <Link className="truncate text-fg underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(operation.runId)}`}>
              {operation.runId}
            </Link>
          ) : (
            <Link className="truncate text-fg underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(approval.runId)}`}>
              {approval.runId}
            </Link>
          )}
          <span className="truncate">{operation ? operation.taskId : '—'}</span>
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs">
        {approval.workflowId !== undefined && approval.nodeId !== undefined ? (
          <Link
            className="text-fg underline-offset-2 hover:underline"
            to={`/agent/workflows?instanceId=${encodeURIComponent(approval.workflowId)}&nodeId=${encodeURIComponent(approval.nodeId)}`}
            title={`作用域 ${approval.scopeId ?? '—'} · 节点 ${approval.nodeId}`}
          >
            {approval.nodeId}
          </Link>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className={`border-b border-line px-3 py-2.5 tabular-nums text-xs ${countdown.expired ? 'text-danger' : 'text-fg-muted'}`}>
        <time dateTime={approval.expiresAt}>{countdown.text}</time>
        {countdown.expired && approval.status === 'pending' ? <span className="ml-1 text-danger">（待服务端确认）</span> : null}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <button type="button" className={CTL_SECONDARY} onClick={() => onOpenDetail(approval.id)}>
          查看详情
        </button>
      </td>
    </tr>
  )
}

/** 审批详情弹窗：Operation 权威字段 + 批准/拒绝（文案写动作）。 */
export function ApprovalDetailDialog({ approvalId, onClose }: { approvalId: string; onClose(): void }) {
  const gateway = useGateway()
  const approval = useAgentApprovalsStore((state) => state.approvals.find((item) => item.id === approvalId))
  const deciding = useAgentApprovalsStore((state) => state.decidingIds.includes(approvalId))
  const decide = useAgentApprovalsStore((state) => state.decideApproval)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()

  if (approval === undefined) return null
  const isGate = approval.kind === 'workflow-gate'
  const operation = isGate ? undefined : approval.operation

  const submitDecision = (decision: 'approved' | 'denied') => {
    void inFlightOnly(async () => {
      try {
        const decided = await decide(gateway, approvalId, decision)
        if (decided === undefined) return
        notify({
          tone: decision === 'approved' ? 'success' : 'info',
          message: decision === 'approved'
            ? '已批准并继续：关联运行将重新排队执行'
            : '已拒绝并终止：关联运行结束（approval-denied），任务记忆标记待整理',
        })
        onClose()
      } catch (error) {
        const message = error instanceof Error && error.message !== '' ? error.message : '审批提交失败'
        notify({ tone: isQueueFullError(error) ? 'info' : 'danger', message })
      }
    })
  }

  return (
    <DialogShell title={`审批详情 · ${approval.id}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <AgentApprovalStatusTag status={approval.status} />
        <span>{isGate ? '工作流闸门审批' : '操作审批'}</span>
        <span>创建于 {formatDateTime(approval.createdAt)}</span>
        {approval.decidedAt ? <span>决定于 {formatDateTime(approval.decidedAt)}</span> : null}
      </div>

      {approval.workflowId !== undefined ? (
        <MetaGrid
          rows={[
            ['工作流定位', approval.nodeId !== undefined
              ? `${approval.scopeId ?? '—'} / ${approval.nodeId}`
              : (approval.scopeId ?? '—')],
            ['步骤 / 尝试', approval.workflowStepId !== undefined ? `${approval.workflowStepId}（第 ${approval.workflowAttempt ?? 1} 次）` : '—'],
          ]}
        />
      ) : null}

      {isGate ? (
        <>
          <MetaGrid rows={[['闸门指令', approval.instruction], ['内容摘要', approval.contentDigest]]} />
          <JsonView text={approval.inputJson} label="闸门输入原文" />
        </>
      ) : operation !== undefined ? (
        <>
          <MetaGrid
            rows={[
              ['工具名', operation.capability.name],
              ['操作状态', <AgentOperationStatusTag key="op-status" status={operation.status} />],
              ['审批策略', AGENT_OPERATION_POLICY_LABELS[operation.policy] ?? operation.policy],
              ['工作区修订', `第 ${operation.workspaceRevision} 版`],
              ['快照摘要', operation.snapshotDigest],
              ['能力来源', `${operation.capability.source}${operation.capability.originalName ? `（原名 ${operation.capability.originalName}）` : ''}`],
              ['能力修订', `${operation.capability.ref.id} @ ${operation.capability.ref.revision}${operation.capability.ref.digest ? ` · ${operation.capability.ref.digest}` : ''}`],
              ['只读能力', operation.capability.readOnly ? '是' : '否'],
            ]}
          />
          {operation.execution !== undefined ? (
            <div className="rounded-lg border border-line bg-surface p-2 text-xs text-fg-muted">
              <p className="font-medium text-fg">执行计划</p>
              <p>执行配置：{operation.execution.profile.name}（{operation.execution.profile.image} · {operation.execution.profile.runtime}）</p>
              {operation.execution.grant !== undefined ? (
                <p>
                  授权：{operation.execution.grant.name}
                  {operation.execution.grant.directories.length > 0
                    ? ` · 目录 ${operation.execution.grant.directories.map((entry) => `${entry.path}(${entry.access})`).join('、')}`
                    : ' · 无目录授权'}
                  {operation.execution.grant.network.length > 0
                    ? ` · 出网 ${operation.execution.grant.network.map((endpoint) => `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`).join('、')}`
                    : ''}
                </p>
              ) : (
                <p>授权：无（默认无目录与网络授权）</p>
              )}
              <p>脚本摘要：{operation.execution.scriptDigest}</p>
            </div>
          ) : null}
          <JsonView text={operation.argumentsJson} label="调用参数原文" />
          <p className="text-xs text-fg-subtle">
            参数按服务端原文逐字节展示，未做重序列化；批准与派发以同一份原文为准。
          </p>
        </>
      ) : null}

      <div className="mt-auto flex flex-wrap justify-end gap-2 pt-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>关闭</button>
        {approval.status === 'pending' ? (
          <>
            <button
              type="button"
              className={CTL_DANGER}
              disabled={submitting || deciding}
              onClick={() => submitDecision('denied')}
            >
              拒绝并终止
            </button>
            <button
              type="button"
              className={CTL_PRIMARY}
              disabled={submitting || deciding}
              onClick={() => submitDecision('approved')}
            >
              批准并继续
            </button>
          </>
        ) : (
          <span className="self-center text-xs text-fg-subtle">
            该审批已不在待处理状态，不能再次决定。
          </span>
        )}
      </div>
    </DialogShell>
  )
}

/** Radix 弹窗骨架（抄 RenameDialog/SshKeyRemoveDialog 形态）。 */
export function DialogShell({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 z-[61] max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto panel-surface flex flex-col gap-3 p-4 shadow-xl ${wide ? 'w-[min(52rem,calc(100vw-2rem))]' : ''}`}
        >
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function MetaGrid({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-surface p-2 text-xs sm:grid-cols-[9rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="min-w-0 break-all text-fg">{value === '' || value === undefined ? '—' : value}</dd>
        </div>
      ))}
    </dl>
  )
}

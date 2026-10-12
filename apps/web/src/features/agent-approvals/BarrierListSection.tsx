import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { AgentExecutionBarrier } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { BusyVeil } from '../../components/RefreshState'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { Info } from '../../components/icons'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useNotificationStore } from '../../stores/notificationStore'
import { selectBarriersByRun, useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { AGENT_RECONCILIATION_DECISION_LABELS, byteLength } from './approvalsFormat'
import { DialogShell } from './ApprovalListSection'

/*
 * 「执行屏障」页签：dispatched（在途）与 unknown（结果未确认）分栏语义靠状态标签
 * 与核实入口表达；仅 unknown 可人工核实，常驻说明卡明确「结果未知不代表失败」。
 * 绑定 Operation 概要经 GET /runs/{id}/operations 读取（argumentsJson 原文不重序列化）。
 */

const BARRIER_STATUS_LABELS: Record<AgentExecutionBarrier['status'], string> = {
  dispatched: '已派发（在途）',
  unknown: '结果未确认',
  confirmed: '已确认',
  reconciled: '已核实关闭',
}

const BARRIER_STATUS_TONES: Record<AgentExecutionBarrier['status'], 'info' | 'danger' | 'success'> = {
  dispatched: 'info',
  unknown: 'danger',
  confirmed: 'success',
  reconciled: 'success',
}

export function BarrierListSection({ runId }: { runId?: string }) {
  const gateway = useGateway()
  const barriers = useAgentApprovalsStore((state) => state.barriers)
  const status = useAgentApprovalsStore((state) => state.barriersStatus)
  const errorMessage = useAgentApprovalsStore((state) => state.barriersError)
  const reloading = useAgentApprovalsStore((state) => state.barriersReloading)
  const load = useAgentApprovalsStore((state) => state.loadBarriers)
  const [reconcileId, setReconcileId] = useState<string | undefined>(undefined)
  const visible = useMemo(() => selectBarriersByRun(barriers, runId), [barriers, runId])

  if (status === 'loading' || status === 'idle') return <LoadingState label="正在读取执行屏障…" />
  if (status === 'error') {
    return <ErrorState title="执行屏障读取失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="panel-surface flex items-start gap-2 p-3 text-xs text-fg-muted" role="note">
        <Info aria-hidden size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
        <span>
          结果未知不代表失败：操作可能已在远端生效，核实只关闭屏障、不重跑、不改旧 Run 终态。
          在途（dispatched）屏障必须先等操作结束确认，暂不能人工核实。
        </span>
      </p>
      {visible.length === 0 ? (
        <EmptyState
          title={runId ? '该运行没有执行屏障' : '当前没有执行屏障'}
          description={runId ? `运行 ${runId} 名下没有屏障条目。` : '潜在写操作派发后会出现执行屏障；重启后面板已派发但结果未确认的操作也会落在这里。'}
        />
      ) : (
        <div className="busy-host">
          <BusyVeil busy={reloading} />
          <div role="region" aria-label="执行屏障列表" className="overflow-x-auto panel-surface">
            <table className="w-full min-w-[48rem] table-fixed border-separate border-spacing-0 text-left text-sm">
              <colgroup>
                <col className="w-[14%]" />
                <col className="w-[22%]" />
                <col className="w-[18%]" />
                <col className="w-[14%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr>
                  {['状态', '绑定操作概要', 'Run / 工作流节点', '创建时间', '核实结论', '操作'].map((label) => (
                    <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((barrier) => (
                  <BarrierRow key={barrier.id} barrier={barrier} onReconcile={() => setReconcileId(barrier.id)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {reconcileId !== undefined ? (
        <BarrierReconcileDialog barrierId={reconcileId} onClose={() => setReconcileId(undefined)} />
      ) : null}
    </div>
  )
}

function BarrierRow({ barrier, onReconcile }: { barrier: AgentExecutionBarrier; onReconcile(): void }) {
  const operations = useAgentApprovalsStore((state) => state.operationsByRun[barrier.runId])
  const operation = operations?.find((item) => item.id === barrier.operationId)
  const reconciling = useAgentApprovalsStore((state) => state.reconcilingBarrierIds.includes(barrier.id))
  return (
    <tr className="transition-colors hover:bg-surface-raised">
      <td className="border-b border-line px-3 py-2.5">
        <StatusPill label={BARRIER_STATUS_LABELS[barrier.status]} tone={BARRIER_STATUS_TONES[barrier.status]} />
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-fg" title={barrier.operationId}>
            {operation?.capability.name ?? '操作读取中…'}
          </span>
          <span className="truncate text-fg-muted" title={barrier.operationId}>{barrier.operationId}</span>
          {operation !== undefined ? (
            <span className="truncate text-fg-subtle" title={operation.argumentsJson}>
              参数原文：{operation.argumentsJson}
            </span>
          ) : null}
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums">
        <span className="flex min-w-0 flex-col">
          <Link className="truncate text-fg underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(barrier.runId)}`}>
            {barrier.runId}
          </Link>
          {barrier.workflowId !== undefined && barrier.nodeId !== undefined ? (
            <Link
              className="truncate text-fg-muted underline-offset-2 hover:underline"
              to={`/agent/workflows?instanceId=${encodeURIComponent(barrier.workflowId)}&nodeId=${encodeURIComponent(barrier.nodeId)}`}
            >
              节点 {barrier.nodeId}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          )}
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">
        <time dateTime={barrier.createdAt}>{formatDateTime(barrier.createdAt)}</time>
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
        {barrier.decision !== undefined ? (
          <span className="flex flex-col gap-0.5">
            <span>{AGENT_RECONCILIATION_DECISION_LABELS[barrier.decision]}</span>
            {barrier.reconciledAt ? <time dateTime={barrier.reconciledAt}>{formatDateTime(barrier.reconciledAt)}</time> : null}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        {barrier.status === 'unknown' ? (
          <button type="button" className={CTL_SECONDARY} disabled={reconciling} onClick={onReconcile}>
            人工核实
          </button>
        ) : barrier.status === 'dispatched' ? (
          <button type="button" className={CTL_SECONDARY} disabled title="在途操作必须先结束确认流程，暂不能人工核实">
            人工核实
          </button>
        ) : (
          <span className="text-xs text-fg-subtle">已关闭</span>
        )}
      </td>
    </tr>
  )
}

export function StatusPill({ label, tone }: { label: string; tone: 'info' | 'danger' | 'success' }) {
  const toneClass = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-fg-muted'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneClass}`}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${tone === 'danger' ? 'bg-danger' : tone === 'success' ? 'bg-success' : 'bg-fg-subtle'}`} />
      {label}
    </span>
  )
}

/** 屏障人工核实弹窗：evidence 必填（1..8192 字节）＋二选一决定。 */
export function BarrierReconcileDialog({ barrierId, onClose }: { barrierId: string; onClose(): void }) {
  const gateway = useGateway()
  const barrier = useAgentApprovalsStore((state) => state.barriers.find((item) => item.id === barrierId))
  const reconcile = useAgentApprovalsStore((state) => state.reconcileBarrier)
  const reconciling = useAgentApprovalsStore((state) => state.reconcilingBarrierIds.includes(barrierId))
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [evidence, setEvidence] = useState('')
  const [decision, setDecision] = useState<'confirmed-stopped' | 'confirmed-completed'>('confirmed-stopped')
  const [validation, setValidation] = useState<string | undefined>(undefined)
  const evidenceId = useMemo(() => `barrier-evidence-${barrierId}`, [barrierId])

  if (barrier === undefined) return null

  const submit = () => {
    const bytes = byteLength(evidence)
    if (bytes < 1 || bytes > 8192) {
      setValidation('核实证据必须为 1 到 8192 字节')
      return
    }
    setValidation(undefined)
    void inFlightOnly(async () => {
      try {
        const result = await reconcile(gateway, barrierId, { evidence, decision })
        if (result === undefined) return
        notify({
          tone: 'success',
          message: result.releasedLeaseIds.length > 0
            ? '屏障已核实并关闭；关联资源租约已释放'
            : '屏障已核实并关闭',
        })
        onClose()
      } catch (error) {
        notify({ tone: 'danger', message: error instanceof Error && error.message !== '' ? error.message : '屏障核实失败' })
      }
    })
  }

  return (
    <DialogShell title={`人工核实执行屏障 · ${barrierId}`} onClose={onClose}>
      <p className="text-xs text-fg-muted">
        结果未知不代表失败：操作可能已在远端生效。核实只关闭屏障、不重跑、不改旧 Run 终态。
      </p>
      <div className="rounded-lg border border-line bg-surface p-2 text-xs text-fg-muted">
        <p>Run：<Link className="text-fg underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(barrier.runId)}`}>{barrier.runId}</Link></p>
        <p>操作：{barrier.operationId}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={evidenceId} className="text-xs font-medium text-fg-muted">
          外部核实证据（必填，{byteLength(evidence)}/8192 字节）
        </label>
        <textarea
          id={evidenceId}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          rows={4}
          className={`${CTL_FIELD} font-mono text-xs`}
          placeholder="例：docker ps 确认容器已退出，日志显示进程收到 SIGTERM 后完成落盘。"
        />
        {validation !== undefined ? (
          <p role="alert" className="text-xs text-danger">{validation}</p>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs font-medium text-fg-muted">核实结论</legend>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input type="radio" name={`barrier-decision-${barrierId}`} checked={decision === 'confirmed-stopped'} onChange={() => setDecision('confirmed-stopped')} />
          确认已停止（操作未完成或已中止）
        </label>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input type="radio" name={`barrier-decision-${barrierId}`} checked={decision === 'confirmed-completed'} onChange={() => setDecision('confirmed-completed')} />
          确认已完成（外部证据表明操作实际成功）
        </label>
      </fieldset>
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button type="button" className={CTL_PRIMARY} disabled={submitting || reconciling} onClick={submit}>
          提交核实结论
        </button>
      </div>
    </DialogShell>
  )
}

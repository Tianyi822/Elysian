import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { AgentResourceLease } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentResourceLeaseStatusTag } from '../../components/agent/AgentStatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { BusyVeil } from '../../components/RefreshState'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useNotificationStore } from '../../stores/notificationStore'
import { selectLocksByRun, useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { byteLength } from './approvalsFormat'
import { DialogShell } from './ApprovalListSection'

/*
 * 「资源租约」页签：state（waiting/held/unknown/released）与 scopeId 呈现全部租约；
 * 仅 source=mcp-probe 且停止结果未知的探测租约给核实入口（也只允许 confirmed-stopped），
 * 操作租约须通过对应执行屏障核实，不在这里给入口。
 */

export function LockListSection({ runId }: { runId?: string }) {
  const gateway = useGateway()
  const locks = useAgentApprovalsStore((state) => state.locks)
  const status = useAgentApprovalsStore((state) => state.locksStatus)
  const errorMessage = useAgentApprovalsStore((state) => state.locksError)
  const reloading = useAgentApprovalsStore((state) => state.locksReloading)
  const load = useAgentApprovalsStore((state) => state.loadLocks)
  const [reconcileId, setReconcileId] = useState<string | undefined>(undefined)
  const visible = useMemo(() => selectLocksByRun(locks, runId), [locks, runId])

  if (status === 'loading' || status === 'idle') return <LoadingState label="正在读取资源租约…" />
  if (status === 'error') {
    return <ErrorState title="资源租约读取失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        title={runId ? '该运行没有资源租约' : '当前没有资源租约'}
        description={runId ? `运行 ${runId} 名下没有租约条目。` : '资源互斥以租约落账；MCP 管理探测产生的遗留租约在这里核实。'}
      />
    )
  }
  return (
    <div className="busy-host">
      <BusyVeil busy={reloading} />
      <div role="region" aria-label="资源租约列表" className="overflow-x-auto panel-surface">
        <table className="w-full min-w-[48rem] table-fixed border-separate border-spacing-0 text-left text-sm">
          <colgroup>
            <col className="w-[12%]" />
            <col className="w-[14%]" />
            <col className="w-[20%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr>
              {['状态', '来源', 'scopeId', '服务 / 运行', '创建 / 结束', '操作'].map((label) => (
                <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((lock) => (
              <LockRow key={lock.id} lock={lock} onReconcile={() => setReconcileId(lock.id)} />
            ))}
          </tbody>
        </table>
      </div>
      {reconcileId !== undefined ? (
        <LockReconcileDialog lockId={reconcileId} onClose={() => setReconcileId(undefined)} />
      ) : null}
    </div>
  )
}

function LockRow({ lock, onReconcile }: { lock: AgentResourceLease; onReconcile(): void }) {
  const reconciling = useAgentApprovalsStore((state) => state.reconcilingLockIds.includes(lock.id))
  const isProbe = lock.source === 'mcp-probe'
  return (
    <tr className="transition-colors hover:bg-surface-raised">
      <td className="border-b border-line px-3 py-2.5">
        <AgentResourceLeaseStatusTag status={lock.state} />
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
        {isProbe ? 'MCP 探测' : lock.runId !== undefined ? '运行操作' : '—'}
      </td>
      <td className="border-b border-line px-3 py-2.5 font-mono text-xs break-all text-fg-muted" title={lock.scopeId}>
        {lock.scopeId}
      </td>
      <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums">
        {isProbe && lock.serverId !== undefined ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{lock.serverId}</span>
            <span className="text-fg-subtle">修订 {lock.serverRevision ?? '—'}</span>
          </span>
        ) : lock.runId !== undefined ? (
          <Link className="truncate text-fg underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(lock.runId)}`}>
            {lock.runId}
          </Link>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">
        <span className="flex flex-col">
          <time dateTime={lock.createdAt}>{formatDateTime(lock.createdAt)}</time>
          {lock.endedAt ? <time dateTime={lock.endedAt}>至 {formatDateTime(lock.endedAt)}</time> : null}
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5">
        {isProbe && lock.state === 'unknown' ? (
          <button type="button" className={CTL_SECONDARY} disabled={reconciling} onClick={onReconcile}>
            核实已停止
          </button>
        ) : isProbe ? (
          <span className="text-xs text-fg-subtle" title={lock.state === 'released' && lock.evidence ? `核实证据：${lock.evidence}` : undefined}>
            {lock.state === 'released' ? '已释放' : '等待中'}
          </span>
        ) : (
          <span className="text-xs text-fg-subtle" title="操作租约须通过对应执行屏障核实">
            经屏障核实
          </span>
        )}
      </td>
    </tr>
  )
}

/** 探测租约核实弹窗：仅 confirmed-stopped 可选，另一项禁用并说明。 */
export function LockReconcileDialog({ lockId, onClose }: { lockId: string; onClose(): void }) {
  const gateway = useGateway()
  const lock = useAgentApprovalsStore((state) => state.locks.find((item) => item.id === lockId))
  const reconcile = useAgentApprovalsStore((state) => state.reconcileLock)
  const reconciling = useAgentApprovalsStore((state) => state.reconcilingLockIds.includes(lockId))
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [evidence, setEvidence] = useState('')
  const [validation, setValidation] = useState<string | undefined>(undefined)
  const evidenceId = useMemo(() => `lock-evidence-${lockId}`, [lockId])

  if (lock === undefined) return null

  const submit = () => {
    const bytes = byteLength(evidence)
    if (bytes < 1 || bytes > 8192) {
      setValidation('核实证据必须为 1 到 8192 字节')
      return
    }
    setValidation(undefined)
    void inFlightOnly(async () => {
      try {
        const released = await reconcile(gateway, lockId, { evidence })
        if (released === undefined) return
        notify({ tone: 'success', message: '租约已核实并释放，MCP 探测可继续' })
        onClose()
      } catch (error) {
        notify({ tone: 'danger', message: error instanceof Error && error.message !== '' ? error.message : '租约核实失败' })
      }
    })
  }

  return (
    <DialogShell title={`核实探测租约 · ${lockId}`} onClose={onClose}>
      <p className="text-xs text-fg-muted">
        仅管理探测遗留租约（source=mcp-probe）：确认容器确实停止后释放租约，
        不能代替运行节点的恢复动作。
      </p>
      <div className="rounded-lg border border-line bg-surface p-2 text-xs text-fg-muted">
        <p>服务：{lock.serverId ?? '—'}（修订 {lock.serverRevision ?? '—'}）</p>
        <p>作用域：{lock.scopeId}</p>
        {lock.containerId ? <p>容器：{lock.containerId}</p> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={evidenceId} className="text-xs font-medium text-fg-muted">
          外部停止证据（必填，{byteLength(evidence)}/8192 字节）
        </label>
        <textarea
          id={evidenceId}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          rows={4}
          className={`${CTL_FIELD} font-mono text-xs`}
          placeholder="例：docker ps -a 已查不到该探测容器，卷列表无残留。"
        />
        {validation !== undefined ? (
          <p role="alert" className="text-xs text-danger">{validation}</p>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs font-medium text-fg-muted">核实结论</legend>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input type="radio" name={`lock-decision-${lockId}`} checked readOnly />
          确认已停止（confirmed-stopped）
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-subtle" title="探测租约仅支持确认已停止">
          <input type="radio" name={`lock-decision-${lockId}`} disabled />
          确认已完成（探测租约不支持该结论）
        </label>
      </fieldset>
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button type="button" className={CTL_PRIMARY} disabled={submitting || reconciling} onClick={submit}>
          确认已停止并释放租约
        </button>
      </div>
    </DialogShell>
  )
}

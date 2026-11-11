import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import type { PanelResourcePlan, PanelUpdatePreflight, PanelUpdateTarget } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'

const BUTTON = 'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg disabled:cursor-not-allowed disabled:opacity-50'
export function resourceSize(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(0)} MiB` }

export function PanelResourcePreflightDialog({ target, adapter, precompiled = false, onClose, onConfirm }: {
  target: PanelUpdateTarget; adapter: PanelAdapter; precompiled?: boolean; onClose(): void; onConfirm(plan: PanelResourcePlan): void
}) {
  const [report, setReport] = useState<PanelUpdatePreflight | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [targets, setTargets] = useState<string[]>([])
  const [stopPanel, setStopPanel] = useState(false)
  const [expired, setExpired] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const attempt = ++generation.current, auth = captureAuthGeneration()
    const current = () => generation.current === attempt && captureAuthGeneration() === auth
    setLoading(true); setReport(null); setError(null); setExpired(false); setTargets([]); setStopPanel(false)
    void adapter.preflightUpdate(target).then(value => {
      if (!current()) return
      setReport(value); setTargets(value.needsRelease ? value.candidates.filter(c => c.recommended && !c.disabledReason).map(c => c.id) : []); setStopPanel(value.needsRelease && value.stopPanelRecommended)
    }).catch(cause => { if (current()) setError(cause instanceof Error ? cause.message : '资源预检失败，请重试') })
      .finally(() => { if (current()) setLoading(false) })
    return () => { generation.current++ }
  }, [adapter, target, revision])
  useEffect(() => {
    if (!report) return
    const delay = Date.parse(report.expiresAt) - Date.now()
    if (delay <= 0) { setExpired(true); return }
    const timer = setTimeout(() => setExpired(true), delay)
    return () => clearTimeout(timer)
  }, [report])
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-3rem)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
      <Dialog.Title className="px-5 pt-5 text-sm font-semibold text-fg">{precompiled ? '确认更新资源' : '确认更新资源与停机清单'}</Dialog.Title>
      <Dialog.Description className="px-5 pt-2 text-xs leading-5 text-fg-muted">{precompiled ? '从 GitHub 下载并校验预编译安装包，准备完成后短暂重启面板。无需服务器编译，不提前停止业务。' : '仅停止本次选定且执行时仍需释放的对象。更新结束会恢复本次停止的业务；Agent 保存中断记录，由你手动继续。'}</Dialog.Description>
      <div className="hover-scrollbar overflow-y-auto px-5 py-4 text-xs leading-5">
        {loading ? <p role="status">正在检查系统资源…</p> : null}
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        {report ? <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-fg-muted">
            <dt>可用内存 / 更新门槛</dt><dd>{resourceSize(report.memory.availableBytes)} / {resourceSize(report.memory.requiredBytes)}</dd>
            <dt>总内存</dt><dd>{resourceSize(report.memory.totalBytes)}</dd>
            <dt>可用 swap / 总量</dt><dd>{resourceSize(report.memory.swapFreeBytes)} / {resourceSize(report.memory.swapTotalBytes)}（不计入内存门槛）</dd>
            <dt>磁盘可用</dt><dd>{resourceSize(report.disk.availableBytes)}</dd>
            <dt>负载（1 / 5 / 15 分钟）</dt><dd>{report.load.map(v => v.toFixed(2)).join(' / ')}</dd>
            <dt>非终态 Agent 运行</dt><dd>{report.activeAgentRuns}</dd>
          </dl>
          <p role="status" className="mt-3 text-fg">{precompiled ? (report.blockedReason ? '当前资源不足，请释放资源后重新检查。' : '资源满足更新门槛，执行前会再次核验。') : report.needsRelease ? '当前内存不足，请确认允许临时停止的对象。执行时会再次测量，达到门槛后停止释放。' : '当前内存充足，无需提前停止业务。执行前会重新核验，未经确认不会扩大停机范围。'}</p>
          {report.blockedReason ? <p role="alert" className="mt-3 text-danger">{report.blockedReason}</p> : null}
          {!precompiled ? <fieldset disabled={!report.needsRelease} className="mt-4 space-y-3"><legend className="mb-2 font-medium text-fg">允许临时停止</legend>
            <label className="flex items-start gap-2"><input type="checkbox" checked={stopPanel} onChange={e => setStopPanel(e.target.checked)} /><span>面板及 Agent 会话<span className="block text-fg-muted">构建期间面板暂时不可访问，服务器上的独立更新进程会继续执行。</span></span></label>
            {report.candidates.map(candidate => <label key={candidate.id} className="flex items-start gap-2"><input type="checkbox" disabled={!!candidate.disabledReason} checked={targets.includes(candidate.id)} onChange={e => setTargets(value => e.target.checked ? [...value, candidate.id] : value.filter(id => id !== candidate.id))} /><span className="min-w-0 break-all">{candidate.kind === 'container' ? '容器' : '服务'}：{candidate.name}<span className="block text-fg-muted">{candidate.memoryBytes === null ? '占用未知' : `当前占用 ${resourceSize(candidate.memoryBytes)}`} · {candidate.id}</span>{candidate.disabledReason ? <span className="block text-warning">{candidate.disabledReason}</span> : null}</span></label>)}
            {report.candidates.length === 0 ? <p className="text-fg-muted">没有其他可选择的停机对象。</p> : null}
          </fieldset> : null}
          {expired ? <p role="alert" className="mt-3 text-warning">资源预检已过期，请重新检查后确认。</p> : null}
        </> : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line p-4">
        <button className={BUTTON} onClick={onClose}>取消</button>
        <button className={BUTTON} disabled={loading} onClick={() => setRevision(v => v + 1)}>重新检查资源</button>
        <button className={BUTTON} disabled={loading || !report || !!report.blockedReason || expired} onClick={() => report && onConfirm({ preflightId: report.id, targets: report.needsRelease ? [...targets] : [], stopPanel: report.needsRelease && stopPanel })}>确认并更新</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

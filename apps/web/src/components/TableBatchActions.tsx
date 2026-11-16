import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { useMessageStore } from '../stores/messageStore'
import { tableBatchFailure, type TableBatchOutcome } from '../utils/tableBatch'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { DataTableActivityContext } from './dataTableActivity'
import { DROPDOWN_OPTION_CLASS, DROPDOWN_SURFACE_CLASS } from './dropdownStyles'

export type { TableBatchOutcome } from '../utils/tableBatch'
type Id = string | number
export interface TableBatchAction<T> {
  key: string
  label: string
  /** Compact icon presentation with the same accessible name and confirmation. */
  icon?: ReactNode
  danger?: boolean
  description?: ReactNode
  /** Returning a reason skips the row. No return value means eligible. */
  eligible?: (row: T) => string | undefined
  groupBy?: (row: T) => string
  execute: (rows: readonly T[]) => Promise<TableBatchOutcome>
}
interface Report { label: string; status: 'succeeded' | 'failed' | 'unknown' | 'skipped' | 'pending'; error?: string }
interface Draft<T> { action: TableBatchAction<T>; jobs: T[][]; skipped: Report[]; generation: number; scope: number; report?: Report[] }

/** Frozen targets, one confirmation, sequential dispatch and a durable result report. */
export function TableBatchActions<T>({ selectedRows, getRowId, getRowLabel, actions, onSucceeded, disabled = false }: {
  selectedRows: readonly T[]
  getRowId: (row: T) => Id
  getRowLabel: (row: T) => string
  actions: readonly TableBatchAction<T>[]
  onSucceeded: (ids: Id[]) => void
  disabled?: boolean
}) {
  const { active, scope } = useContext(DataTableActivityContext)
  const activity = useRef({ active, scope, revision: 0 })
  if (activity.current.active !== active || activity.current.scope !== scope) activity.current = { active, scope, revision: activity.current.revision + 1 }
  const [draft, setDraft] = useState<Draft<T> | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const mounted = useRef(true)
  const callbacks = useRef({ onSucceeded })
  callbacks.current = { onSucceeded }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setDraft(null) }, [active, scope])
  const choose = (action: TableBatchAction<T>) => {
    if (!active || runningRef.current || disabled || !selectedRows.length) return
    const skipped: Report[] = []
    const groups = new Map<string, T[]>()
    selectedRows.forEach((row, index) => {
      const reason = action.eligible?.(row)
      if (reason) { skipped.push({ label: getRowLabel(row), status: 'skipped', error: reason }); return }
      const key = action.groupBy?.(row) ?? String(index)
      groups.set(key, [...(groups.get(key) ?? []), row])
    })
    setDraft({ action, jobs: [...groups.values()], skipped, generation: captureAuthGeneration(), scope: activity.current.revision })
  }
  const execute = async () => {
    if (!draft || runningRef.current || draft.report) return
    runningRef.current = true
    setRunning(true)
    const report: Report[] = [...draft.skipped]
    const succeeded: Id[] = []
    let stopped = false
    for (const rows of draft.jobs) {
      const labels = rows.map(getRowLabel)
      if (stopped || !mounted.current || captureAuthGeneration() !== draft.generation || !activity.current.active || activity.current.revision !== draft.scope) {
        report.push(...labels.map(label => ({ label, status: 'pending' as const, error: '未执行' })))
        stopped = true
        continue
      }
      let outcome: TableBatchOutcome
      try { outcome = await draft.action.execute(rows) } catch (error) { outcome = tableBatchFailure(error) }
      if (captureAuthGeneration() !== draft.generation || !mounted.current) { stopped = true; continue }
      report.push(...labels.map(label => ({ label, ...outcome })))
      if (outcome.status === 'succeeded') succeeded.push(...rows.map(getRowId))
      else stopped = true
      if (activity.current.active && activity.current.revision === draft.scope) setDraft({ ...draft, report: [...report, ...draft.jobs.slice(draft.jobs.indexOf(rows) + 1).flatMap(group => group.map(row => ({ label: getRowLabel(row), status: 'pending' as const })))] })
    }
    runningRef.current = false
    if (!mounted.current) return
    if (captureAuthGeneration() !== draft.generation) { setRunning(false); setDraft(null); return }
    callbacks.current.onSucceeded(succeeded)
    setRunning(false)
    if (activity.current.active && activity.current.revision === draft.scope) setDraft({ ...draft, report })
    const count = (status: Report['status']) => report.filter(row => row.status === status).length
    useMessageStore.getState().notify({ tone: count('failed') || count('unknown') ? 'danger' : 'success', message: `${draft.action.label}：成功 ${count('succeeded')}、失败 ${count('failed')}、结果未确认 ${count('unknown')}、未执行 ${count('pending')}、跳过 ${count('skipped')}` })
  }
  const close = () => { if (!runningRef.current) setDraft(null) }
  const statusLabel = { succeeded: '成功', failed: '失败', unknown: '结果未确认', skipped: '跳过', pending: '未执行' }
  return <>
    <div className="dt-batch-actions">
      {actions.map((action, index) => action.icon ? <IconButton key={action.key}
        label={action.label} variant="ghost" tone={action.danger ? 'danger-hover' : 'neutral'}
        disabled={disabled || running || !selectedRows.length} onPress={() => choose(action)}
        className={`dt-action dt-action-icon ${index !== 0 ? 'dt-batch-wide' : ''}`}>{action.icon}</IconButton> : <Button unstyled type="button" key={action.key}
        disabled={disabled || running || !selectedRows.length} onClick={() => choose(action)}
        className={`dt-action ${index === 0 ? 'dt-action-primary' : 'dt-batch-wide'} ${action.danger && index !== 0 ? 'dt-action-danger' : ''}`}>{action.label}</Button>)}
      {actions.length > 1 && <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild><Button unstyled type="button" className="dt-action dt-batch-more" aria-label="更多批量操作" disabled={disabled || running || !selectedRows.length}>···</Button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className={DROPDOWN_SURFACE_CLASS} sideOffset={6} align="end">
          {actions.slice(1).map(action => <DropdownMenu.Item key={action.key} className={`${DROPDOWN_OPTION_CLASS} ${action.danger ? 'text-danger' : ''}`} onSelect={() => choose(action)}>{action.label}</DropdownMenu.Item>)}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>}
    </div>
    <Dialog.Root open={draft !== null} onOpenChange={open => { if (!open) close() }}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content aria-describedby={undefined} onEscapeKeyDown={event => { if (runningRef.current) event.preventDefault() }} onPointerDownOutside={event => { if (runningRef.current) event.preventDefault() }} className="fixed left-1/2 top-1/2 z-[61] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">{draft?.report ? `${draft.action.label}结果` : `确认${draft?.action.label}？`}</Dialog.Title>
          <div className="mt-2 text-sm text-fg-muted">{draft?.action.description}</div>
          <div className="mt-3 max-h-[45vh] overflow-auto text-sm" aria-live="polite">
            {draft?.report ? <ul className="space-y-2">{draft.report.map((row, index) => <li key={index} className="break-words"><span className="font-medium text-fg">{row.label}</span>：{statusLabel[row.status]}{row.error ? ` · ${row.error}` : ''}</li>)}</ul> : <>
              <p>将处理 {draft?.jobs.reduce((n, group) => n + group.length, 0) ?? 0} 项，跳过 {draft?.skipped.length ?? 0} 项。</p>
              <ul className="mt-2 space-y-1">{draft?.jobs.flatMap(group => group.map(row => <li className="break-all" key={getRowId(row)}>{getRowLabel(row)}</li>))}{draft?.skipped.map((row, index) => <li key={`skip-${index}`} className="break-words text-fg-subtle">{row.label}：跳过 · {row.error}</li>)}</ul>
            </>}
          </div>
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" type="button" onClick={close} disabled={running}>{draft?.report ? '关闭' : '取消'}</Button>
            {!draft?.report && <Button type="button" variant={draft?.action.danger ? 'destructive' : 'primary'} disabled={running || !draft?.jobs.length} onClick={() => void execute()}>确认{draft?.action.label}</Button>}
            {running && <span role="status" className="self-center text-xs text-fg-muted">正在执行…</span>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

import { useId, type ReactNode } from 'react'
import type { ExecutionFieldErrors } from '../../adapters/agentExecutionValidation'
import type { ExecutionSaveResult } from '../../stores/agentExecutionStore'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { RevisionConflictNotice } from './RevisionConflictNotice'

export function ExecutionField({ label, id, error, children }: { label: string; id: string; error?: string; children: ReactNode }) {
  return <div className="min-w-0 space-y-2"><label htmlFor={id} className="block text-xs font-medium">{label}</label>{children}{error && <p id={`${id}-error`} className="text-xs text-danger" role="alert">{error}</p>}</div>
}

export function useExecutionFields(errors: ExecutionFieldErrors) {
  const prefix = useId()
  return (key: string) => ({ id: `${prefix}-${key}`, 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${prefix}-${key}-error` : undefined })
}

export function ExecutionSaveNotice({ result, revision, onRevision, onAcknowledge }: { result?: ExecutionSaveResult; revision: number; onRevision(value: number): void; onAcknowledge(): void }) {
  return <>
    {result?.message && <p role="alert" className="break-words text-xs text-danger">{result.message}</p>}
    {result?.latest && <RevisionConflictNotice latest={result.latest} baseRevision={revision} onAccept={onRevision} />}
    {result?.status === 'unknown' && <button type="button" className={CTL_SECONDARY} onClick={onAcknowledge}>我已核对列表与修订，继续编辑</button>}
  </>
}

export function ExecutionFooter({ form, saving, unknown, onClose }: { form: string; saving: boolean; unknown: boolean; onClose(): void }) {
  return <><button type="button" className={CTL_SECONDARY} disabled={saving} onClick={onClose}>取消</button><button type="submit" form={form} className={CTL_PRIMARY} disabled={saving || unknown}>{saving ? '正在保存…' : '保存'}</button></>
}

import { randomId } from '../../utils/randomId'
import { readAuthorizationPending, saveAuthorizationPending } from './authorizationPending'
import { useEffect, useRef, useState } from 'react'
import type { AgentAccessDecisionInput, AgentApproval } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../contracts/agentChat'
import { Check, ShieldAlert, Square, X } from '../../components/icons'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useMessageStore } from '../../stores/messageStore'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { RuntimeAccessCard } from './RuntimeAccessCard'

const BUTTON = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-control-line px-3 text-xs hover:bg-surface-hover disabled:opacity-50'

export function ChatApprovals({ api, runId, onChanged, onCancel }: { api?: AgentChatGovernance; runId: string; onChanged(): void; onCancel(): void }) {
  const [approvals, setApprovals] = useState<readonly AgentApproval[]>([])
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Record<string, AgentAccessDecisionInput>>(() => readAuthorizationPending(runId))
  useEffect(() => saveAuthorizationPending(runId, pending), [runId, pending])
  const lifetime = useRef(0)
  useEffect(() => { lifetime.current += 1; return () => { lifetime.current += 1 } }, [api, runId])
  useFeedbackMessage(error)
  useEffect(() => {
    setApprovals([]); setError(null); setLoading(true)
    if (!api) { setLoading(false); return }
    return subscribeWhileVisible(() => {
      const controller = new AbortController(), auth = captureAuthGeneration()
      let timer: ReturnType<typeof setTimeout>
      const read = async () => {
        try { const rows = await api.approvals(runId, controller.signal); if (!controller.signal.aborted && auth === captureAuthGeneration()) { setApprovals(rows.filter(a => a.kind !== 'workflow-gate' && (a.status === 'pending' || a.status === 'approved'))); setPending(previous => Object.fromEntries(Object.entries(previous).filter(([id, input]) => rows.some(row => row.id === id && row.status === 'pending' && row.kind !== 'workflow-gate' && row.access?.revision === input.expectedRevision && row.access.digest === input.expectedDigest)))); setError(null) } }
        catch (cause) { if (!controller.signal.aborted && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '读取审批失败') }
        finally { if (!controller.signal.aborted && auth === captureAuthGeneration()) { setLoading(false); timer = setTimeout(() => void read(), 2000) } }
      }
      void read()
      return () => { controller.abort(); clearTimeout(timer) }
    })
  }, [api, runId, attempt])
  const decide = async (id: string, decision: 'approved' | 'denied') => {
    if (!api || acting) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    setActing(true); setError(null)
    try {
      const result = await api.decide(id, decision)
      if (owner !== lifetime.current || auth !== captureAuthGeneration()) return
      setApprovals(items => items.map(item => item.id === id ? result : item))
      useMessageStore.getState().notify({ tone: 'success', message: result.status === 'approved' ? '操作已批准，等待执行。' : '操作已拒绝。' })
      onChanged()
    }
    catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '审批结果未确认，请重新读取') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) { setActing(false); setAttempt(value => value + 1) } }
  }
  const decideAccess = async (approval: AgentApproval, decision: AgentAccessDecisionInput['decision']) => {
    if (!api || acting || approval.kind === 'workflow-gate' || !approval.access) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    const input = pending[approval.id] ?? { requestId: randomId(), expectedRevision: approval.access.revision, expectedDigest: approval.access.digest, decision }
    setPending(previous => ({ ...previous, [approval.id]: input })); setActing(true); setError(null)
    try {
      const receipt = await api.decideAccess(approval.id, input)
      if (owner !== lifetime.current || auth !== captureAuthGeneration()) return
      setApprovals(rows => rows.map(row => row.id === approval.id ? receipt : row))
      setPending(previous => { const next = { ...previous }; delete next[approval.id]; return next })
      onChanged()
    } catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '确认结果未知，请重新读取') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) { setActing(false); setAttempt(value => value + 1) } }
  }
  return <section aria-label="待审批操作" className="mb-3 max-h-[50dvh] overflow-y-auto border-y border-line py-3 text-xs">
    <div className="mb-2 flex items-center gap-2 font-medium"><ShieldAlert size={15} aria-hidden />待审批操作</div>
    {loading && <p role="status" className="text-fg-muted">正在读取审批…</p>}
    {error && <button className="mb-2 underline" disabled={acting} onClick={() => setAttempt(value => value + 1)}>重新读取审批</button>}
    {!loading && !error && !approvals.length && <p className="text-fg-muted">暂无待审批操作。</p>}
    {approvals.map(approval => {
      if (approval.kind === 'workflow-gate') return null
      const operation = approval.operation
      const grant = operation.execution?.grant
      if (approval.access) return <RuntimeAccessCard key={approval.id} title={operation.capability.source === 'mcp' ? operation.capability.originalName ?? operation.capability.name : operation.capability.name} access={approval.access} operation={operation}
        busy={acting || loading || !!error} confirmed={approval.status === 'approved'} pending={pending[approval.id]} onDecision={decision => void decideAccess(approval, decision)} onCancel={onCancel} />
      return <div key={approval.id} className="border-b border-line py-2 last:border-0">
        <div className="break-all font-medium">{operation.capability.name}</div>
        <pre aria-label="完整操作参数" className="hover-scrollbar my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised p-2 font-mono text-xs">{operation.argumentsJson}</pre>
        {operation.fileChanges?.map(change => <div key={change.path} aria-label={`文件变更 ${change.path}`} className="my-2 min-w-0 border-y border-line py-2">
          <code className="block break-all font-medium">{change.path}</code>
          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">{(['before', 'after'] as const).map(side => {
            const content = change[side]
            return <div key={side} className="min-w-0"><p className="mb-1 text-fg-muted">{side === 'before' ? '修改前' : '修改后'}</p>{!content ? <p className="text-fg-muted">不存在</p> : <>
              <p className="break-all font-mono text-fg-muted">{content.bytes !== undefined && `${content.bytes} B · `}{content.digest}</p>
              {content.text === undefined ? <p className="mt-1 text-fg-muted">{content.bytes === undefined ? '未保存对应版本的读取回执，按摘要核对。' : '较大或非文本文件，按摘要核对。'}</p> : <pre className="hover-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-surface-raised p-2 font-mono">{content.text || '空文件'}</pre>}
            </>}</div>
          })}</div>
        </div>)}
        {!!operation.resourceClaims?.length && <ul aria-label="操作目标" className="mb-2 space-y-1 font-mono">{operation.resourceClaims.map((claim, index) => <li key={index} className="break-all">{claim.kind} / {claim.authority} / {claim.key} · {claim.access}{claim.subtree && ' · 含子项'}</li>)}</ul>}
        <p className="text-fg-muted">任务工作区 v{operation.workspaceRevision}</p>
        {operation.execution && <code className="mt-1 block break-all text-fg-muted">{operation.execution.profile.image}</code>}
        {grant?.directories.map((directory, index) => <code key={directory.path} className="mt-1 block break-all">{directory.path} → /grants/{index} · {directory.access}</code>)}
        {grant?.network.map(endpoint => <code key={`${endpoint.host}:${endpoint.port}`} className="mt-1 block break-all">{endpoint.scheme}://{endpoint.host}:{endpoint.port}</code>)}
        {(!operation.capability.readOnly && (operation.capability.source === 'builtin' || grant?.directories.some(d => d.access === 'rw'))) && <p className="mt-2 text-danger">可能产生不可回滚的外部修改或删除。</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button className={BUTTON} disabled={acting || approval.status !== 'pending'} onClick={() => void decide(approval.id, 'approved')}><Check size={14} aria-hidden />{approval.status === 'approved' ? '已批准，等待执行' : '批准'}</button><button className={`${BUTTON} text-danger`} disabled={acting || approval.status !== 'pending'} onClick={() => void decide(approval.id, 'denied')}><X size={14} aria-hidden />拒绝</button><button className={BUTTON} disabled={acting} onClick={onCancel}><Square size={12} aria-hidden />取消本轮</button></div>
      </div>
    })}
  </section>
}

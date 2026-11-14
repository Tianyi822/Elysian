import { useId, useState } from 'react'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'

export function ChatRecovery({ timeline, api }: { timeline: AgentChatTimelineSnapshot; api: AgentConversationAdapter }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [evidence, setEvidence] = useState('')
  const [decision, setDecision] = useState<'confirmed-completed' | 'confirmed-stopped' | ''>('')
  const fieldId = useId()
  const recovery = timeline.recovery
  const unknown = recovery?.status !== 'recovered' && !timeline.continuation?.allowed && timeline.entries.some(entry => entry.kind === 'tool' && entry.status === 'unknown')
  if (!recovery && !unknown) return null
  const verify = async () => {
    if (!api.verifyRecovery || busy) return
    setBusy(true); setError('')
    try { await api.verifyRecovery(timeline.runId); await useAgentChatStore.getState().refresh(api) }
    catch (e) { setError(e instanceof Error ? e.message : '核实暂不可用，操作保护保留。') }
    finally { setBusy(false) }
  }
  return <div className="chat-recovery text-sm text-fg-muted" aria-label="操作恢复">
    {recovery && <p role="status">{recovery.status === 'correcting' ? '正在修正' : recovery.status === 'verifying' ? '正在核实' : recovery.status === 'recovered' ? '恢复完成' : recovery.status === 'exhausted' ? '本轮修正已结束' : '核实尚未完成'} · {recovery.tool}：{recovery.message}</p>}
    {unknown && <>
      {!recovery && <p>操作结果尚未确认，需要核实任务回执和实际状态。</p>}
      {api.verifyRecovery && <button type="button" className="chat-recovery-action" disabled={busy} onClick={() => void verify()}>{busy ? '正在核实实际状态…' : '核实实际状态'}</button>}
      {timeline.done && api.reconcileRecovery && <details className="mt-2">
        <summary>登记人工核实结论</summary>
        <form className="mt-2 grid gap-2" onSubmit={event => {
          event.preventDefault()
          if (!decision || !evidence.trim() || busy) return
          setBusy(true); setError('')
          void api.reconcileRecovery!(timeline.runId, evidence.trim(), decision).then(() => useAgentChatStore.getState().refresh(api))
            .catch(e => setError(e instanceof Error ? e.message : '核实结论保存失败，操作保护保留。')).finally(() => setBusy(false))
        }}>
          <p>请先在服务器核实操作已结束、资源身份和真实变更。结论通过服务端核对后，将解除对应操作的阻塞。</p>
          <label htmlFor={`${fieldId}-decision`}>已核实的结果</label>
          <select id={`${fieldId}-decision`} className="chat-recovery-input" value={decision} onChange={event => setDecision(event.target.value as typeof decision)} required>
            <option value="">选择核实结果</option><option value="confirmed-completed">已确认操作完成</option><option value="confirmed-stopped">已确认操作停止</option>
          </select>
          <label htmlFor={fieldId}>核实证据</label>
          <textarea id={fieldId} className="chat-recovery-input" value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={8192} required rows={3} />
          <button type="submit" className="chat-recovery-action" disabled={busy || !decision || !evidence.trim()}>保存核实结论并解除阻塞</button>
        </form>
      </details>}
    </>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>
}

import { useEffect, useId, useRef, useState } from 'react'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { Button } from '../../components/Button'

type Props = { timeline: AgentChatTimelineSnapshot; api: AgentConversationAdapter }

export function ChatRecovery(props: Props) {
  const sessionId = useAgentChatStore(state => state.session?.id)
  // 换轮次或会话时丢弃旧恢复草稿及反馈，迟到回执也不能刷新新会话。
  return <RecoveryActions key={`${sessionId ?? ''}:${props.timeline.runId}`} {...props} sessionId={sessionId} />
}

function RecoveryActions({ timeline, api, sessionId }: Props & { sessionId?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [evidence, setEvidence] = useState('')
  const [decision, setDecision] = useState<'confirmed-completed' | 'confirmed-stopped' | ''>('')
  const acting = useRef(false)
  const lifetime = useRef(0)
  useEffect(() => {
    lifetime.current += 1
    acting.current = false
    setBusy(false); setError('')
    return () => { lifetime.current += 1 }
  }, [api])
  const fieldId = useId()
  const recovery = timeline.recovery
  const wait = timeline.done ? undefined : timeline.wait
  const unknown = recovery?.status !== 'recovered' && !timeline.continuation?.allowed && timeline.entries.some(entry => entry.kind === 'tool' && entry.status === 'unknown')
  // resourceWait 是历史执行事实；只用服务端投影的当前屏障决定恢复入口。
  // 核实接口以 Run 为单位，合并入口但保留每个操作的事实；有不支持的操作时不提供无效动作。
  const blockers = [...new Set((timeline.blockingRecovery ?? []).map(blocker => blocker.runId))]
    .filter(runId => runId !== timeline.runId)
    .map(runId => {
      const operations = timeline.blockingRecovery!.filter(blocker => blocker.runId === runId)
      return { runId, operations, verifiable: operations.every(operation => operation.verifiable) }
    })
  if (!wait && !recovery && !unknown && !blockers.length) return null

  const act = async (operation: () => Promise<void>, failure: string, sourceRunId = timeline.runId) => {
    if (acting.current) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    const valid = () => owner === lifetime.current && auth === captureAuthGeneration() && useAgentChatStore.getState().session?.id === sessionId
    acting.current = true
    setBusy(true); setError('')
    try {
      await operation()
      if (valid()) await useAgentChatStore.getState().refresh(api, undefined, [...new Set([timeline.runId, sourceRunId])])
    } catch (cause) {
      if (valid()) setError(cause instanceof Error ? cause.message : failure)
    } finally {
      if (valid()) { acting.current = false; setBusy(false) }
    }
  }
  const verify = (runId: string) => {
    if (api.verifyRecovery) void act(() => api.verifyRecovery!(runId), '核实暂不可用，操作保护保留。', runId)
  }
  return <div className="chat-recovery break-words text-sm text-fg-muted" aria-label="操作恢复">
    {wait && <div role="status"><p>{wait.kind === 'waiting-model' ? '模型通道暂时不可用' : '记录同步暂时不可用'}，任务进度已保存。</p><p>{wait.reason?.message}</p><p>将在 {new Date(wait.nextAt).toLocaleTimeString('zh-CN')} 自动检查并继续，无需点击继续任务。等待期间不重复执行已提交操作。</p></div>}
    {recovery && <p role="status">{recovery.status === 'correcting' ? '正在修正' : recovery.status === 'verifying' ? '正在核实' : recovery.status === 'recovered' ? '恢复完成' : recovery.status === 'exhausted' ? '本轮修正已结束' : '核实尚未完成'} · {recovery.tool}：{recovery.message}</p>}
    {!!blockers.length && <div className="space-y-2">
      <p>此前操作的结果尚未确认，本次操作未执行。请先核实阻塞来源，再继续任务。</p>
      {blockers.map(blocker => <div key={blocker.runId} className="space-y-1">
        {blocker.operations.map(operation => <p key={operation.leaseId ?? operation.operationId}>{operation.tool || '此前操作'}：{operation.message}</p>)}
        {blockers.length > 1 && blocker.runId && <p className="break-all text-xs">来源运行：{blocker.runId}</p>}
        {blocker.verifiable && api.verifyRecovery && <Button variant="outline" type="button" className="chat-recovery-action" disabled={busy}
          aria-label={blockers.length > 1 ? `核实此前操作 ${blocker.runId}` : undefined}
          onClick={() => verify(blocker.runId)}>{busy ? '正在核实实际状态…' : '核实此前操作'}</Button>}
        {!blocker.verifiable && <p>{blocker.runId ? '此操作暂不支持自动核实，请在原会话查看核实要求。' : '请在对应设置中核实独立资源操作。'}</p>}
      </div>)}
    </div>}
    {unknown && <>
      {!recovery && <p>操作结果尚未确认，需要核实任务回执和实际状态。</p>}
      {api.verifyRecovery && <Button variant="outline" type="button" className="chat-recovery-action" disabled={busy} onClick={() => verify(timeline.runId)}>{busy ? '正在核实实际状态…' : '核实实际状态'}</Button>}
      {timeline.done && api.reconcileRecovery && <details className="mt-2">
        <summary>登记人工核实结论</summary>
        <form className="mt-2 grid gap-2" onSubmit={event => {
          event.preventDefault()
          if (!decision || !evidence.trim() || !api.reconcileRecovery) return
          void act(() => api.reconcileRecovery!(timeline.runId, evidence.trim(), decision), '核实结论保存失败，操作保护保留。')
        }}>
          <p>请先在服务器核实操作已结束、资源身份和真实变更。结论通过服务端核对后，将解除对应操作的阻塞。</p>
          <label htmlFor={`${fieldId}-decision`}>已核实的结果</label>
          <select id={`${fieldId}-decision`} className="chat-recovery-input" value={decision} onChange={event => setDecision(event.target.value as typeof decision)} required disabled={busy}>
            <option value="">选择核实结果</option><option value="confirmed-completed">已确认操作完成</option><option value="confirmed-stopped">已确认操作停止</option>
          </select>
          <label htmlFor={fieldId}>核实证据</label>
          <textarea id={fieldId} className="chat-recovery-input" value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={8192} required rows={3} disabled={busy} />
          <Button variant="primary" type="submit" className="chat-recovery-action" disabled={busy || !decision || !evidence.trim()}>保存核实结论并解除阻塞</Button>
        </form>
      </details>}
    </>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>
}

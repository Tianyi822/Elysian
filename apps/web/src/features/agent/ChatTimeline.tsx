import { useEffect, useId, useLayoutEffect, useState } from 'react'
import { RUNTIME_RUN_STATUS_LABELS, type AgentChatTimelineEntry, type AgentChatTimelineSnapshot, type AgentChatToolStatus, type AgentMessage, type RuntimeCall } from '@elysian/contracts'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { Check, ChevronRight, Loader2, Terminal, X } from '../../components/icons'
import { RefreshButton } from '../../components/RefreshState'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatMarkdown } from '../../components/ChatMarkdown'
import { ChatMessageCopy } from './ChatMessageCopy'
import { ChatReasoning } from './ChatReasoning'
import { useSmoothedText } from './useSmoothedText'
import { ChatPlan } from './ChatPlan'
import { ChatUserInputSummary } from './ChatUserInput'
import { ChatRuntimeResult } from './ChatRuntimeResult'
import { ChatToolProgress } from './ChatToolProgress'
import { ChatRecovery } from './ChatRecovery'
import { Button } from '../../components/Button'
import { messageOf } from '../../utils/errorMessage'

type ToolEntry = Extract<AgentChatTimelineEntry, { kind: 'tool' }>
const toolLabels: Record<AgentChatToolStatus, string> = {
  planned: '等待执行', 'waiting-input': '等待回答', 'waiting-approval': '等待批准', 'waiting-resource': '等待资源', 'waiting-task': '执行中', running: '执行中',
  succeeded: '成功', failed: '失败', cancelled: '已取消', unknown: '结果未确认', denied: '已拒绝', expired: '审批已过期', revoked: '审批已撤销', 'not-executed': '未执行',
}
const pending = (status: AgentChatToolStatus) => ['planned', 'waiting-approval', 'waiting-resource', 'waiting-task', 'running'].includes(status)
const failed = (status: AgentChatToolStatus) => ['failed', 'denied', 'expired', 'revoked'].includes(status)
const showsProgress = (entry: ToolEntry) => entry.status === 'waiting-task' || !!entry.progress && (entry.status === 'running' || entry.status === 'unknown')
const toolStatus = (entry: ToolEntry) => showsProgress(entry) && entry.progress?.state === 'unknown' ? 'unknown' : entry.status

function ChatTool({ entry, runId, api, onProgress, collapsed }: {
  entry: ToolEntry; runId: string; api: AgentConversationAdapter; onProgress(): void; collapsed: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [focused, setFocused] = useState(false)
  const [result, setResult] = useState<RuntimeCall | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const regionId = useId()
  const report = useAgentChatStore(state => state.reportOperation)
  const hidden = collapsed && !focused
  useEffect(() => {
    if (hidden || !expanded || !entry.callId) return
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setResult(null)
    void api.calls(runId, controller.signal).then(calls => {
      if (controller.signal.aborted) return
      const call = calls.find(call => call.id === entry.callId && call.modelRequestId === entry.modelRequestId && call.modelCallId === entry.modelCallId)
      if (!call) throw new Error('工具调用记录尚不可用，请重试。')
      setResult(call)
    }).catch(error => {
      if (!controller.signal.aborted) {
        setError(true)
        report(messageOf(error, '工具详情读取失败，请重试。'))
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, runId, expanded, hidden, entry.callId, entry.modelRequestId, entry.modelCallId, entry.status, entry.endedAt, retry, report])
  useLayoutEffect(onProgress, [expanded, hidden, result, loading, error, entry.progress, onProgress])
  const status = toolStatus(entry)
  const evidence = result?.evidence ?? (result?.error ?? entry.error)?.evidence
  const Icon = status === 'succeeded' ? Check : failed(status) ? X : pending(status) ? Loader2 : Terminal
  return <div className="chat-tool" data-status={status} hidden={hidden}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <Button unstyled type="button" className="chat-tool-toggle" aria-expanded={expanded} aria-controls={regionId}
      aria-label={`${expanded ? '收起' : '展开'}工具 ${entry.tool} 详情`} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={14} aria-hidden className={expanded ? 'rotate-90' : undefined} />
      <Icon size={14} aria-hidden className={`chat-tool-status-icon${status === 'running' || status === 'waiting-task' ? ' animate-spin motion-reduce:animate-none' : ''}`} />
      <span className="chat-tool-name">{entry.tool}</span><span className="chat-tool-status">{toolLabels[status]}</span>
    </Button>
    {entry.resourceWait && <div className="text-xs text-fg-muted" role="status">
      <p>{entry.resourceWait.message} · 已等待 {entry.resourceWait.elapsedSeconds} 秒</p>
      <p>{entry.resourceWait.resource}{entry.resourceWait.runId && ` · 运行 ${entry.resourceWait.runId}`}{entry.resourceWait.operationId && ` · 操作 ${entry.resourceWait.operationId}`}</p>
    </div>}
    {showsProgress(entry) && <ChatToolProgress tool={entry.tool} progress={entry.progress} unknown={status === 'unknown'} />}
    {expanded && <div id={regionId} role="region" aria-label={`${entry.tool} 详情`} className="chat-tool-details">
      <p className="text-xs text-fg-muted">参数</p>
      <pre className="chat-tool-data hover-scrollbar" tabIndex={0}>{entry.argumentsJson}</pre>
      {loading && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" role="status" aria-label="读取工具结果" />}
      {error && <RefreshButton label="重试读取工具详情" onPress={() => setRetry(value => value + 1)} busy={loading} />}
      {result?.result !== undefined && <><p className="text-xs text-fg-muted">结果</p><pre className="chat-tool-data hover-scrollbar" tabIndex={0}>{typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)}</pre></>}
      {(entry.truncated || result?.truncated) && <p className="text-xs text-fg-muted">结果已截断</p>}
      {(result?.error ?? entry.error) && <p className="text-xs text-danger">{(result?.error ?? entry.error)?.message}</p>}
      {evidence?.execution === 'not-started' && <p className="text-xs text-fg-muted">业务变更未执行</p>}
      {evidence?.suggestion && <p className="text-xs text-fg-muted">{evidence?.suggestion}</p>}
      {!!entry.attempts?.length && <><p className="text-xs text-fg-muted">尝试记录</p><ol className="text-xs text-fg-muted">{entry.attempts.map(attempt => <li key={attempt.number}>第 {attempt.number} 次：{attempt.error?.message ?? '已结束'}</li>)}</ol></>}
    </div>}
  </div>
}

function ChatToolGroup({ entries, runId, api, onProgress }: {
  entries: readonly ToolEntry[]; runId: string; api: AgentConversationAdapter; onProgress(): void
}) {
  const [expanded, setExpanded] = useState(false)
  const regionId = useId()
  const grouped = entries.length > 1
  const successes = entries.filter(entry => toolStatus(entry) === 'succeeded').length
  return <div className="chat-tool-group" data-grouped={grouped || undefined}>
    {grouped && <Button unstyled type="button" className="chat-tool-group-toggle"
      aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={14} aria-hidden className={expanded ? 'rotate-90' : undefined} />
      <span>工具调用（{entries.length}）</span>
      {successes > 0 && <span className="chat-tool-count">成功 {successes}</span>}
    </Button>}
    <div id={regionId} className="chat-tool-group-entries">
      {entries.map(entry => <ChatTool key={entry.id} entry={entry} runId={runId} api={api} onProgress={onProgress}
        collapsed={grouped && !expanded && toolStatus(entry) === 'succeeded'} />)}
    </div>
  </div>
}

function groupTimelineEntries(entries: readonly AgentChatTimelineEntry[]) {
  const groups: (Exclude<AgentChatTimelineEntry, ToolEntry> | ToolEntry[])[] = []
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      if (entry.tool === 'update_plan' && entry.status !== 'failed') continue
      const previous = groups.at(-1)
      if (Array.isArray(previous)) previous.push(entry)
      else groups.push([entry])
    } else {
      groups.push(entry)
    }
  }
  return groups
}

function ChatTextSegment({ entry, text, active, thinking, copyable, quarantined, showIncomplete, onProgress }: {
  entry: Extract<AgentChatTimelineEntry, { kind: 'reasoning' | 'content' }>; text: string; active: boolean; thinking: boolean; copyable: boolean; quarantined?: boolean; showIncomplete: boolean; onProgress(): void
}) {
  const shown = useSmoothedText(text, active && entry.status === 'running')
  useLayoutEffect(onProgress, [shown, onProgress])
  return <div className="chat-response" data-streaming={active && entry.status === 'running' || undefined}>
    {entry.kind === 'reasoning' ? <ChatReasoning text={shown} active={active && entry.status === 'running'} thinking={thinking} /> : !!shown && <article className={`chat-message chat-message-assistant${copyable ? '' : ' chat-message-intermediate'}`} aria-label="助手回复">
      <div className="chat-message-body"><ChatMarkdown text={shown} />
        {quarantined && <p className="mt-2 text-xs text-danger">此回复包含未核实或已撤回的资料。</p>}
      </div>
      {copyable && <ChatMessageCopy value={text} noun="回复内容" />}
    </article>}
    {showIncomplete && <p role="status" className="text-xs text-fg-muted">未完成{entry.status !== 'succeeded' && ` · ${RUNTIME_RUN_STATUS_LABELS[entry.status]}`}</p>}
  </div>
}

export function ChatTimeline({ timeline, answer, active, stopped, stopping, api, onProgress, showPlan = true }: {
  timeline: AgentChatTimelineSnapshot; showPlan?: boolean; answer?: AgentMessage; active: boolean; stopped: boolean; stopping?: boolean; api: AgentConversationAdapter; onProgress(): void
}) {
  const hasFinal = timeline.entries.some(entry => entry.kind === 'content' && entry.modelRequestId === timeline.finalResponseId)
  const result = timeline.done && timeline.terminalResult && (!stopped || timeline.terminalResult.report) ? timeline.terminalResult.content : !stopped && answer?.origin === 'runtime' ? answer.content : undefined
  const modelAnswer = answer?.origin === 'runtime' || result ? undefined : answer
  const groups = groupTimelineEntries(timeline.entries)
  const current = groups.at(-1)
  useLayoutEffect(onProgress, [timeline.done, result, onProgress])
  return <div className="chat-timeline" aria-label="回复过程">
    {groups.map(entry => {
      if (Array.isArray(entry)) return <ChatToolGroup key={entry[0]!.id} entries={entry} runId={timeline.runId} api={api} onProgress={onProgress} />
      if (entry.kind === 'user-input') return <ChatUserInputSummary key={entry.id} request={entry.userInput} />
      const final = entry.kind === 'content' && entry.modelRequestId === timeline.finalResponseId && modelAnswer
      const hasBody = timeline.entries.some(item => item.kind === 'content' && item.modelRequestId === entry.modelRequestId)
      return <ChatTextSegment key={entry.id} entry={entry} text={final ? modelAnswer.content : entry.text} active={active && !stopping} copyable={!!final}
        thinking={active && !stopped && !stopping && entry === current && entry.kind === 'reasoning' && entry.status === 'running'}
        quarantined={final ? modelAnswer.quarantined : undefined} showIncomplete={entry.incomplete && !stopped && (entry.kind === 'content' || !hasBody)} onProgress={onProgress} />
    })}
    {modelAnswer && !hasFinal && timeline.done && <article className="chat-message chat-message-assistant" aria-label="助手回复">
      <div className="chat-message-body"><ChatMarkdown text={modelAnswer.content} />
        {modelAnswer.quarantined && <p className="mt-2 text-xs text-danger">此回复包含未核实或已撤回的资料。</p>}
      </div><ChatMessageCopy value={modelAnswer.content} noun="回复内容" />
    </article>}
    {!result && timeline.done && (timeline.status === 'failed' || timeline.status === 'interrupted') && !!timeline.error?.message &&
      <p role="status" className={`text-xs ${timeline.status === 'failed' ? 'text-danger' : 'text-fg-muted'}`}>运行未完成：{timeline.error.message}</p>}
    {stopped && <p role="status" className="text-xs text-fg-muted">已停止</p>}
    {showPlan && <ChatPlan budgetStopped={!!timeline.budgetStop} plan={timeline.plan} status={timeline.status} stopping={stopping} onProgress={onProgress} />}
    {result && <ChatRuntimeResult content={result} />}
    <ChatRecovery timeline={timeline} api={api} />
    {timeline.status === 'recovery-required' && timeline.error?.code === 'continuous-policy-frozen' && <p role="status" className="text-sm text-fg-muted">{timeline.error.message}</p>}
  </div>
}

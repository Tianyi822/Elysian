import { useEffect, useId, useLayoutEffect, useState } from 'react'
import { RUNTIME_RUN_STATUS_LABELS, type AgentChatTimelineEntry, type AgentChatTimelineSnapshot, type AgentChatToolStatus, type AgentMessage, type RuntimeCall } from '@elysian/contracts'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { Check, ChevronRight, Loader2, RefreshCw, Terminal, X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatMessageCopy } from './ChatMessageCopy'
import { ChatReasoning } from './ChatReasoning'
import { useSmoothedText } from './useSmoothedText'

type ToolEntry = Extract<AgentChatTimelineEntry, { kind: 'tool' }>
const toolLabels: Record<AgentChatToolStatus, string> = {
  planned: '等待执行', 'waiting-approval': '等待批准', 'waiting-resource': '等待资源', 'waiting-task': '执行中', running: '执行中',
  succeeded: '成功', failed: '失败', cancelled: '已取消', unknown: '结果未确认', denied: '已拒绝', expired: '审批已过期', revoked: '审批已撤销', 'not-executed': '未执行',
}
const pending = (status: AgentChatToolStatus) => ['planned', 'waiting-approval', 'waiting-resource', 'waiting-task', 'running'].includes(status)
const failed = (status: AgentChatToolStatus) => ['failed', 'denied', 'expired', 'revoked'].includes(status)
function ChatTool({ entry, runId, api, onProgress }: { entry: ToolEntry; runId: string; api: AgentConversationAdapter; onProgress(): void }) {
  const [expanded, setExpanded] = useState(false)
  const [result, setResult] = useState<RuntimeCall | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const regionId = useId()
  const report = useAgentChatStore(state => state.reportOperation)
  useEffect(() => {
    if (!expanded || !entry.callId) return
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
        report(error instanceof Error ? error.message : '工具详情读取失败，请重试。')
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, runId, expanded, entry.callId, entry.modelRequestId, entry.modelCallId, entry.status, entry.endedAt, retry, report])
  useLayoutEffect(onProgress, [expanded, result, loading, error, onProgress])
  const Icon = entry.status === 'succeeded' ? Check : failed(entry.status) ? X : pending(entry.status) ? Loader2 : Terminal
  return <div className="chat-tool" data-status={entry.status}>
    <button type="button" className="chat-tool-toggle" aria-expanded={expanded} aria-controls={regionId}
      aria-label={`${expanded ? '收起' : '展开'}工具 ${entry.tool} 详情`} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={14} aria-hidden className={expanded ? 'rotate-90' : undefined} />
      <Icon size={14} aria-hidden className={`chat-tool-status-icon${entry.status === 'running' || entry.status === 'waiting-task' ? ' animate-spin motion-reduce:animate-none' : ''}`} />
      <span className="chat-tool-name">{entry.tool}</span><span className="chat-tool-status">{toolLabels[entry.status]}</span>
    </button>
    {expanded && <div id={regionId} role="region" aria-label={`${entry.tool} 详情`} className="chat-tool-details">
      <p className="text-xs text-fg-muted">参数</p>
      <pre className="chat-tool-data hover-scrollbar" tabIndex={0}>{entry.argumentsJson}</pre>
      {loading && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" role="status" aria-label="读取工具结果" />}
      {error && <IconButton label="重试读取工具详情" onPress={() => setRetry(value => value + 1)}><RefreshCw size={14} aria-hidden /></IconButton>}
      {result?.result !== undefined && <><p className="text-xs text-fg-muted">结果</p><pre className="chat-tool-data hover-scrollbar" tabIndex={0}>{typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)}</pre></>}
      {(entry.truncated || result?.truncated) && <p className="text-xs text-fg-muted">结果已截断</p>}
      {(result?.error ?? entry.error) && <p className="text-xs text-danger">{(result?.error ?? entry.error)?.message}</p>}
    </div>}
  </div>
}

function ChatTextSegment({ entry, text, active, copyable, quarantined, showIncomplete, onProgress }: {
  entry: Exclude<AgentChatTimelineEntry, { kind: 'tool' }>; text: string; active: boolean; copyable: boolean; quarantined?: boolean; showIncomplete: boolean; onProgress(): void
}) {
  const shown = useSmoothedText(text, active && entry.status === 'running')
  useLayoutEffect(onProgress, [shown, onProgress])
  return <div className="chat-response" data-streaming={active && entry.status === 'running' || undefined}>
    {entry.kind === 'reasoning' ? <ChatReasoning text={shown} active={active && entry.status === 'running'} /> : !!shown && <article className={`chat-message chat-message-assistant${copyable ? '' : ' chat-message-intermediate'}`} aria-label="助手回复">
      <div className="chat-message-body"><ChatMarkdown text={shown} />
        {quarantined && <p className="mt-2 text-xs text-danger">此回复包含未核实或已撤回的资料。</p>}
      </div>
      {copyable && <ChatMessageCopy value={text} noun="回复内容" />}
    </article>}
    {showIncomplete && <p role="status" className="text-xs text-fg-muted">未完成{entry.status !== 'succeeded' && ` · ${RUNTIME_RUN_STATUS_LABELS[entry.status]}`}</p>}
  </div>
}

export function ChatTimeline({ timeline, answer, active, stopped, stopping, api, onProgress }: {
  timeline: AgentChatTimelineSnapshot; answer?: AgentMessage; active: boolean; stopped: boolean; stopping?: boolean; api: AgentConversationAdapter; onProgress(): void
}) {
  const hasFinal = timeline.entries.some(entry => entry.kind === 'content' && entry.modelRequestId === timeline.finalResponseId)
  useLayoutEffect(onProgress, [timeline.done, onProgress])
  return <div className="chat-timeline" aria-label="回复过程">
    {timeline.entries.map(entry => {
      if (entry.kind === 'tool') return <ChatTool key={entry.id} entry={entry} runId={timeline.runId} api={api} onProgress={onProgress} />
      const final = entry.kind === 'content' && entry.modelRequestId === timeline.finalResponseId && answer
      const hasBody = timeline.entries.some(item => item.kind === 'content' && item.modelRequestId === entry.modelRequestId)
      return <ChatTextSegment key={entry.id} entry={entry} text={final ? answer.content : entry.text} active={active && !stopping} copyable={!!final}
        quarantined={final ? answer.quarantined : undefined} showIncomplete={entry.incomplete && !stopped && (entry.kind === 'content' || !hasBody)} onProgress={onProgress} />
    })}
    {answer && !hasFinal && timeline.done && <article className="chat-message chat-message-assistant" aria-label="助手回复">
      <div className="chat-message-body"><ChatMarkdown text={answer.content} />
        {answer.quarantined && <p className="mt-2 text-xs text-danger">此回复包含未核实或已撤回的资料。</p>}
      </div><ChatMessageCopy value={answer.content} noun="回复内容" />
    </article>}
    {timeline.done && (timeline.status === 'failed' || timeline.status === 'interrupted') && !!timeline.error?.message &&
      <p role="status" className={`text-xs ${timeline.status === 'failed' ? 'text-danger' : 'text-fg-muted'}`}>运行未完成：{timeline.error.message}</p>}
    {stopped && <p role="status" className="text-xs text-fg-muted">已停止</p>}
  </div>
}

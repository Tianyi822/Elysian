import { useLayoutEffect, useRef } from 'react'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatMessageCopy } from './ChatMessageCopy'
import { ChatReasoning } from './ChatReasoning'
import { useSmoothedText } from './useSmoothedText'

/** 同一轮的思考与答复共享容器，流式预览原位衔接服务端确认消息。 */
export function ChatResponse({ content, reasoning, active, stopped, stopping, quarantined, onProgress }: {
  content: string
  reasoning: string
  active: boolean
  stopped?: boolean
  stopping?: boolean
  quarantined?: boolean
  onProgress(): void
}) {
  const animate = useRef(active)
  if (active) animate.current = true
  const answer = useSmoothedText(content, animate.current && !stopped && !stopping)
  const thought = useSmoothedText(reasoning, animate.current && !stopped && !stopping)
  const waiting = active && !answer && !thought && !stopped && !stopping
  useLayoutEffect(onProgress, [answer, thought, waiting, onProgress])
  if (!answer && !thought && !stopped && !waiting) return null
  return <div className="chat-response" data-streaming={active || answer !== content || undefined}>
    {waiting && <div className="chat-response-waiting" role="status" aria-label="等待模型回复">
      <span aria-hidden /><span aria-hidden /><span aria-hidden />
    </div>}
    <ChatReasoning text={thought} />
    {!!answer && <article className="chat-message chat-message-assistant" aria-label="助手回复">
      <div className="chat-message-body">
        <ChatMarkdown text={answer} />
        {quarantined && <p className="mt-2 text-xs text-danger">此回复包含未核实或已撤回的资料。</p>}
      </div>
      <ChatMessageCopy value={content} noun="回复内容" />
    </article>}
    {stopped && <p role="status" className="text-xs text-fg-muted">已停止</p>}
  </div>
}

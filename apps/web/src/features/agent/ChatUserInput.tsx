import { useEffect, useId, useRef, useState } from 'react'
import type { AgentUserInputAnswer, AgentUserInputRequest } from '@elysian/contracts'
import { Check, ChevronDown } from '../../components/icons'
import './chatUserInput.css'

const answered = (answer?: AgentUserInputAnswer) => !!(answer?.optionId || answer?.text?.trim())

export function ChatUserInput({ request, answers, submitting, pending, onAnswer, onSubmit, onCancel }: {
  request: AgentUserInputRequest
  answers: Readonly<Record<string, AgentUserInputAnswer>>
  submitting: boolean; pending: boolean
  onAnswer(questionId: string, answer: AgentUserInputAnswer): void
  onSubmit(): void; onCancel(): void
}) {
  const [index, setIndex] = useState(() => Math.max(0, request.questions.findIndex(q => !answered(answers[q.id]))))
  const question = request.questions[index]!
  const answer = answers[question.id]
  const custom = answer !== undefined && answer.optionId === undefined
  const selected = custom ? question.options.length : question.options.findIndex(option => option.id === answer?.optionId)
  const heading = useRef<HTMLParagraphElement>(null)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const text = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const prefix = useId()
  const locked = submitting || pending
  const complete = request.questions.every(q => answered(answers[q.id]))
  const choose = (next: number, confirm = false) => {
    if (locked) return
    const option = question.options[next]
    onAnswer(question.id, option ? { optionId: option.id } : { text: custom ? answer.text : '' })
    if (confirm && option && index < request.questions.length - 1) setIndex(index + 1)
  }
  useEffect(() => { heading.current?.focus() }, [index])
  useEffect(() => { if (custom && !locked) text.current?.focus() }, [custom, locked, index])
  const advance = () => {
    if (submitting) return
    if (pending) { onSubmit(); return }
    if (!answered(answer)) return
    if (index < request.questions.length - 1) setIndex(index + 1)
    else if (complete) onSubmit()
  }
  return <section className="chat-user-input panel-surface" aria-label="回答 Ely 的问题" aria-busy={submitting}>
    <div className="chat-question-heading"><span>{question.header}</span><span className="tabular-nums">第 {index + 1}/{request.questions.length} 题</span></div>
    <p id={`${prefix}-question`} ref={heading} tabIndex={-1} className="chat-question-title">{question.question}</p>
    <div role="radiogroup" aria-labelledby={`${prefix}-question`} className="chat-question-options">
      {[...question.options, { id: '__custom', label: '自定义回答', description: '用自己的话补充你的选择。' }].map((option, position) => <button
        key={`${question.id}:${position}`} type="button" role="radio" aria-checked={selected === position} disabled={locked}
        tabIndex={selected === position || selected < 0 && position === 0 ? 0 : -1}
        ref={element => { radios.current[position] = element }} className="chat-question-option"
        onClick={() => choose(position, true)} onKeyDown={event => {
          if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const length = question.options.length + 1
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : (position + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + length) % length
            choose(next); radios.current[next]?.focus()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (!event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229) choose(position, true)
          }
        }}>
        <span className="chat-question-number">{selected === position ? <Check size={14} aria-hidden /> : position + 1}</span>
        <span className="chat-question-option-copy"><span className="chat-question-label">{option.label}{question.recommendedOptionId === option.id && <span className="chat-question-recommended">推荐</span>}</span><span className="chat-question-description">{option.description}</span></span>
      </button>)}
    </div>
    {custom && <div className="chat-question-custom"><label htmlFor={`${prefix}-answer`} className="sr-only">自定义回答</label>
      <textarea id={`${prefix}-answer`} ref={text} rows={3} maxLength={4000} disabled={locked} value={answer.text} placeholder="输入你的回答…"
        onChange={event => onAnswer(question.id, { text: event.target.value })}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); advance() } }} />
      <span className="chat-question-description">Enter 换行，Ctrl / ⌘ + Enter 继续</span></div>}
    {pending && !submitting && <p role="status" className="chat-question-description">回答结果尚未确认。重试将沿用原回答。</p>}
    <div className="chat-question-actions">
      <button type="button" className="chat-question-cancel" disabled={submitting} onClick={onCancel}>取消本轮</button>
      <div><button type="button" disabled={submitting || index === 0} onClick={() => setIndex(index - 1)}>上一步</button>
        <button type="button" onClick={advance} disabled={submitting || (!pending && (!answered(answer) || index === request.questions.length - 1 && !complete))}>
          {submitting ? '正在提交…' : pending ? '重试提交' : index === request.questions.length - 1 ? '提交选择' : '下一步'}
        </button></div>
    </div>
  </section>
}

export function ChatUserInputSummary({ request }: { request: AgentUserInputRequest }) {
  return <details className="chat-question-summary"><summary><ChevronDown size={14} aria-hidden />
    {request.status === 'pending' ? '等待你回答' : request.status === 'answered' ? '已提交选择' : '问题已取消'} · {request.questions.length} 个问题
  </summary><dl>{request.questions.map(q => <div key={q.id}><dt>{q.question}</dt><dd>{request.answers?.[q.id]?.text ?? q.options.find(o => o.id === request.answers?.[q.id]?.optionId)?.label ?? (request.status === 'cancelled' ? '未回答 · 已取消' : '等待回答')}</dd></div>)}</dl></details>
}

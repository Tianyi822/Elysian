import { useId, useLayoutEffect, useState } from 'react'
import { RUNTIME_RUN_STATUS_LABELS, type AgentRunPlan, type RuntimeRunStatus } from '@elysian/contracts'
import { Check, ChevronRight, ListTodo, Loader2, Minus } from '../../components/icons'
import './chatPlan.css'

const labels = { pending: '待执行', in_progress: '进行中', completed: '已完成' }

/** 仅展示服务端确认的快照；展开偏好留在组件内，不写入本地会话事实。 */
export function ChatPlan({ plan, status, stopping = false, onProgress }: {
  plan?: AgentRunPlan; status: RuntimeRunStatus; stopping?: boolean; onProgress?(): void
}) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  useLayoutEffect(() => { onProgress?.() }, [expanded, plan, onProgress])
  if (!plan) return null
  const completed = plan.steps.filter(step => step.status === 'completed').length
  const current = plan.steps.find(step => step.status === 'in_progress')
  const running = status === 'running' && !stopping
  const remaining = completed < plan.steps.length
  const summary = stopping ? '正在停止' : status === 'cancelled' ? '已停止' : status === 'succeeded'
    ? remaining ? '本轮已结束，仍有未完成步骤' : '全部完成'
    : running ? current ? `正在${current.title}` : remaining ? '准备下一步' : '步骤已完成'
    : RUNTIME_RUN_STATUS_LABELS[status]
  return <section className="chat-plan panel-surface" aria-label="任务进度" data-status={status}>
    <button type="button" className="chat-plan-toggle" aria-expanded={expanded} aria-controls={id}
      aria-label={`${expanded ? '收起' : '展开'}任务进度`} onClick={() => setExpanded(value => !value)}>
      <ListTodo size={16} aria-hidden />
      <span className="chat-plan-label">任务进度</span>
      <span className="chat-plan-count tabular-nums">{completed}/{plan.steps.length} 已完成</span>
      <span className="chat-plan-summary" role="status" title={summary}>{summary}</span>
      <ChevronRight size={14} aria-hidden className={expanded ? '-rotate-90' : undefined} />
    </button>
    {expanded && <div id={id} role="region" aria-label="任务步骤" className="chat-plan-details hover-scrollbar" tabIndex={0}>
      <ol>
        {plan.steps.map(step => {
          const Icon = step.status === 'completed' ? Check : step.status === 'in_progress' ? Loader2 : Minus
          return <li key={step.id} data-status={step.status}>
            <Icon size={14} aria-hidden className={step.status === 'in_progress' && running ? 'animate-spin motion-reduce:animate-none' : undefined} />
            <span className="chat-plan-title">{step.title}</span>
            <span className="chat-plan-step-status">{labels[step.status]}</span>
          </li>
        })}
      </ol>
      {remaining && (status === 'failed' || status === 'interrupted' || status === 'cancelled' || status === 'recovery-required') &&
        <p className="chat-plan-note">保留最后确认的进度，未完成步骤未标记为完成。</p>}
    </div>}
  </section>
}

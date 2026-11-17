import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import { isChatRunActive } from '../../stores/agentChatStore'
import { createUnavailableAgentConversationAdapter } from '../../adapters/http/agent/agentConversationHttpAdapter'
import { parseContinuousFields, parseStorageHealth } from '../../adapters/http/agent/agentRecoveryParse'
import { ChatRecovery } from './ChatRecovery'
import { ChatTimeline } from './ChatTimeline'
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip'

it.each(['waiting-model', 'waiting-storage'] as const)('展示自动恢复并保持 %s 为活动任务', kind => {
  const timeline: AgentChatTimelineSnapshot = { runId: 'run', status: kind, done: false, entries: [], wait: { kind, attempts: 2, nextAt: '2026-11-17T10:00:00Z', reason: { code: 'temporary', message: '原进度已经保存' } } }
  render(<ChatRecovery timeline={timeline} api={createUnavailableAgentConversationAdapter()} />)
  expect(screen.getByRole('status')).toHaveTextContent('无需点击继续任务')
  expect(screen.getByRole('status')).toHaveTextContent('不重复执行已提交操作')
  expect(isChatRunActive({ id: 'run', taskId: 'task', status: kind })).toBe(true)
  expect(screen.queryByRole('button', { name: '继续任务' })).not.toBeInTheDocument()
})

it('解析新策略、当前事实及分层存储健康，拒绝未知策略', () => {
  const report = { outcome: '已保存', reason: '原操作未知', completed: 1, failed: 0, unconfirmed: 0, steps: [], remaining: [], next: '沿用原任务', evidenceVersion: 'run:17:digest', asOf: '2026-11-17T10:00:00Z' }
  expect(parseContinuousFields({ recoveryPolicy: 'evidence-recovery/v2', currentReport: report })).toEqual({ recoveryPolicy: 'evidence-recovery/v2', currentReport: report })
  expect(parseStorageHealth({ read: 'ready', write: 'ready', records: 'unavailable', recovery: 'retrying' })).toEqual({ read: 'ready', write: 'ready', records: 'unavailable', recovery: 'retrying' })
  expect(() => parseContinuousFields({ recoveryPolicy: 'future' })).toThrow()
  expect(() => parseContinuousFields({ wait: { kind: 'waiting-model', attempts: 1, nextAt: 'invalid' } })).toThrow()
})

it('终态忽略旧等待投影，不再承诺自动继续', () => {
  const timeline: AgentChatTimelineSnapshot = { runId: 'cancelled', status: 'cancelled', done: true, entries: [], wait: { kind: 'waiting-model', attempts: 1, nextAt: '2026-11-17T10:00:00Z' } }
  render(<ChatRecovery timeline={timeline} api={createUnavailableAgentConversationAdapter()} />)
  expect(screen.queryByText(/自动检查并继续/)).not.toBeInTheDocument()
})

it('核实失败原因发生变化时展示最新事实并保留原报告', () => {
  const report = { outcome: '原任务未完成', reason: '原结果未知', completed: 0, failed: 1, unconfirmed: 0, steps: [], remaining: ['验证服务'], next: '核实后继续' }
  const timeline: AgentChatTimelineSnapshot = { runId: 'verified', status: 'interrupted', done: true, entries: [], terminalResult: { origin: 'runtime', content: '原始事实报告', report }, currentReport: { ...report, reason: '现已确认操作失败且没有变更', evidenceVersion: 'verified:18:hash', asOf: '2026-11-17T10:00:00Z' } }
  render(<TooltipProvider><ChatTimeline timeline={timeline} active={false} stopped={false} api={createUnavailableAgentConversationAdapter()} onProgress={() => {}} showPlan={false} /></TooltipProvider>)
  expect(screen.getByText('原始事实报告')).toBeInTheDocument()
  expect(screen.getByText('现已确认操作失败且没有变更')).toBeInTheDocument()
  expect(screen.getByText('未完成：验证服务')).toBeInTheDocument()
})

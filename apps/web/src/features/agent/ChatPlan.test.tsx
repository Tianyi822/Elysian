import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AgentRunPlan, RuntimeRunStatus } from '@elysian/contracts'
import { ChatPlan } from './ChatPlan'

export const plan: AgentRunPlan = { revision: 1, updatedAt: '2026-10-17T00:00:00Z', steps: [
  { id: 'inspect', title: '检查配置', status: 'completed' },
  { id: 'verify', title: '验证结果', status: 'in_progress' },
  { id: 'report', title: '汇总结果', status: 'pending' },
] }

describe('任务进度', () => {
  it('无计划不占位，默认折叠；键盘展开后实时更新并保持展开', async () => {
    const user = userEvent.setup()
    const view = render(<ChatPlan status="running" />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ChatPlan status="running" plan={plan} />)
    expect(screen.getByText('1/3 已完成')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在验证结果')
    expect(screen.queryByRole('region', { name: '任务步骤' })).not.toBeInTheDocument()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: '收起任务进度' })).toHaveFocus()
    const details = screen.getByRole('region', { name: '任务步骤' })
    expect(within(details).getAllByRole('listitem')).toHaveLength(3)
    expect(details.querySelectorAll('.animate-spin')).toHaveLength(1)
    const updated: AgentRunPlan = { ...plan, revision: 2, steps: plan.steps.map(step => ({ ...step, status: 'completed' })) }
    view.rerender(<ChatPlan status="succeeded" plan={updated} />)
    expect(screen.getByRole('region', { name: '任务步骤' })).toBe(details)
    expect(screen.getByText('3/3 已完成')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('全部完成')
    expect(details.querySelectorAll('.animate-spin')).toHaveLength(0)
    await user.keyboard(' ')
    expect(screen.queryByRole('region', { name: '任务步骤' })).not.toBeInTheDocument()
  })
  it.each<[RuntimeRunStatus, string]>([['waiting-input', '等待回答'], ['waiting-approval', '等待审批'], ['waiting-resource', '等待资源'], ['cancelled', '已停止'], ['failed', '已失败'], ['interrupted', '运行中断'], ['succeeded', '本轮已结束，仍有未完成步骤']])('%s 保留未完成步骤且无动画', (status, label) => {
    const view = render(<ChatPlan status={status} plan={plan} />)
    fireEvent.click(screen.getByRole('button', { name: '展开任务进度' }))
    expect(screen.getByRole('status')).toHaveTextContent(label)
    expect(screen.getByText('1/3 已完成')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.animate-spin')).toHaveLength(0)
  })
  it('停止在途不冒充已停止', () => {
    render(<ChatPlan status="running" plan={plan} stopping />)
    expect(screen.getByRole('status')).toHaveTextContent(/^正在停止$/)
  })
})

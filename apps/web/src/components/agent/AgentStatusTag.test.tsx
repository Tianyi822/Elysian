import { describe, expect, it } from 'vitest'
import {
  AGENT_APPROVAL_STATUSES,
  AGENT_OPERATION_STATUSES,
  AGENT_RESOURCE_LEASE_STATUSES,
  AGENT_WORKFLOW_STATUSES,
  RUNTIME_RUN_STATUSES,
} from '@elysian/contracts'
import { render, screen } from '@testing-library/react'
import {
  AgentApprovalStatusTag,
  AgentOperationStatusTag,
  AgentResourceLeaseStatusTag,
  AgentRunStatusTag,
  AgentWorkflowStatusTag,
} from './AgentStatusTag'

describe('AgentStatusTag 五族映射', () => {
  it('运行状态全取值渲染中文标签且文字颜色双表达', () => {
    for (const status of RUNTIME_RUN_STATUSES) {
      const view = render(<AgentRunStatusTag status={status} />)
      const node = view.container.firstElementChild as HTMLElement
      expect(node.textContent).toMatch(/[\u4e00-\u9fff]/)
      expect(node.className).toMatch(/border-(info|success|warning|danger|line)/)
      view.unmount()
    }
  })

  it('等待审批与等待人工恢复是警示/危险，已取消为中性', () => {
    const pending = render(<AgentRunStatusTag status="waiting-approval" />)
    expect(screen.getByText('等待审批')).toBeInTheDocument()
    expect(pending.container.firstElementChild).toHaveClass('border-warning/40')
    pending.unmount()
    const recovery = render(<AgentRunStatusTag status="recovery-required" />)
    expect(screen.getByText('等待人工恢复')).toBeInTheDocument()
    expect(recovery.container.firstElementChild).toHaveClass('border-danger/40')
    recovery.unmount()
    const cancelled = render(<AgentRunStatusTag status="cancelled" />)
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(cancelled.container.firstElementChild).toHaveClass('border-line')
  })

  it('审批、操作、工作流与资源租约状态全取值均有中文与 tone', () => {
    const families = [
      { statuses: AGENT_APPROVAL_STATUSES, render: (status: string) => <AgentApprovalStatusTag status={status as never} /> },
      { statuses: AGENT_OPERATION_STATUSES, render: (status: string) => <AgentOperationStatusTag status={status as never} /> },
      { statuses: AGENT_WORKFLOW_STATUSES, render: (status: string) => <AgentWorkflowStatusTag status={status as never} /> },
      { statuses: AGENT_RESOURCE_LEASE_STATUSES, render: (status: string) => <AgentResourceLeaseStatusTag status={status as never} /> },
    ]
    for (const family of families) {
      for (const status of family.statuses) {
        const view = render(family.render(status))
        const node = view.container.firstElementChild as HTMLElement
        expect(node.textContent, status).toMatch(/[\u4e00-\u9fff]/)
        expect(node.className, status).toMatch(/border-(info|success|warning|danger|line)/)
        view.unmount()
      }
    }
  })
})

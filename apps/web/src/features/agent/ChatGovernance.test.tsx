import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Tooltip from '@radix-ui/react-tooltip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApproval, AgentEnvironment, AgentExecutionGrant, AgentExecutionProfile } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../contracts/agentChat'
import { ChatApprovals } from './ChatApprovals'
import { ChatExecutionScope } from './ChatExecutionScope'
import { useNotificationStore } from '../../stores/notificationStore'

const profile: AgentExecutionProfile = { id: 'bash', revision: 3, enabled: true, name: '受限 Bash', image: `bash@sha256:${'a'.repeat(64)}`, runtime: 'bash', command: ['/bin/bash'], timeoutSeconds: 60, cpuMillis: 1000, memoryBytes: 134217728, pids: 64, createdAt: '2026-10-16T00:00:00Z' }
const grant: AgentExecutionGrant = { id: 'business', revision: 2, enabled: true, name: '网站目录', directories: [{ path: '/srv/projects/shop', access: 'rw' }], network: [], privateCidrs: [], resources: [{ domain: 'website', id: 'shop', access: 'write' }], createdAt: profile.createdAt }
const environment: AgentEnvironment = { sessionId: 'session', revision: 4, tools: [], skills: [], servers: [], grants: [], executionProfiles: [], resources: [], trustedReadOnly: [] }
const approval: AgentApproval = { id: 'approval', runId: 'run', operationId: 'operation', status: 'pending', createdAt: profile.createdAt, expiresAt: '2026-10-17T00:00:00Z', operation: {
  id: 'operation', runId: 'run', taskId: 'task', modelRequestId: 'request', callIndex: 0, modelCallId: 'call', argumentsJson: '{"command":"rm -f old.txt; mv new.txt live.txt"}',
  capability: { name: 'task_bash_command', description: '受限 Bash', parameters: {}, source: 'bash', ref: { id: 'bash', revision: 3 }, readOnly: false }, snapshotDigest: 'digest', workspaceRevision: 7,
  execution: { profile, grant, scriptDigest: '' }, policy: 'approval-required', status: 'waiting-approval', approvalId: 'approval', callId: 'call', createdAt: profile.createdAt,
} }
const governance = (): AgentChatGovernance => ({ approvals: vi.fn(async () => [approval]), decide: vi.fn(async (_id, decision) => ({ ...approval, status: decision, decision })), environment: vi.fn(async () => environment), updateEnvironment: vi.fn(async (_id, _revision, env) => env), profiles: vi.fn(async () => [profile]), grants: vi.fn(async () => [grant]), tools: vi.fn(async () => [{ ...approval.operation!.capability, name: 'task_workspace_read' }]) })

beforeEach(() => useNotificationStore.getState().clear())

describe('聊天审批和执行范围', () => {
  it('审批恢复完整命令、工作区版本与真实挂载，批准只作用于精确审批', async () => {
    const user = userEvent.setup()
    const api = governance()
    const changed = vi.fn()
    const cancel = vi.fn()
    render(<ChatApprovals api={api} runId="run" onChanged={changed} onCancel={cancel} />)
    expect(await screen.findByText(approval.operation!.argumentsJson)).toBeInTheDocument()
    expect(screen.getByText('任务工作区 v7')).toBeInTheDocument()
    expect(screen.getByText('/srv/projects/shop → /grants/0 · rw')).toBeInTheDocument()
    expect(screen.getByText('可能产生不可回滚的外部修改或删除。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '批准' }))
    expect(api.decide).toHaveBeenCalledWith('approval', 'approved')
    expect(changed).toHaveBeenCalledOnce()
    expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ tone: 'success', message: '操作已批准，等待执行。' })])
    expect(api.approvals).toHaveBeenCalledWith('run', expect.any(AbortSignal))
  })

  it('切换会话卸载审批，迟到读取不能重新显示旧目标', async () => {
    const api = governance()
    let resolve!: (value: readonly AgentApproval[]) => void
    vi.mocked(api.approvals).mockReturnValue(new Promise(done => { resolve = done }))
    const view = render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.approvals).toHaveBeenCalled())
    const signal = vi.mocked(api.approvals).mock.calls[0]![1]!
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => resolve([approval]))
    expect(screen.queryByText('task_bash_command')).not.toBeInTheDocument()
  })

  it('文件审批呈现固定版本的修改前后和删除，不将空文件当作不存在', async () => {
    const api = governance()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, operation: { ...approval.operation!, fileChanges: [
      { path: 'config.txt', before: { bytes: 3, digest: 'old-digest', text: 'old' }, after: { bytes: 0, digest: 'empty-digest', text: '' } },
      { path: 'removed.txt', before: { bytes: 4, digest: 'binary-digest' } },
    ] } }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByLabelText('文件变更 config.txt')).toHaveTextContent('old')
    expect(screen.getByLabelText('文件变更 config.txt')).toHaveTextContent('空文件')
    expect(screen.getByLabelText('文件变更 removed.txt')).toHaveTextContent('binary-digest')
    expect(screen.getByLabelText('文件变更 removed.txt')).toHaveTextContent('不存在')
  })

  it('选择已有配置和精确授权，保存使用原环境修订', async () => {
    const api = governance()
    const user = userEvent.setup()
    const close = vi.fn()
    render(<Tooltip.Provider><ChatExecutionScope open sessionId="session" api={api} locked={false} onClose={close} /></Tooltip.Provider>)
    await screen.findByRole('checkbox', { name: /受限 Bash v3/ })
    await user.click(screen.getByRole('checkbox', { name: /受限 Bash v3/ }))
    await user.click(screen.getByRole('checkbox', { name: /网站目录/ }))
    expect(screen.getByText('/srv/projects/shop → /grants/0 · rw')).toBeInTheDocument()
    expect(screen.getByText('website / shop · write')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(api.updateEnvironment).toHaveBeenCalledWith('session', 4, expect.objectContaining({ executionProfiles: [{ id: 'bash', revision: 3 }], grants: [{ id: 'business', revision: 2 }] }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ tone: 'success', message: '执行范围已保存。' })])
  })

  it('执行范围读取失败进入通知区，保留重试入口', async () => {
    const api = governance()
    vi.mocked(api.environment).mockRejectedValue(new Error('执行范围读取失败'))
    render(<Tooltip.Provider><ChatExecutionScope open sessionId="session" api={api} locked={false} onClose={vi.fn()} /></Tooltip.Provider>)
    await screen.findByRole('button', { name: '重新读取执行范围' })
    expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ tone: 'danger', message: '执行范围读取失败' })])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('审批提交后切换会话，迟到回执不发布通知', async () => {
    const api = governance()
    let resolve!: (value: AgentApproval) => void
    vi.mocked(api.decide).mockReturnValue(new Promise(done => { resolve = done }))
    const changed = vi.fn()
    const view = render(<ChatApprovals api={api} runId="run" onChanged={changed} onCancel={vi.fn()} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: '批准' }))
    view.unmount()
    await act(async () => resolve({ ...approval, status: 'approved' }))
    expect(changed).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().notifications).toEqual([])
  })
})

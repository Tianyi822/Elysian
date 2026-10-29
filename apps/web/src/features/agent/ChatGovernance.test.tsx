import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApproval, AgentExecutionGrant, AgentExecutionProfile, AgentRuntimeAccess } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../contracts/agentChat'
import { ChatApprovals } from './ChatApprovals'
import { useMessageStore } from '../../stores/messageStore'

const profile: AgentExecutionProfile = { id: 'bash', revision: 3, enabled: true, name: '受限 Bash', image: `bash@sha256:${'a'.repeat(64)}`, runtime: 'bash', command: ['/bin/bash'], timeoutSeconds: 60, cpuMillis: 1000, memoryBytes: 134217728, pids: 64, createdAt: '2026-10-16T00:00:00Z' }
const grant: AgentExecutionGrant = { id: 'business', revision: 2, enabled: true, name: '网站目录', directories: [{ path: '/srv/projects/shop', access: 'rw' }], network: [], privateCidrs: [], resources: [{ domain: 'website', id: 'shop', access: 'write' }], createdAt: profile.createdAt }
const approval: AgentApproval = { id: 'approval', runId: 'run', operationId: 'operation', status: 'pending', createdAt: profile.createdAt, expiresAt: '2026-10-17T00:00:00Z', operation: {
  id: 'operation', runId: 'run', taskId: 'task', modelRequestId: 'request', callIndex: 0, modelCallId: 'call', argumentsJson: '{"command":"rm -f old.txt; mv new.txt live.txt"}',
  capability: { name: 'task_bash_command', description: '受限 Bash', parameters: {}, source: 'bash', ref: { id: 'bash', revision: 3 }, readOnly: false }, snapshotDigest: 'digest', workspaceRevision: 7,
  execution: { profile, grant, scriptDigest: '' }, policy: 'approval-required', status: 'waiting-approval', approvalId: 'approval', callId: 'call', createdAt: profile.createdAt,
} }
const access: AgentRuntimeAccess = { revision: 1, digest: 'scope-digest', scopeKey: 'scope', kind: 'script', directories: grant.directories, network: [], privateCidrs: [], resources: grant.resources, sessionAllowed: true, runtime: { name: 'Bash', image: profile.image, platform: 'linux/amd64', requiresDownload: true } }
const governance = (): AgentChatGovernance => ({ decideAccess: vi.fn(async () => ({ ...approval, status: 'approved' as const, access })), approvals: vi.fn(async () => [approval]), decide: vi.fn(async (_id, decision) => ({ ...approval, status: decision, decision })) })

beforeEach(async () => { useMessageStore.getState().clear(); sessionStorage.clear() })

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
    expect(useMessageStore.getState().messages).toEqual([expect.objectContaining({ tone: 'success', message: '操作已批准，等待执行。' })])
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

  it('运行时权限默认仅本次，确认一次即提交范围与批准', async () => {
    const api = governance(), user = userEvent.setup(), changed = vi.fn()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, access }])
    render(<ChatApprovals api={api} runId="run" onChanged={changed} onCancel={vi.fn()} />)
    await screen.findByRole('button', { name: '确认并继续' })
    expect(screen.queryByRole('radio', { name: '本会话允许' })).not.toBeInTheDocument()
    expect(screen.getByText(/确认后下载镜像/)).toBeInTheDocument()
    expect(api.decideAccess).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认并继续' }))
    expect(api.decideAccess).toHaveBeenCalledWith('approval', { requestId: expect.any(String), expectedRevision: 1, expectedDigest: 'scope-digest', decision: 'once' })
    expect(api.decide).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('结果未知先回读，人工重试复用原请求和选择', async () => {
    const api = governance(), user = userEvent.setup()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, access }])
    vi.mocked(api.decideAccess).mockRejectedValueOnce(new Error('连接中断'))
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: '确认并继续' }))
    const input = vi.mocked(api.decideAccess).mock.calls[0]![1]
    await user.click(await screen.findByRole('button', { name: '按原选择重试' }))
    expect(api.decideAccess).toHaveBeenNthCalledWith(2, 'approval', input)
  })

  it('拒绝权限和停止任务是独立操作', async () => {
    const api = governance(), user = userEvent.setup(), cancel = vi.fn()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, access }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={cancel} />)
    await user.click(await screen.findByRole('button', { name: '拒绝' }))
    expect(api.decideAccess).toHaveBeenCalledWith('approval', expect.objectContaining({ decision: 'denied' }))
    expect(cancel).not.toHaveBeenCalled()
  })

  it('准备镜像期间显示下载进度，并可独立停止任务', async () => {
    const api = governance(), cancel = vi.fn(), user = userEvent.setup()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, status: 'approved', access, operation: { ...approval.operation!, preparation: { state: 'pulling', current: 30, total: 100 } } }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={cancel} />)
    expect(await screen.findByRole('progressbar', { name: '镜像下载进度' })).toHaveAttribute('value', '30')
    await user.click(screen.getByRole('button', { name: '停止任务' }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(api.decideAccess).not.toHaveBeenCalled()
  })

  it('准备结果未知的新申请保留原因，键盘确认只核实并继续', async () => {
    const api = governance(), user = userEvent.setup()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, id: 'retry', access: { ...access, revision: 2, digest: 'retry' }, operation: { ...approval.operation!, preparation: { state: 'unknown', error: '仅核实本机镜像，尚未确认不会再次下载。' } } }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    const button = await screen.findByRole('button', { name: '重新核实并继续' })
    expect(screen.getByText('仅核实本机镜像，尚未确认不会再次下载。')).toBeInTheDocument()
    button.focus(); await user.keyboard('{Enter}')
    expect(api.decideAccess).toHaveBeenCalledWith('retry', expect.objectContaining({ expectedRevision: 2, expectedDigest: 'retry', decision: 'once' }))
  })

  it('MCP 申请显示原始工具名和完整启动参数，散列别名只放详情', async () => {
    const api = governance(), user = userEvent.setup()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, access: { ...access, kind: 'mcp' }, operation: { ...approval.operation!, capability: { ...approval.operation!.capability, source: 'mcp', name: 'mcp_53e2b4_read', originalName: 'read_config' }, execution: { ...approval.operation!.execution!, profile: { ...profile, command: ['node', '/app/mcp.js', '--project', '/grants/0'] } } } }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'read_config' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'mcp_53e2b4_read' })).not.toBeInTheDocument()
    await user.click(screen.getByText('命令、镜像、挂载与限额'))
    expect(screen.getByLabelText('运行环境启动命令')).toHaveTextContent('["node","/app/mcp.js","--project","/grants/0"]')
    expect(screen.getByText('工具别名：mcp_53e2b4_read')).toBeInTheDocument()
  })

  it('内置文件操作解释实际动作，宿主目录不冒充容器挂载', async () => {
    const api = governance(), user = userEvent.setup()
    vi.mocked(api.approvals).mockResolvedValue([{ ...approval, access: { ...access, kind: 'file', runtime: undefined }, operation: { ...approval.operation!, execution: undefined, capability: { ...approval.operation!.capability, source: 'builtin', name: 'files_remove', description: '删除指定业务目录中的文件。' } } }])
    render(<ChatApprovals api={api} runId="run" onChanged={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByLabelText('操作说明')).toHaveTextContent('删除指定业务目录中的文件。')
    await user.click(screen.getByText('命令、镜像、挂载与限额'))
    expect(screen.getByText('/srv/projects/shop（宿主业务目录） · rw')).toBeInTheDocument()
    expect(screen.queryByText(/→ \/grants/)).not.toBeInTheDocument()
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
    expect(useMessageStore.getState().messages).toEqual([])
  })
})

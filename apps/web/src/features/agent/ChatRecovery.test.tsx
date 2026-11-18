import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import { chatTestApi } from '../../test/agentChatFixtures'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatRecovery } from './ChatRecovery'
import { advanceAuthGeneration } from '../../utils/authGeneration'
import type { AgentChatSession, AgentConversationAdapter } from '../../contracts/agentChat'

const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'interrupted', done: true,
  recovery: { operationId: 'op', tool: 'docker_container_create_service', startedAt: '', deadline: '', checks: 3, status: 'unresolved', message: '缺少可信结束证据' },
  entries: [{ id: 'entry', kind: 'tool', tool: 'docker_container_create_service', modelRequestId: 'model', requestIndex: 0, startedAt: '', modelCallId: 'call', callIndex: 0, argumentsJson: '{}', status: 'unknown', truncated: false }] }

afterEach(() => {
  vi.restoreAllMocks()
  useAgentChatStore.setState({ session: null })
})
it('修正额度用尽不误报仍在核实', () => {
  const { api } = chatTestApi()
  render(<ChatRecovery timeline={{ ...timeline, entries: [], recovery: { ...timeline.recovery!, status: 'exhausted', message: '相同参数连续失败三次' } }} api={api} />)
  expect(screen.getByRole('status')).toHaveTextContent('本轮修正已结束')
  expect(screen.queryByText(/正在核实/)).not.toBeInTheDocument()
})
it('核实入口只核实原操作，成功后刷新服务端事实', async () => {
  const { api } = chatTestApi()
  const verifyRecovery = vi.fn().mockResolvedValue(undefined)
  const recoveryApi: AgentConversationAdapter = { ...api, verifyRecovery }
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={timeline} api={recoveryApi} />)
  fireEvent.click(screen.getByRole('button', { name: '核实实际状态' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledWith(recoveryApi, undefined, ['run-1']))
  expect(verifyRecovery).toHaveBeenCalledExactlyOnceWith('run-1')
  expect(api.createTask).not.toHaveBeenCalled()
  expect(api.continueTask).not.toHaveBeenCalled()
})
it('人工核实要求明确结果和证据，失败保留输入', async () => {
  const { api } = chatTestApi()
  const reconcileRecovery = vi.fn().mockRejectedValue(new Error('执行仍在进行，保护保留'))
  render(<ChatRecovery timeline={timeline} api={{ ...api, reconcileRecovery }} />)
  fireEvent.click(screen.getByText('登记人工核实结论'))
  const submit = screen.getByRole('button', { name: '保存核实结论并解除阻塞' })
  expect(submit).toBeDisabled()
  fireEvent.change(screen.getByLabelText('已核实的结果'), { target: { value: 'confirmed-stopped' } })
  fireEvent.change(screen.getByLabelText('核实证据'), { target: { value: '已回读 exec 与容器身份' } })
  fireEvent.click(submit)
  expect(await screen.findByRole('alert')).toHaveTextContent('执行仍在进行，保护保留')
  expect(screen.getByLabelText('核实证据')).toHaveValue('已回读 exec 与容器身份')
  expect(reconcileRecovery).toHaveBeenCalledWith('run-1', '已回读 exec 与容器身份', 'confirmed-stopped')
})


const blocker = { runId: 'old-run', operationId: 'old-operation', tool: 'docker_container_create_service', message: '此前操作结果待核实', verifiable: true }
const blockedTimeline: AgentChatTimelineSnapshot = {
  runId: 'blocked-run', status: 'interrupted', done: true, blockingRecovery: [blocker],
  entries: [{ ...timeline.entries[0]!, kind: 'tool', tool: 'docker_container_create_service', modelCallId: 'call', callIndex: 0, argumentsJson: '{}', truncated: false, status: 'not-executed',
    resourceWait: { resource: 'external:*', runId: blocker.runId, operationId: blocker.operationId, since: '2026-11-17T00:00:00Z', elapsedSeconds: 0, unknown: true, message: blocker.message } }],
}
function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
it('跨会话阻塞直接核实原运行，并强制回读当前轮次而不重投', async () => {
  const { api } = chatTestApi()
  const pending = deferred()
  const verifyRecovery = vi.fn(() => pending.promise)
  const recoveryApi = { ...api, verifyRecovery }
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={blockedTimeline} api={recoveryApi} />)
  expect(screen.getByText(/本次操作未执行/)).toBeInTheDocument()
  const verify = screen.getByRole('button', { name: '核实此前操作' })
  fireEvent.click(verify)
  fireEvent.click(verify)
  expect(verifyRecovery).toHaveBeenCalledExactlyOnceWith('old-run')
  expect(verify).toBeDisabled()
  await act(async () => pending.resolve())
  expect(refresh).toHaveBeenCalledExactlyOnceWith(recoveryApi, undefined, ['blocked-run', 'old-run'])
  expect(api.createTask).not.toHaveBeenCalled()
  expect(api.continueTask).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '核实此前操作' })).toBeEnabled()
  expect(screen.queryByText(/恢复完成/)).not.toBeInTheDocument()
})
it('按来源运行合并入口，同时保留每个阻塞操作的事实', async () => {
  const { api } = chatTestApi()
  const verifyRecovery = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: [blocker, { ...blocker, operationId: 'another-operation', tool: 'docker_container_exec', message: '另一操作结果待核实' }, { ...blocker, runId: 'second-run', operationId: 'second-operation' }] }} api={{ ...api, verifyRecovery }} />)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getByText('docker_container_exec：另一操作结果待核实')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '核实此前操作 second-run' }))
  await waitFor(() => expect(verifyRecovery).toHaveBeenCalledExactlyOnceWith('second-run'))
})
it('同一来源含不可核实操作时保留事实，不提供整个运行的无效核实入口', () => {
  const { api } = chatTestApi()
  render(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: [blocker, { ...blocker, operationId: 'missing-operation', tool: '', message: '原操作记录不可用', verifiable: false }] }} api={{ ...api, verifyRecovery: vi.fn() }} />)
  expect(screen.getByText('此前操作：原操作记录不可用')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '核实此前操作' })).not.toBeInTheDocument()
})
it('服务端屏障消失后移除入口，历史等待事实不会令入口重现', () => {
  const { api } = chatTestApi()
  const recoveryApi = { ...api, verifyRecovery: vi.fn() }
  const view = render(<ChatRecovery timeline={blockedTimeline} api={recoveryApi} />)
  expect(screen.getByRole('button', { name: '核实此前操作' })).toBeInTheDocument()
  view.rerender(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: [] }} api={recoveryApi} />)
  expect(screen.queryByLabelText('操作恢复')).not.toBeInTheDocument()
  view.rerender(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: undefined }} api={recoveryApi} />)
  expect(screen.queryByLabelText('操作恢复')).not.toBeInTheDocument()
})
it('核实失败保留入口和具体原因，允许人工再次核实', async () => {
  const { api } = chatTestApi()
  const verifyRecovery = vi.fn().mockRejectedValue(new Error('原提交仍在进行'))
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={blockedTimeline} api={{ ...api, verifyRecovery }} />)
  fireEvent.click(screen.getByRole('button', { name: '核实此前操作' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('原提交仍在进行')
  expect(screen.getByRole('button', { name: '核实此前操作' })).toBeEnabled()
  expect(refresh).not.toHaveBeenCalled()
})
it('切换轮次后忽略旧核实回执，并清除旧表单草稿', async () => {
  const { api } = chatTestApi()
  const pending = deferred()
  const recoveryApi = { ...api, verifyRecovery: vi.fn(() => pending.promise), reconcileRecovery: vi.fn() }
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  const view = render(<ChatRecovery timeline={timeline} api={recoveryApi} />)
  fireEvent.change(screen.getByLabelText('核实证据'), { target: { value: '上一轮证据' } })
  fireEvent.click(screen.getByRole('button', { name: '核实实际状态' }))
  view.rerender(<ChatRecovery timeline={{ ...timeline, runId: 'new-run' }} api={recoveryApi} />)
  expect(screen.getByLabelText('核实证据')).toHaveValue('')
  await act(async () => pending.reject(new Error('旧轮次错误')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核实实际状态' })).toBeEnabled()
  expect(refresh).not.toHaveBeenCalled()
})
it('登录代次变化后旧核实不能刷新后续会话', async () => {
  const { api } = chatTestApi()
  const pending = deferred()
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={blockedTimeline} api={{ ...api, verifyRecovery: vi.fn(() => pending.promise) }} />)
  fireEvent.click(screen.getByRole('button', { name: '核实此前操作' }))
  advanceAuthGeneration()
  await act(async () => pending.resolve())
  expect(refresh).not.toHaveBeenCalled()
})
it('切换会话后忽略旧核实回执，并重置恢复入口', async () => {
  const { api } = chatTestApi()
  const session: AgentChatSession = { id: 'session-1', createdAt: '2026-11-17T00:00:00Z', draft: '', messages: [], attachments: [], permissionMode: 'ask', modelId: null, reasoningLevel: null }
  useAgentChatStore.setState({ session })
  const pending = deferred()
  const recoveryApi = { ...api, verifyRecovery: vi.fn(() => pending.promise) }
  const refresh = vi.spyOn(useAgentChatStore.getState(), 'refresh').mockResolvedValue(undefined)
  render(<ChatRecovery timeline={blockedTimeline} api={recoveryApi} />)
  fireEvent.click(screen.getByRole('button', { name: '核实此前操作' }))
  act(() => useAgentChatStore.setState({ session: { ...session, id: 'new-session' } }))
  await act(async () => pending.reject(new Error('旧会话错误')))
  expect(refresh).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核实此前操作' })).toBeEnabled()
})
it('缺少核实通道时保留阻塞说明，不提供无效核实动作', () => {
  const { api } = chatTestApi()
  render(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: [{ ...blocker, verifiable: false }] }} api={{ ...api, verifyRecovery: vi.fn() }} />)
  expect(screen.getByText(/当前没有可用的自动核实通道|暂不支持自动核实/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '核实此前操作' })).not.toBeInTheDocument()
})
it('独立探测租约保留阻塞说明，不尝试核实空运行身份', () => {
  const { api } = chatTestApi()
  render(<ChatRecovery timeline={{ ...blockedTimeline, blockingRecovery: [{ ...blocker, runId: '', operationId: '', leaseId: 'probe-lease', verifiable: false }] }} api={{ ...api, verifyRecovery: vi.fn() }} />)
  expect(screen.getByText('请在对应设置中核实独立资源操作。')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '核实此前操作' })).not.toBeInTheDocument()
})

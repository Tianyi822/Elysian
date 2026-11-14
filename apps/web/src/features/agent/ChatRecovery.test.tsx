import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import { chatTestApi } from '../../test/agentChatFixtures'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatRecovery } from './ChatRecovery'
import type { AgentConversationAdapter } from '../../contracts/agentChat'

const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'interrupted', done: true,
  recovery: { operationId: 'op', tool: 'docker_container_create_service', startedAt: '', deadline: '', checks: 3, status: 'unresolved', message: '缺少可信结束证据' },
  entries: [{ id: 'entry', kind: 'tool', tool: 'docker_container_create_service', modelRequestId: 'model', requestIndex: 0, startedAt: '', modelCallId: 'call', callIndex: 0, argumentsJson: '{}', status: 'unknown', truncated: false }] }

afterEach(() => vi.restoreAllMocks())
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
  await waitFor(() => expect(refresh).toHaveBeenCalledWith(recoveryApi))
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

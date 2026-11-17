import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { beforeEach, expect, it } from 'vitest'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { chatTestApi } from '../../test/agentChatFixtures'
import { ChatSessionList } from './ChatSessionList'

beforeEach(() => {
  useAgentChatStore.getState().clearDisplay()
  useAgentChatStore.setState({ session: null, localSessions: [], sessions: [], listLoading: false, listError: null })
})

function renderList(backend: ReturnType<typeof chatTestApi>) {
  return render(<Tooltip.Provider><ChatSessionList onNew={() => {}} onSelect={() => {}}
    onRefresh={() => { void useAgentChatStore.getState().loadSessions(backend.api) }} onMore={() => {}} refreshing={false} /></Tooltip.Provider>)
}

it('首次读取失败显示错误及重试，恢复后才显示成功空列表', async () => {
  const backend = chatTestApi()
  backend.api.listSessions.mockRejectedValueOnce(new Error('任务存储不可用'))
  await useAgentChatStore.getState().loadSessions(backend.api)
  renderList(backend)
  expect(screen.getByRole('alert')).toHaveTextContent('会话暂时无法读取')
  expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试读取会话列表' }))
  await screen.findByText('暂无会话')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('刷新失败保留已有会话，重试成功更新列表并清除错误', async () => {
  const backend = chatTestApi()
  backend.api.listSessions.mockResolvedValueOnce({ items: [{ ...backend.session, title: '原会话' }], nextCursor: '', hasMore: false })
  await useAgentChatStore.getState().loadSessions(backend.api)
  renderList(backend)
  backend.api.listSessions.mockRejectedValueOnce(new Error('读取失败'))
  await act(async () => { await useAgentChatStore.getState().loadSessions(backend.api, false, false, true) })
  expect(screen.getByRole('button', { name: '原会话' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('会话暂时无法读取')
  expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
  backend.api.listSessions.mockResolvedValueOnce({ items: [{ ...backend.session, title: '恢复后的会话' }], nextCursor: '', hasMore: false })
  fireEvent.click(screen.getByRole('button', { name: '重试读取会话列表' }))
  await screen.findByRole('button', { name: '恢复后的会话' })
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

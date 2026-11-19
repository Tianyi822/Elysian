import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { beforeEach, expect, it, vi } from 'vitest'
import { agentChatLocalAdapter } from '../../adapters/local/agentChatLocalAdapter'
import { agentChatSessionKey } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { chatTestApi } from '../../test/agentChatFixtures'
import { ChatSessionList } from './ChatSessionList'

beforeEach(() => {
  useAgentChatStore.getState().clearDisplay()
  for (const row of agentChatLocalAdapter.list()) agentChatLocalAdapter.remove(agentChatSessionKey(row))
  useAgentChatStore.getState().clearDisplay()
})

function renderList(backend: ReturnType<typeof chatTestApi>, onRender?: ProfilerOnRenderCallback) {
  const list = <ChatSessionList onNew={() => {}} onSelect={() => {}}
    onRefresh={() => { void useAgentChatStore.getState().loadSessions(backend.api) }} onMore={() => {}} refreshing={false} />
  return render(<Tooltip.Provider>{onRender ? <Profiler id="chat-sessions" onRender={onRender}>{list}</Profiler> : list}</Tooltip.Provider>)
}

it('输入区错误不重渲染会话列表，草稿标题仍跟随输入', async () => {
  const backend = chatTestApi()
  await useAgentChatStore.getState().newSession()
  const rendered = vi.fn<ProfilerOnRenderCallback>()
  renderList(backend, rendered)
  expect(screen.getByRole('button', { name: '新会话', current: 'page' })).toBeInTheDocument()
  expect(rendered).toHaveBeenCalled()
  rendered.mockClear()

  act(() => useAgentChatStore.getState().reportInput('附件太大'))
  expect(rendered).not.toHaveBeenCalled()

  act(() => useAgentChatStore.getState().setDraft('待发送的草稿'))
  expect(screen.getByRole('button', { name: '待发送的草稿', current: 'page' })).toBeInTheDocument()
  expect(rendered).toHaveBeenCalled()
})

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
  await act(async () => { await useAgentChatStore.getState().loadSessions(backend.api, { userInitiated: true }) })
  expect(screen.getByRole('button', { name: '原会话' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('会话暂时无法读取')
  expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
  backend.api.listSessions.mockResolvedValueOnce({ items: [{ ...backend.session, title: '恢复后的会话' }], nextCursor: '', hasMore: false })
  fireEvent.click(screen.getByRole('button', { name: '重试读取会话列表' }))
  await screen.findByRole('button', { name: '恢复后的会话' })
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

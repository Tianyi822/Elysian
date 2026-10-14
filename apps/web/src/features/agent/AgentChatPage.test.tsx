import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { AgentHttpError } from '../../adapters/http/agent/agentShared'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { chatTestApi, chatTestModel } from '../../test/agentChatFixtures'
import { AgentChatPage } from './AgentChatPage'
import { ShellLayoutContext, useShellLayout } from '../../app/layout/ShellLayoutContext'

function TestShell({ children }: { children: ReactNode }) {
  const defaults = useShellLayout()
  const [open, setOpen] = useState(false)
  return <ShellLayoutContext.Provider value={{ ...defaults, conversationDrawerOpen: open,
    setConversationDrawerOpen: setOpen, openConversationDrawer: () => setOpen(true), closeConversationDrawer: () => setOpen(false) }}>
    {children}
  </ShellLayoutContext.Provider>
}

function renderChat(backend = chatTestApi(), initialEntry = '/agent', modelError?: string, models: (typeof chatTestModel)[] = [chatTestModel]) {
  const gateway = createMockGateway({ eventStream: 'memory' })
  gateway.agentConversation = backend.api
  const readModels = vi.spyOn(gateway.modelSettings, 'listModelServices').mockResolvedValue([{
    id: 'service-1', revision: 1, name: '测试服务', provider: 'openai-compatible', apiFormat: 'chat-completions',
    baseUrl: chatTestModel.baseUrl, active: true, hasCredential: true, models: models.map(model => ({ ...model, enabled: true })),
  }])
  if (modelError) readModels.mockRejectedValueOnce(new Error(modelError))
  const router = createMemoryRouter([{ path: '*', element: <Tooltip.Provider><GatewayProvider gateway={gateway}><TestShell><AgentChatPage /></TestShell></GatewayProvider></Tooltip.Provider> }], { initialEntries: [initialEntry] })
  const view = render(<RouterProvider router={router} />)
  return { ...view, ...backend, router, readModels }
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1100px)', media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
  }))
  await useAgentChatStore.getState().newSession()
})

describe('基本聊天界面', () => {
  it.each([
    ['相同错误只显示一次', '读取超时，请检查面板连接后重试'],
    ['不同错误保留各自原因', '模型目录读取失败'],
  ])('会话与模型同时读取失败：%s，共用重试入口', async (_name, modelError) => {
    const sessionError = '读取超时，请检查面板连接后重试'
    const backend = chatTestApi()
    backend.api.getSession.mockRejectedValue(new Error(sessionError))
    const { readModels } = renderChat(backend, '/agent?session=server-session', modelError)
    const retry = await screen.findByRole('button', { name: '重新读取会话和模型' })
    await waitFor(() => expect(retry).toBeEnabled())
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(sessionError)
    expect(within(alert).getAllByRole('button')).toHaveLength(1)
    expect(screen.getAllByText(sessionError, { exact: false })).toHaveLength(1)
    if (modelError !== sessionError) {
      expect(alert).toHaveTextContent(`会话：${sessionError}`)
      expect(alert).toHaveTextContent(`模型：${modelError}`)
    }

    let finishSession!: (session: typeof backend.session) => void
    backend.api.getSession.mockClear().mockReturnValue(new Promise(resolve => { finishSession = resolve }))
    readModels.mockClear()
    fireEvent.click(retry)
    await waitFor(() => expect(readModels).toHaveBeenCalledOnce())
    expect(backend.api.getSession).toHaveBeenCalledOnce()
    // 模型先恢复时，同一提示继续承载未完成的会话读取，防止重复点击。
    await waitFor(() => expect(retry).toHaveAccessibleName('重新读取会话'))
    expect(retry).toBeDisabled()
    expect(screen.getByRole('alert')).toBe(alert)
    await act(async () => { finishSession(backend.session) })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeEnabled()
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(backend.api.continueTask).not.toHaveBeenCalled()
  })

  it.each(['会话', '模型'] as const)('仅%s读取失败时只重试对应读取', async source => {
    const backend = chatTestApi()
    if (source === '会话') backend.api.getSession.mockRejectedValue(new Error('读取会话失败'))
    const { readModels } = renderChat(backend, '/agent?session=server-session', source === '模型' ? '读取模型失败' : undefined)
    const retry = await screen.findByRole('button', { name: `重新读取${source}` })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent(`读取${source}失败`)
    backend.api.getSession.mockClear().mockResolvedValue(backend.session)
    readModels.mockClear()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(backend.api.getSession).toHaveBeenCalledTimes(source === '会话' ? 1 : 0)
    expect(readModels).toHaveBeenCalledTimes(source === '模型' ? 1 : 0)
  })

  it('会话、新草稿与浏览器前进后退分别恢复原记录和输入', async () => {
    const backend = chatTestApi()
    const a = { ...backend.session, id: 'history-a', title: '历史 A' }
    const b = { ...backend.session, id: 'history-b', title: '历史 B' }
    backend.api.listSessions.mockResolvedValue({ items: [b, a], nextCursor: '', hasMore: false })
    backend.api.getSession.mockImplementation(async id => id === a.id ? a : b)
    const { router } = renderChat(backend, '/agent?session=history-a')
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe(a.id))
    fireEvent.click(within(screen.getByRole('region', { name: 'Ely 会话' })).getByRole('button', { name: '新会话' }))
    await waitFor(() => expect(router.state.location.state?.agentDraftId).toBe(useAgentChatStore.getState().session?.id))
    const draftId = useAgentChatStore.getState().session!.id
    expect(draftId).toMatch(/^draft:/)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留这份草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '历史 B' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe(b.id))
    expect(router.state.location.search).toBe('?session=history-b')
    await act(async () => { await router.navigate(-1) })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('保留这份草稿'))
    expect(useAgentChatStore.getState().session?.id).toBe(draftId)
    expect(router.state.location.search).toBe('')
    await act(async () => { await router.navigate(-1) })
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe(a.id))
    await act(async () => { await router.navigate(1) })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('保留这份草稿'))
    expect(useAgentChatStore.getState().session?.id).toBe(draftId)
    await act(async () => { await router.navigate(1) })
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe(b.id))
  })

  it('首次无参数打开的草稿记入当前历史项，返回时保留同一份草稿', async () => {
    const backend = chatTestApi()
    const { router } = renderChat(backend)
    await waitFor(() => expect(router.state.location.state?.agentDraftId).toBe(useAgentChatStore.getState().session?.id))
    const draftId = useAgentChatStore.getState().session!.id
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '首次进入的草稿' } })
    await act(async () => { await router.navigate('/agent?session=server-session') })
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    await act(async () => { await router.navigate(-1) })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('首次进入的草稿'))
    expect(useAgentChatStore.getState().session?.id).toBe(draftId)
  })

  it('模型菜单按模型 ID 列出，与设置页的「模型 ID」同一标识，服务名放副行', async () => {
    const user = userEvent.setup()
    renderChat()
    await user.click(await screen.findByRole('button', { name: '选择模型：test-model' }))
    const option = await screen.findByRole('menuitemradio', { name: 'test-model' })
    expect(option).toHaveTextContent('test-model')
    expect(option).toHaveTextContent('测试服务')
  })

  it('桌面边缘把手可反复开关会话栏，保留键盘焦点与展开状态', async () => {
    renderChat()
    const toggle = screen.getByRole('button', { name: '收起会话列表' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAccessibleName('打开会话列表')
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('complementary', { name: '会话列表' })).toBeInTheDocument()
    expect(toggle).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
  })

  it('窄屏边缘把手打开会话抽屉，关闭和 Escape 都归还焦点且不留下悬停提示', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
    }))
    const user = userEvent.setup()
    renderChat()
    const trigger = screen.getByRole('button', { name: '打开会话列表' })
    await user.click(trigger)
    const drawer = screen.getByRole('dialog', { name: '会话列表' })
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: '关闭会话列表' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    // Radix 的提示只在失焦或指针离开触发器时收起，指针不在把手上时程序化聚焦弹出的提示没人关。
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('运行未完成时已显示流式 Markdown，确认后原位衔接且不重复回答', async () => {
    const backend = chatTestApi()
    backend.hold()
    let emit!: Parameters<typeof backend.api.stream>[1]
    backend.api.stream.mockImplementation(async (_id, onOutput, signal) => {
      emit = onOutput
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '流式测试' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(backend.api.stream).toHaveBeenCalled())
    act(() => emit({ runId: 'run-1', responseId: 'm1', reasoning: '检查问题', content: '**先显示第一段**', done: false }))
    expect(await screen.findByText('先显示第一段')).toHaveProperty('tagName', 'STRONG')
    expect(useAgentChatStore.getState().run?.status).toBe('running')
    expect(useAgentChatStore.getState().messages).toHaveLength(1)
    const article = screen.getByRole('article', { name: '助手回复' })
    expect(article.parentElement).toHaveClass('chat-response')
    expect(article.parentElement?.querySelector('.chat-thought')).not.toBeNull()
    act(() => emit({ runId: 'run-1', responseId: 'm1', reasoning: '检查问题', content: '**先显示第一段**\n\n接着显示第二段', done: false }))
    expect(await screen.findByText('接着显示第二段')).toBeInTheDocument()
    backend.complete('**先显示第一段**\n\n接着显示第二段')
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(screen.getAllByRole('article', { name: '助手回复' })).toHaveLength(1)
    expect(screen.getByRole('article', { name: '助手回复' })).toBe(article)
  })

  it('运行中切到其他会话释放输出流，切回后以原运行重连并衔接内容', async () => {
    const backend = chatTestApi()
    backend.hold()
    const watches: { runId: string; onOutput: Parameters<typeof backend.api.stream>[1]; signal: AbortSignal }[] = []
    backend.api.stream.mockImplementation(async (id, onOutput, signal) => {
      watches.push({ runId: id, onOutput, signal })
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const sessionA = { ...backend.session, title: '会话 A' }
    const historyB = { ...backend.session, id: 'history-b', title: '历史 B', activeRunId: undefined }
    backend.api.listSessions.mockResolvedValue({ items: [historyB, sessionA], nextCursor: '', hasMore: false })
    backend.api.getSession.mockImplementation(async id => id === 'history-b' ? historyB : { ...backend.session })
    backend.api.listTasks.mockImplementation(async id => id === 'history-b'
      ? { items: [], nextCursor: '', hasMore: false }
      : { items: [{ id: 'task-1', sessionId: 'server-session', kind: 'agent' }], nextCursor: '', hasMore: false })
    renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '检查服务' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(watches).toHaveLength(1))
    expect(watches[0]!.runId).toBe('run-1')
    // 切到空闲会话：原会话的输出流订阅随展示释放断开，运行仍在服务端继续。
    fireEvent.click(screen.getByRole('button', { name: '历史 B' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('history-b'))
    await waitFor(() => expect(watches[0]!.signal.aborted).toBe(true))
    expect(watches).toHaveLength(1)
    // 切回运行中的会话：以原 Run 重新订阅，快照增量原位衔接、不重复用户消息。
    fireEvent.click(screen.getByRole('button', { name: '会话 A' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    await waitFor(() => expect(watches).toHaveLength(2))
    expect(watches[1]!.runId).toBe('run-1')
    await waitFor(() => expect(useAgentChatStore.getState().run?.id).toBe('run-1'))
    act(() => watches[1]!.onOutput({ runId: 'run-1', responseId: 'm1', reasoning: '继续排查', content: '重连后的回答', done: false }))
    expect(await screen.findByText('重连后的回答')).toBeInTheDocument()
    expect(screen.getAllByText('检查服务')).toHaveLength(1)
  })

  it('选择模型声明的思考等级并随消息提交，运行时锁定选择', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    backend.hold()
    renderChat(backend)
    // 选择器不提供「默认」项，未选择时落到模型声明的默认档（声明含「高」，优先取「高」）。
    const selector = await screen.findByRole('button', { name: '选择思考等级：高' })
    await waitFor(() => expect(selector).toBeEnabled())
    await user.click(selector)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['关闭', '低', '高', '最高'])
    await user.click(screen.getByRole('menuitemradio', { name: '高' }))
    expect(useAgentChatStore.getState().session?.reasoningLevel).toBe('high')
    await user.type(screen.getByRole('textbox'), '检查状态')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({ reasoningLevel: 'high' })))
    expect(screen.getByRole('button', { name: '选择思考等级：高' })).toBeDisabled()
  })

  it('未声明思考档位的模型不显示思考等级选择器', async () => {
    const backend = chatTestApi()
    renderChat(backend, '/agent', undefined, [{ ...chatTestModel, capabilities: { ...chatTestModel.capabilities, reasoningLevels: [] } }])
    await waitFor(() => expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /选择思考等级/ })).not.toBeInTheDocument()
  })

  it('切换模型把旧选择重置为新模型声明的默认档', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    const other = { ...chatTestModel, id: 'model-2', model: 'other-model', capabilities: { ...chatTestModel.capabilities, reasoningLevels: ['low', 'medium'] } }
    renderChat(backend, '/agent', undefined, [chatTestModel, other])
    const selector = await screen.findByRole('button', { name: '选择思考等级：高' })
    await waitFor(() => expect(selector).toBeEnabled())
    await user.click(selector)
    await user.click(screen.getByRole('menuitemradio', { name: '低' }))
    expect(useAgentChatStore.getState().session?.reasoningLevel).toBe('low')
    await user.click(screen.getByRole('button', { name: '选择模型：test-model' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'other-model' }))
    // 旧选择「低」在新模型里仍有效，但切换仍重置为新模型的默认档（新模型未声明「高」，取 medium）。
    await waitFor(() => expect(useAgentChatStore.getState().session?.reasoningLevel).toBe('medium'))
    expect(screen.getByRole('button', { name: '选择思考等级：中' })).toBeInTheDocument()
  })

  it('用户消息与助手回复各带复制按钮，点击复制原文', async () => {
    const user = userEvent.setup()
    renderChat()
    await user.type(screen.getByRole('textbox', { name: '发送给 Ely 的消息' }), '检查容器状态')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('article', { name: '助手回复' })
    // 一轮对话只有两枚复制按钮：用户消息与助手回复各一，思考过程与工具调用不提供复制。
    expect(screen.getAllByRole('button', { name: /复制/ })).toHaveLength(2)
    // 提示浮层固定在图标下方，不遮挡上方气泡内容（点击后 Radix 会先关闭提示，故在点击前断言）。
    await user.hover(screen.getByRole('button', { name: '复制这条消息' }))
    expect(await screen.findByRole('tooltip')).toHaveAttribute('data-side', 'bottom')
    await user.click(screen.getByRole('button', { name: '复制这条消息' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('检查容器状态')
    await user.click(screen.getByRole('button', { name: '复制回复内容' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('你好，我是 Ely。')
  })

  it('输入法确认和 Shift+Enter 不发送，Enter 发送并显示模型答复，追问保留上下文', async () => {
    const { api } = renderChat()
    const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
    fireEvent.change(textbox, { target: { value: '你好' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(api.createTask).not.toHaveBeenCalled()
    fireEvent.compositionEnd(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(api.createTask).not.toHaveBeenCalled()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(await screen.findByText('你好，我是 Ely。')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: '你的消息' })).toHaveTextContent('你好')
    await waitFor(() => expect(textbox).toHaveValue(''))
    fireEvent.change(textbox, { target: { value: '继续聊' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(api.continueTask).toHaveBeenCalledOnce())
    expect(api.createSession).toHaveBeenCalledOnce()
  })

  it('等待模型回复时禁用重复发送，轮询完成后展示回复', async () => {
    const backend = chatTestApi()
    backend.hold()
    const view = renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(useAgentChatStore.getState().run?.status).toBe('running'))
    expect(screen.queryByText(/Ely 正在|正在整理会话|正在发送/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeDisabled()
    vi.useFakeTimers()
    try {
      // 返回页面会重新读取；在可控定时器下检查后续轮询。
      view.unmount()
      renderChat(backend)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      backend.reasoning.set('run-1', '先确认问题的范围。\n结合已有条件比较方案。')
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      const thought = screen.getByRole('button', { name: '展开思考内容' })
      expect(thought).toHaveTextContent('结合已有条件比较方案。')
      expect(thought).not.toHaveTextContent('先确认问题的范围。')
      expect(screen.queryByRole('region', { name: '思考内容' })).not.toBeInTheDocument()
      fireEvent.click(thought)
      expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('先确认问题的范围。')
      backend.reasoning.set('run-1', '先确认问题的范围。\n结合已有条件比较方案。\n已选出适合的方案。')
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('已选出适合的方案。')
      backend.complete('等待后的回复')
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(screen.getByText('等待后的回复')).toBeInTheDocument()
      expect(screen.getByRole('region', { name: '思考内容' })).toBeInTheDocument()
      expect(screen.queryByText(/Ely 正在|正在整理会话|正在发送/)).not.toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('模型请求失败时显示错误并保留输入，不伪造助手消息', async () => {
    const backend = chatTestApi()
    backend.api.createSession.mockRejectedValueOnce(new Error('模型服务不可用'))
    renderChat(backend)
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: '你好' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型服务不可用')
    expect(textbox).toHaveValue('你好')
    expect(screen.queryByRole('article', { name: '助手回复' })).not.toBeInTheDocument()
  })

  it('异步出现的思考跟随聊天底部，手动上滚阅读后不抢走位置', async () => {
    const backend = chatTestApi()
    backend.hold()
    const view = renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续分析' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('article', { name: '你的消息' })
    const history = view.container.querySelector<HTMLDivElement>('.chat-history')!
    let height = 900
    Object.defineProperties(history, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } })
    history.scrollTop = 500
    fireEvent.scroll(history)

    height = 950
    backend.reasoning.set('run-1', '新出现的思考')
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    await waitFor(() => expect(screen.getByRole('button', { name: '展开思考内容' })).toHaveTextContent('新出现的思考'))
    expect(history.scrollTop).toBe(950)

    history.scrollTop = 100
    fireEvent.scroll(history)
    backend.reasoning.set('run-1', '新出现的思考\n更新的思考')
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(history.scrollTop).toBe(100)
    history.scrollTop = 550
    fireEvent.scroll(history)
    height = 1000
    backend.reasoning.set('run-1', '新出现的思考\n更新的思考\n继续更新')
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(history.scrollTop).toBe(1000)
  })

  it('权限菜单可选择并恢复本地偏好，明确标注自动审批仍为预览', async () => {
    const user = userEvent.setup()
    const view = renderChat()
    await waitFor(() => expect(screen.getByRole('button', { name: '选择思考等级：高' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '权限模式：请求批准' }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    expect(screen.getByRole('menuitemradio', { name: '完全开放' })).toHaveAccessibleDescription('免逐项审批暂未接入，目前仅保存选择。')
    await user.click(screen.getByRole('menuitemradio', { name: '帮我批准' }))
    expect(useAgentChatStore.getState().session?.permissionMode).toBe('assist')
    expect(screen.getByText('预览')).toBeInTheDocument()
    view.unmount()
    renderChat()
    expect(screen.getByRole('button', { name: '权限模式：帮我批准' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '权限模式：帮我批准' }))
    await user.click(screen.getByRole('menuitemradio', { name: '请求批准' }))
    expect(screen.queryByText('预览')).not.toBeInTheDocument()
  })

  it('附件按钮打开文件选择，可添加、移除并重新选择同一文件，明确本地附件尚未发送', async () => {
    const user = userEvent.setup()
    const { api } = renderChat()
    const picker = screen.getByLabelText('选择附件') as HTMLInputElement
    const openPicker = vi.spyOn(picker, 'click')
    await user.click(screen.getByRole('button', { name: '添加附件' }))
    expect(openPicker).toHaveBeenCalledOnce()
    const file = new File(['聊天附件测试'], 'note.txt', { type: 'text/plain' })
    await user.upload(picker, file)
    expect(await screen.findByText('note.txt')).toBeInTheDocument()
    expect(picker.value).toBe('')
    expect(screen.getByText('附件仅保存在本地，暂未接入模型；请移除附件后发送文本。')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), '读取附件')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    expect(api.createTask).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '移除附件 note.txt' }))
    expect(screen.queryByText('note.txt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await user.upload(picker, file)
    expect(await screen.findByText('note.txt')).toBeInTheDocument()
  })
})

describe('会话列表编辑入口', () => {
  const longTitle = '这是一条足够长的会话标题，列表内会被截断，完整名称经右侧弹窗展示'

  function setupSessions(backend = chatTestApi()) {
    const current = { ...backend.session, id: 'server-session', title: longTitle }
    const other = { ...backend.session, id: 'history-b', title: '历史 B' }
    // 列表与删除做成有状态：删除后的会话不再回到列表，模拟服务端事实。
    const deleted = new Set<string>()
    backend.api.listSessions.mockImplementation(async () => ({
      items: [current, other].filter(row => !deleted.has(row.id)), nextCursor: '', hasMore: false,
    }))
    backend.api.deleteSession.mockImplementation(async (id: string) => { deleted.add(id) })
    backend.api.getSession.mockImplementation(async (id: string) => id === 'history-b' ? other : current)
    const view = renderChat(backend, '/agent?session=server-session')
    return { ...view, backend, current, other }
  }

  it('编辑入口只出现在服务端会话行上，纯草稿行不渲染', async () => {
    setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    expect(screen.getAllByRole('button', { name: '编辑会话' })).toHaveLength(2)
    fireEvent.click(within(screen.getByRole('region', { name: 'Ely 会话' })).getByRole('button', { name: '新会话' }))
    await waitFor(() => expect(useAgentChatStore.getState().session?.id).toMatch(/^draft:/))
    // 新草稿行加入列表后编辑入口数量不变：编辑入口不落在纯草稿行。
    // （此前用例的本地草稿会累积在 localStorage，行数不定，编辑入口只随服务端行数变化。）
    expect(screen.getAllByRole('button', { name: '编辑会话' })).toHaveLength(2)
    const draftItem = document.querySelector('.chat-session-row[aria-current]')?.closest('.chat-session-item')
    expect(draftItem).not.toBeNull()
    expect(draftItem!.querySelector('.chat-session-edit')).toBeNull()
  })

  it('完整名称弹窗在 hover 与键盘聚焦两路可见，Tab 可达行按钮与编辑按钮', async () => {
    const user = userEvent.setup()
    setupSessions()
    const row = await screen.findByRole('button', { name: longTitle })
    // 指针路径：悬停行按钮弹出完整标题（图标显隐是纯 CSS 行为，jsdom 不计算样式，此处只验证触发器与弹窗）。
    await user.hover(row)
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(longTitle))
    // 键盘路径：Tab 走到行按钮，同一触发器经 focus 打开弹窗；再 Tab 落到编辑按钮（focus-within 揭示）。
    for (let i = 0; i < 12 && document.activeElement !== row; i += 1) await user.tab()
    expect(row).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(longTitle))
    await user.tab()
    expect(screen.getAllByRole('button', { name: '编辑会话' })[0]).toHaveFocus()
  })

  it('编辑菜单向下弹出，不与行右侧的完整名称弹窗同位', async () => {
    const user = userEvent.setup()
    setupSessions()
    const row = await screen.findByRole('button', { name: longTitle })
    await user.hover(row)
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(longTitle))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    // 行右侧留给完整名称弹窗，菜单挂在编辑图标下方、右缘对齐。
    expect(await screen.findByRole('menu')).toHaveAttribute('data-side', 'bottom')
  })

  it('编辑菜单重命名会话：空值与超长先挡，成功后列表行与页头标题即时更新', async () => {
    const user = userEvent.setup()
    const { backend } = setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const dialog = await screen.findByRole('dialog', { name: '重命名会话' })
    const input = within(dialog).getByRole('textbox', { name: '会话名称' })
    expect(input).toHaveValue(longTitle)
    await user.clear(input)
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('名称不能为空')
    expect(backend.api.renameSession).not.toHaveBeenCalled()
    await user.type(input, 'x'.repeat(201))
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('标题不能超过 200 字节')
    expect(backend.api.renameSession).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, '  新标题  ')
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    await waitFor(() => expect(backend.api.renameSession).toHaveBeenCalledExactlyOnceWith('server-session', { title: '新标题' }))
    // 弹窗关闭，列表行与页头标题以服务端落库值（TrimSpace 后）展示。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名会话' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '新标题' })).toBeInTheDocument())
    expect(document.querySelector('.chat-title')).toHaveTextContent('新标题')
    expect(screen.queryByRole('button', { name: longTitle })).not.toBeInTheDocument()
  })

  it('重命名被服务端拒绝时错误行内透传，弹窗保留可重试，列表不动', async () => {
    const user = userEvent.setup()
    const { backend } = setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    backend.api.renameSession.mockRejectedValueOnce(new AgentHttpError('会话标题不能为空', 'invalid-title', 400))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const dialog = await screen.findByRole('dialog', { name: '重命名会话' })
    const input = within(dialog).getByRole('textbox', { name: '会话名称' })
    await user.clear(input)
    await user.type(input, '服务端拒绝的名字')
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('会话标题不能为空')
    expect(document.querySelector('.chat-title')).toHaveTextContent(longTitle)
    await user.clear(input)
    await user.type(input, '最终名字')
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    await waitFor(() => expect(document.querySelector('.chat-title')).toHaveTextContent('最终名字'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('删除会话：先删当前回落到剩余会话，再删最后一个回落到空白草稿，均出 notice', async () => {
    const user = userEvent.setup()
    const { backend, router } = setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    // 删除当前会话：确认弹窗点名会话与不可恢复后果，确认后切到剩余会话。
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }))
    const confirm = await screen.findByRole('dialog', { name: `删除会话「${longTitle}」？` })
    expect(confirm).toHaveTextContent('删除后该会话的聊天记录与运行历史将一并清除，且不可恢复。')
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(backend.api.deleteSession).toHaveBeenCalledExactlyOnceWith('server-session'))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('history-b'))
    expect(screen.getByRole('status')).toHaveTextContent('会话已删除，已切换到其他会话。')
    await waitFor(() => expect(router.state.location.search).toBe('?session=history-b'))
    expect(screen.queryByRole('button', { name: longTitle })).not.toBeInTheDocument()
    // 删除最后一个会话：回落到空白草稿，URL 清空。
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }))
    await user.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(backend.api.deleteSession).toHaveBeenCalledTimes(2))
    expect(backend.api.deleteSession).toHaveBeenNthCalledWith(2, 'history-b')
    await waitFor(() => expect(useAgentChatStore.getState().session?.remote).toBeUndefined())
    expect(screen.getByRole('status')).toHaveTextContent('会话已删除，已新建空白会话。')
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.queryByRole('button', { name: '历史 B' })).not.toBeInTheDocument()
  })

  it('删除被服务端拒绝时不做本地清理，错误文案在确认弹窗内行内透传', async () => {
    const user = userEvent.setup()
    const message = '会话存在结果未确认的执行（如面板重启时的在途操作），暂不能删除；需经执行对账接口确认停止后解除'
    const { backend } = setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    backend.api.deleteSession.mockRejectedValueOnce(new AgentHttpError(message, 'session-unresolved', 409))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }))
    await user.click(await screen.findByRole('button', { name: '确认删除' }))
    const dialog = await screen.findByRole('dialog', { name: `删除会话「${longTitle}」？` })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message)
    // 弹窗打开时页面被 aria-hidden，行仍在用 DOM 断言；会话指针未动。
    expect([...document.querySelectorAll('.chat-session-row')].some(row => row.textContent?.includes(longTitle))).toBe(true)
    expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session')
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('history-b'))
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('会话运行中时删除项禁用并说明原因', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    const running = { ...backend.session, id: 'running-session', title: '运行中会话', activeRunId: 'run-x' }
    backend.api.listSessions.mockResolvedValue({ items: [running], nextCursor: '', hasMore: false })
    backend.api.getSession.mockResolvedValue({ ...running })
    renderChat(backend, '/agent?session=running-session')
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('running-session'))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    const item = await screen.findByRole('menuitem', { name: /删除会话/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('会话运行中或执行结果未确认时不能删除')
    await user.click(screen.getByRole('menuitem', { name: '重命名' }))
    // 运行中仍可改名：标题是纯展示字段。
    expect(await screen.findByRole('dialog', { name: '重命名会话' })).toBeInTheDocument()
    expect(backend.api.deleteSession).not.toHaveBeenCalled()
  })
})

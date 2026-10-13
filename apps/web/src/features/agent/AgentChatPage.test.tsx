import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { chatTestApi, chatTestModel } from '../../test/agentChatFixtures'
import { AgentChatPage } from './AgentChatPage'

function renderChat(backend = chatTestApi(), initialEntry = '/agent') {
  const gateway = createMockGateway({ eventStream: 'memory' })
  gateway.agentConversation = backend.api
  vi.spyOn(gateway.modelSettings, 'listModelServices').mockResolvedValue([{
    id: 'service-1', revision: 1, name: '测试服务', provider: 'openai-compatible', apiFormat: 'chat-completions',
    baseUrl: chatTestModel.baseUrl, active: true, hasCredential: true, models: [{ ...chatTestModel, enabled: true }],
  }])
  const router = createMemoryRouter([{ path: '*', element: <Tooltip.Provider><GatewayProvider gateway={gateway}><AgentChatPage /></GatewayProvider></Tooltip.Provider> }], { initialEntries: [initialEntry] })
  const view = render(<RouterProvider router={router} />)
  return { ...view, ...backend, router }
}

beforeEach(async () => { await useAgentChatStore.getState().newSession() })

describe('基本聊天界面', () => {
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

  it('桌面收起会话栏后将键盘焦点交还打开入口', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: '收起会话列表' }))
    expect(screen.getByRole('button', { name: '打开会话列表' })).toHaveFocus()
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
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

  it('选择模型声明的思考等级并随消息提交，运行时锁定选择', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    backend.hold()
    renderChat(backend)
    const selector = await screen.findByRole('button', { name: '选择思考等级：默认' })
    await waitFor(() => expect(selector).toBeEnabled())
    await user.click(selector)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['默认', '关闭', '低', '高', '最高'])
    await user.click(screen.getByRole('menuitemradio', { name: '高' }))
    expect(useAgentChatStore.getState().session?.reasoningLevel).toBe('high')
    await user.type(screen.getByRole('textbox'), '检查状态')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({ reasoningLevel: 'high' })))
    expect(screen.getByRole('button', { name: '选择思考等级：高' })).toBeDisabled()
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
    expect(screen.getByRole('button', { name: '选择模型：测试模型' })).toBeDisabled()
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
    await waitFor(() => expect(screen.getByRole('button', { name: '选择思考等级：默认' })).toBeEnabled())
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

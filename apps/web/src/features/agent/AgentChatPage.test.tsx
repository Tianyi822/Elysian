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
import { useNotificationStore } from '../../stores/notificationStore'
import { agentChatLocalAdapter } from '../../adapters/local/agentChatLocalAdapter'
import { agentChatSessionKey } from '../../contracts/agentChat'
import { NotificationHost } from '../../components/NotificationHost'
import { chatTestApi, chatTestUserInput, chatTestCacheHitUsage, chatTestContextUsage, chatTestModel, chatTestUsage, chatVisionTestModel } from '../../test/agentChatFixtures'
import type { AgentRunPlan, AgentChatOutput } from '@elysian/contracts'
import { AgentChatPage } from './AgentChatPage'
import { ShellLayoutContext, useShellLayout } from '../../app/layout/ShellLayoutContext'

vi.mock('../../adapters/local/agentImagePreparation', () => ({ prepareAgentImage: vi.fn(async (file: File) => file) }))

function TestShell({ children }: { children: ReactNode }) {
  const defaults = useShellLayout()
  const [open, setOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  return <ShellLayoutContext.Provider value={{ ...defaults, sidebarCollapsed, setSidebarCollapsed, conversationDrawerOpen: open,
    setConversationDrawerOpen: setOpen, openConversationDrawer: () => setOpen(true), closeConversationDrawer: () => setOpen(false) }}>
    <div data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}>
      {/* 模拟主导航自身的收展入口与状态回显，验证聊天页不与会话栏互相联动。 */}
      <button type="button" hidden data-testid="test-nav-toggle" onClick={() => setSidebarCollapsed(value => !value)}>切换主导航收展</button>
      {children}
    </div>
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
  const router = createMemoryRouter([{ path: '*', element: <Tooltip.Provider><GatewayProvider gateway={gateway}><TestShell><AgentChatPage /></TestShell><NotificationHost /></GatewayProvider></Tooltip.Provider> }], { initialEntries: [initialEntry] })
  const view = render(<RouterProvider router={router} />)
  return { ...view, ...backend, router, readModels, gateway }
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1100px)', media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
  }))
  useAgentChatStore.getState().clearDisplay()
  for (const row of agentChatLocalAdapter.list()) agentChatLocalAdapter.remove(agentChatSessionKey(row))
  useNotificationStore.getState().clear()
  await useAgentChatStore.getState().newSession()
})

describe('基本聊天界面', () => {
  it.each(['failed', 'interrupted', 'cancelled'] as const)('历史 %s 由快照恢复正式结果，消息回读不重复，编辑重发移除旧结果', async status => {
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'runtime-failure', content: '请查看这个网站' })
    const run = backend.runs.get('run-1')!
    run.status = status
    run.error = { code: 'execution-unavailable', message: '执行容器通道不可用' }
    backend.session.activeRunId = undefined
    const content = '本轮任务未能完成。\n\n原因：执行容器通道不可用'
    backend.timelines.set('run-1', { runId: 'run-1', status, done: true, entries: [], terminalResult: { origin: 'runtime', content } })
    const initial = renderChat(backend, '/agent?session=server-session')
    expect(await screen.findByRole('article', { name: '运行结果' })).toHaveTextContent('原因：执行容器通道不可用')
    backend.messages.push({ ...backend.messages[0]!, id: 'runtime-answer', seq: '2', role: 'assistant', origin: 'runtime', content })
    backend.session.lastSeq = '2'
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(screen.getAllByRole('article', { name: '运行结果' })).toHaveLength(1)
    initial.unmount()
    useAgentChatStore.getState().clearDisplay()
    renderChat(backend, '/agent?session=server-session')
    expect(await screen.findByRole('article', { name: '运行结果' })).toHaveTextContent('原因：执行容器通道不可用')
    const edit = screen.getByRole('button', { name: '编辑这条消息' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    fireEvent.change(screen.getByRole('textbox', { name: '编辑消息内容' }), { target: { value: '重新检查网站' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('重新检查网站')
    expect(screen.queryByRole('article', { name: '运行结果' })).not.toBeInTheDocument()
    expect(backend.api.createTask).toHaveBeenCalledTimes(1)
    expect(backend.api.continueTask).toHaveBeenCalledTimes(1)
  })
  it('HTTP IP 环境可新建会话并输入中文、符号和多行文本后发送', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    try {
      useAgentChatStore.getState().clearDisplay()
      await useAgentChatStore.getState().newSession()
      const user = userEvent.setup()
      const { api } = renderChat()
      const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
      await waitFor(() => expect(textbox).toBeEnabled())
      await user.click(textbox)
      await user.paste('中文 👋\n`code` <tag> & "引号"')
      expect(textbox).toHaveValue('中文 👋\n`code` <tag> & "引号"')
      await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
      await user.click(screen.getByRole('button', { name: '发送消息' }))
      await waitFor(() => expect(api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({ content: '中文 👋\n`code` <tag> & "引号"', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })))
    } finally { vi.unstubAllGlobals() }
  })

  it('会话初始化异常通过通知提示，可原位重试恢复输入', async () => {
    useAgentChatStore.getState().clearDisplay()
    const originalInitialize = useAgentChatStore.getState().initialize
    const initialize = vi.spyOn(useAgentChatStore.getState(), 'initialize').mockRejectedValueOnce(new Error('本地会话读取失败'))
    let view: ReturnType<typeof renderChat> | undefined
    try {
      view = renderChat()
      await screen.findByText('会话初始化失败：本地会话读取失败')
      expect(screen.getByRole('textbox', { name: '发送给 Ely 的消息' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '重新初始化会话' }))
      await waitFor(() => expect(screen.getByRole('textbox', { name: '发送给 Ely 的消息' })).toBeEnabled())
    } finally { view?.unmount(); initialize.mockRestore(); useAgentChatStore.setState({ initialize: originalInitialize }) }
  })

  it('文本文件从选择入口读入草稿，发送完整内容且不调用图片上传', async () => {
    const user = userEvent.setup()
    const { api } = renderChat()
    const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled())
    await user.upload(screen.getByLabelText('选择文件'), new File(['中文\nconst a = "代码";'], 'notes.md', { type: 'text/markdown' }))
    await waitFor(() => expect(textbox).toHaveValue('文件："notes.md"\n中文\nconst a = "代码";'))
    expect(screen.getByText('已将 1 个文本文件读入草稿，可编辑后发送。')).toBeInTheDocument()
    expect(api.uploadAttachments).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(api.createTask.mock.lastCall?.[1].content).toBe('文件："notes.md"\n中文\nconst a = "代码";'))
  })

  it('粘贴图片连同文字保留插入位置，图片随正文发送', async () => {
    const backend = chatTestApi()
    renderChat(backend, '/agent', undefined, [chatVisionTestModel])
    await screen.findByRole('button', { name: `选择模型：${chatVisionTestModel.model}` })
    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled())
    const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' }) as HTMLTextAreaElement
    fireEvent.change(textbox, { target: { value: '前后' } })
    textbox.setSelectionRange(1, 1)
    fireEvent.paste(textbox, { clipboardData: { files: [new File(['png'], 'clipboard.png', { type: 'image/png' })], getData: () => '说明' } })
    await screen.findByText('clipboard.png')
    expect(textbox).toHaveValue('前说明后')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({ content: '前说明后', attachments: [{ id: 'server-attachment-1' }] })))
  })

  it('拖放混合文件统一处理，不支持格式和文件夹显示通知且保留草稿', async () => {
    const backend = chatTestApi()
    renderChat(backend, '/agent', undefined, [chatVisionTestModel])
    await screen.findByRole('button', { name: `选择模型：${chatVisionTestModel.model}` })
    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled())
    const form = screen.getByRole('form', { name: '消息输入框' })
    const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
    fireEvent.change(textbox, { target: { value: '原草稿' } })
    fireEvent.drop(form, { dataTransfer: { files: [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })], types: ['Files'] } })
    await screen.findByText(/不支持这些文件：report.pdf/)
    expect(textbox).toHaveValue('原草稿')
    fireEvent.drop(form, { dataTransfer: { files: [], types: ['Files'] } })
    await screen.findByText('无法添加文件夹，请选择具体文件。')
    fireEvent.drop(form, { dataTransfer: { files: [new File(['诊断日志'], 'server.log'), new File(['png'], 'dropped.png', { type: 'image/png' })], types: ['Files'] } })
    await screen.findByText('dropped.png')
    expect(textbox).toHaveValue('原草稿\n\n文件："server.log"\n诊断日志')
    expect(backend.api.uploadAttachments.mock.lastCall?.[0]).toHaveLength(1)
  })

  it('只添加图片时提示补充问题，重发编辑中粘贴文件会明确拒绝', async () => {
    const backend = chatTestApi()
    renderChat(backend, '/agent', undefined, [chatVisionTestModel])
    await screen.findByRole('button', { name: `选择模型：${chatVisionTestModel.model}` })
    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled())
    fireEvent.paste(screen.getByRole('textbox', { name: '发送给 Ely 的消息' }), { clipboardData: { files: [new File(['png'], 'only.png', { type: 'image/png' })], getData: () => '' } })
    await screen.findByText('已添加 1 张图片，请输入问题或说明后发送。')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '发送给 Ely 的消息' }), { target: { value: '看图' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    const edit = await screen.findByRole('button', { name: '编辑这条消息' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    fireEvent.paste(screen.getByRole('textbox', { name: '编辑消息内容' }), { clipboardData: { files: [new File(['png'], 'new.png', { type: 'image/png' })], getData: () => '' } })
    await screen.findByText('编辑消息时仅可修改文本，请完成编辑后再添加文件。')
    expect(backend.api.uploadAttachments).toHaveBeenCalledTimes(1)
  })


  it('最后一条消息原位编辑、取消及重发，不覆盖底部草稿', async () => {
    const backend = chatTestApi()
    await backend.api.createTask('server-session', { requestId: 'original', content: '原消息' })
    renderChat(backend, '/agent?session=server-session')
    const edit = await screen.findByRole('button', { name: '编辑这条消息' })
    await waitFor(() => expect(edit).toBeEnabled())
    const composer = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
    fireEvent.change(composer, { target: { value: '底部草稿' } })
    fireEvent.click(edit)
    const editor = screen.getByRole('textbox', { name: '编辑消息内容' })
    expect(editor).toHaveFocus()
    fireEvent.change(editor, { target: { value: '' } })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }))
    expect(composer).toHaveValue('底部草稿')
    expect(screen.getByText('原消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑这条消息' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑消息内容' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '编辑消息内容' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑这条消息' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '取消编辑' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '编辑消息内容' })).not.toBeInTheDocument()
    expect(composer).toHaveValue('底部草稿')
    fireEvent.click(screen.getByRole('button', { name: '编辑这条消息' }))
    const nextEditor = screen.getByRole('textbox', { name: '编辑消息内容' })
    fireEvent.change(nextEditor, { target: { value: '改后的消息' } })
    fireEvent.compositionStart(nextEditor)
    fireEvent.keyDown(nextEditor, { key: 'Escape' })
    expect(nextEditor).toBeInTheDocument()
    fireEvent.keyDown(nextEditor, { key: 'Enter' })
    expect(backend.api.continueTask).not.toHaveBeenCalled()
    fireEvent.compositionEnd(nextEditor)
    backend.hold()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('改后的消息')
    expect(screen.queryByText('原消息')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('助手回复')).not.toBeInTheDocument()
    expect(composer).toHaveValue('底部草稿')
    expect(screen.getByRole('button', { name: '编辑这条消息' })).toBeDisabled()
  })

  it('回复期间提供停止按钮，服务端确认后显示已停止并允许编辑', async () => {
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'running', content: '请回答' })
    renderChat(backend, '/agent?session=server-session')
    const stop = await screen.findByRole('button', { name: '停止回复' })
    let resolve!: (run: Awaited<ReturnType<typeof backend.api.cancelRun>>) => void
    const cancel = backend.api.cancelRun.getMockImplementation()!
    backend.api.cancelRun.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    fireEvent.click(stop)
    expect(screen.getByRole('button', { name: '正在停止' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '编辑这条消息' })).toBeDisabled()
    await act(async () => { resolve(await cancel('run-1')) })
    await screen.findByText('已停止')
    expect(screen.getByRole('button', { name: '编辑这条消息' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeInTheDocument()
  })

  it.each(['succeeded', 'cancelled'] as const)('历史 %s 的空条目时间线在输入区提供用量，回复与停止标记各保留一次', async status => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'usage-only', content: '此前的问题' })
    if (status === 'succeeded') backend.complete('已确认的最终答复')
    else {
      backend.runs.get('run-1')!.status = status
      backend.session.activeRunId = undefined
    }
    backend.timelines.set('run-1', { runId: 'run-1', status, done: true, entries: [], usage: chatTestUsage, contextUsage: chatTestContextUsage, cacheHitUsage: chatTestCacheHitUsage })
    renderChat(backend, '/agent?session=server-session')
    await waitFor(() => expect(useAgentChatStore.getState().timelines['run-1']).toMatchObject({ usage: chatTestUsage }))
    const usage = screen.getByRole('button', { name: '上下文用量' })
    expect(usage.closest('.chat-composer-tools')).not.toBeNull()
    expect(screen.queryByText(/tokens 13,364|缓存 8,210/)).not.toBeInTheDocument()
    await user.hover(usage)
    const details = within(await screen.findByRole('dialog', { name: '上下文用量明细' }))
    expect(details.getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    expect(details.getByText('13,364')).toBeInTheDocument()
    expect(details.getByText('8,210')).toBeInTheDocument()
    expect(details.getByText('82.1%')).toBeInTheDocument()
    expect(details.getByText('平均缓存命中率')).toBeInTheDocument()
    expect(details.getByText('≈ 6,500')).toBeInTheDocument()
    expect(details.getByText('65.0%')).toBeInTheDocument()
    expect(details.queryByText('缓存占总量')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
    if (status === 'succeeded') {
      expect(screen.getAllByText('已确认的最终答复')).toHaveLength(1)
      expect(screen.getAllByRole('article', { name: '助手回复' })).toHaveLength(1)
    } else expect(screen.getAllByText('已停止')).toHaveLength(1)
  })

  it('输入区用量只取当前聊天 Run，切换下轮模型仍使用已完成推理的模型与上下文容量', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    await backend.api.createTask('server-session', { requestId: 'old-usage', content: '旧问题' })
    await backend.api.continueTask('task-1', { requestId: 'latest-usage', content: '新问题' })
    backend.timelines.set('run-1', { runId: 'run-1', status: 'succeeded', done: true, entries: [], usage: { calls: 0, resultBytes: 0, actualTokens: 99999, cachedTokens: 88888 }, contextUsage: { ...chatTestContextUsage, model: 'old-model', totalTokens: 90000 } })
    backend.timelines.set('run-2', { runId: 'run-2', status: 'succeeded', done: true, entries: [], usage: chatTestUsage, contextUsage: chatTestContextUsage, cacheHitUsage: chatTestCacheHitUsage })
    renderChat(backend, '/agent?session=server-session', undefined, [chatTestModel, chatVisionTestModel])
    await waitFor(() => expect(useAgentChatStore.getState().session?.remote?.runId).toBe('run-2'))
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    let details = within(await screen.findByRole('dialog', { name: '上下文用量明细' }))
    expect(details.getByText('13,364')).toBeInTheDocument()
    expect(details.getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    expect(details.getByText('82.1%')).toBeInTheDocument()
    expect(details.queryByText(/99,999|88,888|old-model/)).not.toBeInTheDocument()
    await user.unhover(screen.getByRole('button', { name: '上下文用量' }))
    await user.click(screen.getByRole('button', { name: '选择模型：test-model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'test-vision-model' }))
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    details = within(await screen.findByRole('dialog', { name: '上下文用量明细' }))
    expect(details.getByText('test-model')).toBeInTheDocument()
    expect(details.getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    expect(details.queryByText('test-vision-model')).not.toBeInTheDocument()
    await user.unhover(screen.getByRole('button', { name: '上下文用量' }))
    await user.click(screen.getByRole('button', { name: '选择模型：test-vision-model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'test-model' }))
  })

  it('新一轮尚无已确认推理时用量保持中性，不沿用上一轮上下文或缓存均值', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    await backend.api.createTask('server-session', { requestId: 'finished-usage', content: '旧问题' })
    backend.timelines.set('run-1', { runId: 'run-1', status: 'succeeded', done: true, entries: [], usage: chatTestUsage, contextUsage: chatTestContextUsage, cacheHitUsage: chatTestCacheHitUsage })
    backend.hold()
    await backend.api.continueTask('task-1', { requestId: 'new-pending-usage', content: '新问题' })
    renderChat(backend, '/agent?session=server-session')
    await waitFor(() => expect(useAgentChatStore.getState().session?.remote?.runId).toBe('run-2'))
    await waitFor(() => expect(useAgentChatStore.getState().timelines['run-1']).toMatchObject({ cacheHitUsage: chatTestCacheHitUsage }))
    const trigger = screen.getByRole('button', { name: '上下文用量' })
    expect(trigger.querySelector('.chat-usage-ring')).not.toHaveAttribute('data-known')
    await user.hover(trigger)
    const details = within(await screen.findByRole('dialog', { name: '上下文用量明细' }))
    expect(details.getByText('暂无推理用量')).toBeInTheDocument()
    expect(details.queryByText(/36,200|13,364|8,210|82\.1%|≈ /)).not.toBeInTheDocument()
  })

  it('运行中接收时间线增量后，同一用量浮层更新最近推理与本轮累计', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'live-usage', content: '检查服务' })
    const timeline = { runId: 'run-1', status: 'running' as const, done: false, entries: [], usage: chatTestUsage, contextUsage: chatTestContextUsage, cacheHitUsage: chatTestCacheHitUsage }
    backend.timelines.set('run-1', timeline)
    let emit!: Parameters<typeof backend.api.stream>[1]
    backend.api.stream.mockImplementation(async (_id, onOutput, signal) => {
      emit = onOutput
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    renderChat(backend, '/agent?session=server-session')
    await waitFor(() => expect(backend.api.stream).toHaveBeenCalled())
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    const panel = await screen.findByRole('dialog', { name: '上下文用量明细' })
    expect(within(panel).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    expect(within(panel).getByText('82.1%')).toBeInTheDocument()
    const pending = { ...timeline, usage: { calls: 0, resultBytes: 0, modelRequests: 4, tokens: 99999 } }
    act(() => emit({ runId: 'run-1', responseId: 'm2', reasoning: '', content: '', done: false, timeline: pending }))
    expect(within(panel).getByText('82.1%')).toBeInTheDocument()
    expect(within(panel).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    const updated = { ...timeline, usage: { ...chatTestUsage, actualTokens: 16000, cachedTokens: 9000 }, contextUsage: { ...chatTestContextUsage, modelRequestId: 'm2', totalTokens: 48200 }, cacheHitUsage: { inputTokens: 12000, cachedTokens: 9000 } }
    act(() => emit({ runId: 'run-1', responseId: 'm2', reasoning: '', content: '', done: false, timeline: updated }))
    expect(screen.getByRole('dialog', { name: '上下文用量明细' })).toBe(panel)
    expect(within(panel).getByText('48,200 / 100,000（48.2%）')).toBeInTheDocument()
    expect(within(panel).getByText('16,000')).toBeInTheDocument()
    expect(within(panel).getByText('9,000')).toBeInTheDocument()
    expect(within(panel).getByText('75.0%')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '等待模型回复' })).toBeInTheDocument()
    expect(screen.queryByText(/tokens 16,000|缓存 9,000/)).not.toBeInTheDocument()
  })

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
    expect(within(alert).getByRole('button', { name: '关闭通知' })).toBeInTheDocument()
    expect(screen.getAllByText(sessionError, { exact: false })).toHaveLength(1)
    expect(within(screen.getByLabelText('通知')).getAllByRole('alert')).toHaveLength(1)
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
    await act(async () => { finishSession(backend.session) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新读取会话' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeEnabled()
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(backend.api.continueTask).not.toHaveBeenCalled()
  })

  it('历史运行失败在通知区显示原因，不在输入框附近重复显示', async () => {
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'failed-run', content: '此前的问题' })
    const run = backend.runs.get('run-1')!
    run.status = 'failed'
    run.phase = 'completed'
    run.error = { code: 'model-failed', message: '历史模型请求失败' }
    backend.session.activeRunId = undefined
    renderChat(backend, '/agent?session=server-session')
    expect(await screen.findByRole('alert')).toHaveTextContent('历史模型请求失败')
    expect(screen.queryByRole('status', { name: '运行结果' })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('通知')).getAllByRole('alert')).toHaveLength(1)
  })

  it('已接受任务异步失败使用统一消息组件，通知关闭后不重复弹出且可编辑重发', async () => {
    const backend = chatTestApi()
    backend.hold()
    renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '请检查服务' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('article', { name: '你的消息' })
    await waitFor(() => expect(useAgentChatStore.getState().sending).toBe(false))
    const run = backend.runs.get('run-1')!
    run.status = 'failed'
    run.phase = 'completed'
    run.error = { code: 'invalid-model-request', message: '模型请求的消息、工具或输出上限无效' }
    backend.session.activeRunId = undefined
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    const notice = within(screen.getByLabelText('通知'))
    expect(notice.getAllByRole('alert')).toHaveLength(1)
    expect(notice.getByRole('alert')).toHaveTextContent('已失败：模型请求的消息、工具或输出上限无效')
    expect(screen.queryByRole('status', { name: '运行结果' })).not.toBeInTheDocument()
    fireEvent.click(notice.getByRole('button', { name: '关闭通知' }))
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑这条消息' }))
    expect(screen.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('请检查服务')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    expect(screen.queryByRole('article', { name: '助手回复' })).not.toBeInTheDocument()
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
    await waitFor(() => expect(screen.queryByRole('button', { name: `重新读取${source}` })).not.toBeInTheDocument())
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

  it('会话列表与主导航互不联动：开关不改写主导航，主导航收展不影响列表', () => {
    renderChat()
    const nav = document.querySelector('[data-sidebar-collapsed]')!
    const navToggle = document.querySelector<HTMLButtonElement>('[data-testid="test-nav-toggle"]')!
    // 进入聊天页：主导航与会话列表同时展开，互不挤占。
    expect(nav).toHaveAttribute('data-sidebar-collapsed', 'false')
    expect(screen.getByRole('complementary', { name: '会话列表' })).toBeInTheDocument()
    // 收起再打开会话列表：主导航保持展开，不被联动折叠。
    const toggle = screen.getByRole('button', { name: '收起会话列表' })
    fireEvent.click(toggle)
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument()
    expect(nav).toHaveAttribute('data-sidebar-collapsed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('complementary', { name: '会话列表' })).toBeInTheDocument()
    expect(nav).toHaveAttribute('data-sidebar-collapsed', 'false')
    // 主导航收起再展开：会话列表保持展开，不被联动收起。
    fireEvent.click(navToggle)
    expect(nav).toHaveAttribute('data-sidebar-collapsed', 'true')
    expect(screen.getByRole('complementary', { name: '会话列表' })).toBeInTheDocument()
    fireEvent.click(navToggle)
    expect(nav).toHaveAttribute('data-sidebar-collapsed', 'false')
    expect(screen.getByRole('complementary', { name: '会话列表' })).toBeInTheDocument()
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
    // 关闭抽屉后焦点回到开关，不显示文字提示。
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
    expect(screen.getByRole('status', { name: '等待模型回复' })).toBeInTheDocument()
    const timeline = (text: string, done = false) => ({ runId: 'run-1', status: done ? 'succeeded' as const : 'running' as const, done, finalResponseId: done ? 'm1' : undefined, entries: [
      { id: 'm1:reasoning', kind: 'reasoning' as const, modelRequestId: 'm1', requestIndex: 0, startedAt: '', status: done ? 'succeeded' as const : 'running' as const, text: '检查问题', incomplete: false },
      { id: 'm1:content', kind: 'content' as const, modelRequestId: 'm1', requestIndex: 0, startedAt: '', status: done ? 'succeeded' as const : 'running' as const, text, incomplete: false },
    ] })
    act(() => emit({ runId: 'run-1', responseId: 'm1', reasoning: '检查问题', content: '**先显示第一段**', done: false, timeline: timeline('**先显示第一段**') }))
    expect(await screen.findByText('先显示第一段')).toHaveProperty('tagName', 'STRONG')
    expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
    expect(useAgentChatStore.getState().run?.status).toBe('running')
    expect(useAgentChatStore.getState().messages).toHaveLength(1)
    const article = screen.getByRole('article', { name: '助手回复' })
    expect(article.parentElement).toHaveClass('chat-response')
    expect(article.closest('.chat-timeline')?.querySelector('.chat-thought')).not.toBeNull()
    act(() => emit({ runId: 'run-1', responseId: 'm1', reasoning: '检查问题', content: '**先显示第一段**\n\n接着显示第二段', done: false, timeline: timeline('**先显示第一段**\n\n接着显示第二段') }))
    expect(await screen.findByText('接着显示第二段')).toBeInTheDocument()
    backend.complete('**先显示第一段**\n\n接着显示第二段')
    backend.timelines.set('run-1', timeline('**先显示第一段**\n\n接着显示第二段', true))
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(screen.getAllByRole('article', { name: '助手回复' })).toHaveLength(1)
    expect(screen.getByRole('article', { name: '助手回复' })).toBe(article)
  })

  it('正文结束后恢复下一轮选项，服务端收尾完成后由输出流回读解除发送锁定', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    backend.hold()
    await backend.api.createTask('server-session', { requestId: 'running', content: '请回答' })
    let emit!: Parameters<typeof backend.api.stream>[1]
    let finishStream!: () => void
    backend.api.stream.mockImplementation(async (_id, onOutput, signal) => {
      emit = onOutput
      await new Promise<void>(resolve => {
        finishStream = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    renderChat(backend, '/agent?session=server-session', undefined, [chatTestModel, chatVisionTestModel])
    await waitFor(() => expect(backend.api.stream).toHaveBeenCalled())
    act(() => emit({ runId: 'run-1', responseId: 'm1', reasoning: '', content: '完整回答', done: false }))
    await screen.findByText('完整回答')
    expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeDisabled()

    backend.runs.get('run-1')!.phase = 'final-memory'
    await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
    expect(screen.queryByRole('button', { name: '停止回复' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正在保存回复' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '正在保存回复' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '选择思考等级：高' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '权限模式：请求批准' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '选择模型：test-model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'test-vision-model' }))
    await user.click(screen.getByRole('button', { name: '选择思考等级：高' }))
    await user.click(screen.getByRole('menuitemradio', { name: '低' }))
    const composer = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
    fireEvent.change(composer, { target: { value: '下一轮' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(backend.api.continueTask).not.toHaveBeenCalled()
    expect(backend.api.switchModel).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().run).toMatchObject({ id: 'run-1', status: 'running', phase: 'final-memory' })

    backend.complete('完整回答')
    backend.api.getSession.mockResolvedValueOnce({ ...backend.session, activeRunId: 'run-1' })
    await act(async () => {
      emit({ runId: 'run-1', responseId: 'm1', reasoning: '', content: '完整回答', done: true })
      finishStream()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: '正在保存回复' })).not.toBeInTheDocument()
    expect(useAgentChatStore.getState().remoteSession?.activeRunId).toBeUndefined()
    expect(useAgentChatStore.getState().session).toMatchObject({ modelId: chatVisionTestModel.id, reasoningLevel: 'low', permissionMode: 'ask' })
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(backend.api.continueTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ content: '下一轮', reasoningLevel: 'low' })))
    expect(backend.api.switchModel).toHaveBeenCalledWith('server-session', { modelProfileId: chatVisionTestModel.id, modelRevision: chatVisionTestModel.revision })
  })

  it('运行中切到其他会话释放输出流，切回后以原运行重连并衔接内容', async () => {
    const user = userEvent.setup()
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
    backend.timelines.set('run-1', { runId: 'run-1', status: 'running', done: false, entries: [], usage: chatTestUsage, contextUsage: chatTestContextUsage, cacheHitUsage: chatTestCacheHitUsage })
    renderChat(backend)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '检查服务' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(watches).toHaveLength(1))
    expect(watches[0]!.runId).toBe('run-1')
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    expect(within(await screen.findByRole('dialog', { name: '上下文用量明细' })).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    await user.unhover(screen.getByRole('button', { name: '上下文用量' }))
    // 切到空闲会话：原会话的输出流订阅随展示释放断开，运行仍在服务端继续。
    fireEvent.click(screen.getByRole('button', { name: '历史 B' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('history-b'))
    await waitFor(() => expect(watches[0]!.signal.aborted).toBe(true))
    expect(watches).toHaveLength(1)
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    const emptyUsage = within(await screen.findByRole('dialog', { name: '上下文用量明细' }))
    expect(emptyUsage.getByText('暂无推理用量')).toBeInTheDocument()
    expect(emptyUsage.queryByText('36,200 / 100,000（36.2%）')).not.toBeInTheDocument()
    await user.unhover(screen.getByRole('button', { name: '上下文用量' }))
    // 切回运行中的会话：以原 Run 重新订阅，快照增量原位衔接、不重复用户消息。
    fireEvent.click(screen.getByRole('button', { name: '会话 A' }))
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    await waitFor(() => expect(watches).toHaveLength(2))
    expect(watches[1]!.runId).toBe('run-1')
    await waitFor(() => expect(useAgentChatStore.getState().run?.id).toBe('run-1'))
    await user.hover(screen.getByRole('button', { name: '上下文用量' }))
    expect(within(await screen.findByRole('dialog', { name: '上下文用量明细' })).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
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

  it('模型声明的默认档优先于通用回落策略', async () => {
    const backend = chatTestApi()
    const glm = { ...chatTestModel, id: 'glm', model: 'glm-5.3', capabilities: { ...chatTestModel.capabilities, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'max' } }
    renderChat(backend, '/agent', undefined, [glm])
    // 官方预设按文档声明默认档（智谱 max）：未选择时直接落「最高」，不按「优先高」回落。
    await waitFor(() => expect(useAgentChatStore.getState().session?.reasoningLevel).toBe('max'))
    expect(screen.getByRole('button', { name: '选择思考等级：最高' })).toBeInTheDocument()
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
    expect(screen.getByRole('status', { name: '等待模型回复' })).toBeInTheDocument()
    expect(screen.queryByText(/Ely 正在|正在整理会话|正在发送/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送消息' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止回复' })).toBeEnabled()
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
      expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
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
      expect(screen.queryByRole('button', { name: '停止回复' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '选择模型：test-model' })).toBeEnabled()
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
    expect(within(screen.getByLabelText('通知')).getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('.chat-compose-area [role="alert"]')).toBeNull()
    expect(textbox).toHaveValue('你好')
    expect(screen.queryByRole('article', { name: '助手回复' })).not.toBeInTheDocument()
  })

  it('发送请求等待回执时立即显示忙碌状态，失败后恢复发送', async () => {
    const backend = chatTestApi()
    let reject!: (error: Error) => void
    backend.api.createSession.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    renderChat(backend)
    const composer = screen.getByRole('textbox')
    fireEvent.change(composer, { target: { value: '你好' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    expect(screen.getByRole('button', { name: '正在发送消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '正在发送消息' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status', { name: '等待模型回复' })).toBeInTheDocument()
    expect(screen.queryByText('今天想聊什么？')).not.toBeInTheDocument()
    await waitFor(() => expect(backend.api.createSession).toHaveBeenCalled())
    await act(async () => { reject(new Error('提交失败')) })
    expect(screen.getByRole('alert')).toHaveTextContent('提交失败')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled()
    expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
    expect(composer).toHaveValue('你好')
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

  it('权限菜单仅保留三种模式并恢复偏好', async () => {
    const user = userEvent.setup()
    const view = renderChat()
    await waitFor(() => expect(screen.getByRole('button', { name: '选择思考等级：高' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '权限模式：请求批准' }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    expect(screen.getByRole('menuitemradio', { name: '完全开放' })).toHaveAccessibleDescription('自动批准已启用能力所需的操作与运行时权限，系统禁区与资源限制继续生效。')
    expect(screen.queryByRole('menuitem', { name: '本会话授权…' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitemradio', { name: '帮我批准' }))
    expect(useAgentChatStore.getState().session?.permissionMode).toBe('assist')
    expect(screen.queryByText('预览')).not.toBeInTheDocument()
    view.unmount()
    renderChat()
    expect(screen.getByRole('button', { name: '权限模式：帮我批准' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '权限模式：帮我批准' }))
    await user.click(screen.getByRole('menuitemradio', { name: '请求批准' }))
    expect(screen.queryByText('预览')).not.toBeInTheDocument()
  })

  it('上传期间禁用发送和选图，输入与新建仍可用，完成后随消息发送', async () => {
    const user = userEvent.setup()
    const backend = chatTestApi()
    const upload = backend.api.uploadAttachments.getMockImplementation()!
    let finishUpload!: (value: Awaited<ReturnType<typeof upload>>) => void
    backend.api.uploadAttachments.mockReturnValueOnce(new Promise(resolve => { finishUpload = resolve }))
    renderChat(backend, '/agent', undefined, [chatVisionTestModel])
    const picker = screen.getByLabelText('选择文件') as HTMLInputElement
    const openPicker = vi.spyOn(picker, 'click')
    await user.click(await screen.findByRole('button', { name: '添加文件' }))
    expect(openPicker).toHaveBeenCalledOnce()
    const file = new File(['png'], 'diagram.png', { type: 'image/png' })
    await user.upload(picker, file)
    await waitFor(() => expect(backend.api.uploadAttachments).toHaveBeenCalledOnce())
    expect(document.querySelector('.chat-compose-area [role="status"]')).toHaveTextContent('正在处理文件…')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加文件' })).toBeDisabled()
    expect(picker).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(within(screen.getByRole('region', { name: 'Ely 会话' })).getByRole('button', { name: '新会话' })).toBeEnabled()
    await user.type(screen.getByRole('textbox'), '读取附件')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(backend.api.createTask).not.toHaveBeenCalled()
    await act(async () => { finishUpload(await upload([file])) })
    expect(await screen.findByText('diagram.png')).toBeInTheDocument()
    expect(picker.value).toBe('')
    expect(picker).toBeEnabled()
    // 带图片附件的发送不再被禁用：附件随消息真正发给模型。
    const send = screen.getByRole('button', { name: '发送消息' })
    expect(send).toBeEnabled()
    await user.click(send)
    await waitFor(() => expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({
      content: '读取附件', attachments: [{ id: 'server-attachment-1' }],
    })))
    // 确认接受后草稿附件清空。
    await waitFor(() => expect(screen.queryByText('diagram.png')).not.toBeInTheDocument())
  })

  it('文本文件入口不依赖图片能力，图片在导入时按模型能力校验', async () => {
    const backend = chatTestApi()
    const plain = renderChat(backend)
    expect(await screen.findByRole('button', { name: '添加文件' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [new File(['png'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('当前模型不支持图片输入，请切换支持图片的模型后再添加。')
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    plain.unmount()
    const visionBackend = chatTestApi()
    const vision = renderChat(visionBackend, '/agent', undefined, [chatVisionTestModel])
    await waitFor(() => expect(vision.getByRole('button', { name: '添加文件' })).toBeEnabled())
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
    // 本地草稿没有编辑入口，按钮数只随服务端会话行数变化。
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
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()
    expect(backend.api.renameSession).not.toHaveBeenCalled()
    await user.type(input, 'x'.repeat(201))
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    expect(await within(screen.getByLabelText('通知')).findByText('标题不能超过 200 字节')).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()
    expect(backend.api.renameSession).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, '  新标题  ')
    expect(input).not.toHaveAttribute('aria-invalid')
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    await waitFor(() => expect(backend.api.renameSession).toHaveBeenCalledExactlyOnceWith('server-session', { title: '新标题' }))
    // 弹窗关闭，列表行与页头标题以服务端落库值（TrimSpace 后）展示。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名会话' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '新标题' })).toBeInTheDocument())
    expect(document.querySelector('.chat-title')).toHaveTextContent('新标题')
    expect(screen.queryByRole('button', { name: longTitle })).not.toBeInTheDocument()
  })

  it('重命名被服务端拒绝时仅通知一次，弹窗保留可重试，列表不动', async () => {
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
    expect(await within(screen.getByLabelText('通知')).findByRole('alert')).toHaveTextContent('会话标题不能为空')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(useNotificationStore.getState().notifications.filter(item => item.message === '会话标题不能为空')).toHaveLength(1)
    expect(input).toHaveFocus()
    expect(document.querySelector('.chat-title')).toHaveTextContent(longTitle)
    await user.clear(input)
    await user.type(input, '最终名字')
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }))
    await waitFor(() => expect(document.querySelector('.chat-title')).toHaveTextContent('最终名字'))
    expect(screen.getAllByText('会话标题不能为空')).toHaveLength(1)
    expect(document.querySelector('.chat-compose-area [role="alert"]')).toBeNull()
  })

  it('删除会话：先删当前回落到剩余会话，再删最后一个回落到空白草稿，均经通知反馈', async () => {
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
    expect(within(screen.getByLabelText('通知')).getByText('会话已删除，已切换到其他会话。')).toBeInTheDocument()
    expect(screen.getAllByText('会话已删除，已切换到其他会话。')).toHaveLength(1)
    await waitFor(() => expect(router.state.location.search).toBe('?session=history-b'))
    expect(screen.queryByRole('button', { name: longTitle })).not.toBeInTheDocument()
    // 删除最后一个会话：回落到空白草稿，URL 清空。
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }))
    await user.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(backend.api.deleteSession).toHaveBeenCalledTimes(2))
    expect(backend.api.deleteSession).toHaveBeenNthCalledWith(2, 'history-b')
    await waitFor(() => expect(useAgentChatStore.getState().session?.remote).toBeUndefined())
    expect(within(screen.getByLabelText('通知')).getByText('会话已删除，已新建空白会话。')).toBeInTheDocument()
    expect(screen.getAllByText('会话已删除，已新建空白会话。')).toHaveLength(1)
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.queryByRole('button', { name: '历史 B' })).not.toBeInTheDocument()
  })

  it('删除被服务端拒绝时不做本地清理，错误仅经通知反馈且弹窗可重试', async () => {
    const user = userEvent.setup()
    const message = '会话存在结果未确认的执行（如面板重启时的在途操作），暂不能删除；需经执行对账接口确认停止后解除'
    const { backend } = setupSessions()
    await waitFor(() => expect(useAgentChatStore.getState().remoteSession?.id).toBe('server-session'))
    backend.api.deleteSession.mockRejectedValueOnce(new AgentHttpError(message, 'session-unresolved', 409))
    await user.click(screen.getAllByRole('button', { name: '编辑会话' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }))
    await user.click(await screen.findByRole('button', { name: '确认删除' }))
    const dialog = await screen.findByRole('dialog', { name: `删除会话「${longTitle}」？` })
    expect(await within(screen.getByLabelText('通知')).findByRole('alert')).toHaveTextContent(message)
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(useNotificationStore.getState().notifications.filter(item => item.message === message)).toHaveLength(1)
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


const testPlan: AgentRunPlan = { revision: 1, updatedAt: '2026-10-17T00:00:00Z', steps: [
  { id: 'inspect', title: '检查配置', status: 'completed' }, { id: 'verify', title: '验证结果', status: 'in_progress' },
] }
it('当前计划仅在输入区，未确认发送保留；接受新轮移入历史，刷新恢复且登出隐藏', async () => {
  const backend = chatTestApi()
  await backend.api.createTask('server-session', { requestId: 'planned', content: '检查配置' })
  backend.timelines.set('run-1', { runId: 'run-1', status: 'succeeded', done: true, entries: [], plan: testPlan })
  const view = renderChat(backend, '/agent?session=server-session')
  let panel = await screen.findByRole('region', { name: '任务进度' })
  expect(panel.closest('.chat-compose-area')).not.toBeNull()
  expect(screen.getAllByRole('region', { name: '任务进度' })).toHaveLength(1)
  fireEvent.click(within(panel).getByRole('button'))
  expect(within(panel).getByText('验证结果')).toBeInTheDocument()
  backend.api.continueTask.mockRejectedValueOnce(new Error('连接中断，结果未确认'))
  fireEvent.change(screen.getByRole('textbox', { name: '发送给 Ely 的消息' }), { target: { value: '继续查询' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await screen.findByRole('button', { name: '重试发送' })
  expect(panel.closest('.chat-compose-area')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试发送' }))
  await screen.findByText('继续查询')
  await waitFor(() => expect(screen.getByRole('region', { name: '任务进度' }).closest('.chat-messages')).not.toBeNull())
  expect(screen.getAllByRole('region', { name: '任务进度' })).toHaveLength(1)
  view.unmount()
  act(() => useAgentChatStore.getState().clearDisplay())
  renderChat(backend, '/agent?session=server-session')
  panel = await screen.findByRole('region', { name: '任务进度' })
  expect(panel.closest('.chat-messages')).not.toBeNull()
  expect(within(panel).getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  act(() => useAgentChatStore.getState().clearDisplay())
  expect(screen.queryByRole('region', { name: '任务进度' })).not.toBeInTheDocument()
})

it('编辑重发排除旧轮计划，新建会话不带入旧计划', async () => {
  const backend = chatTestApi()
  await backend.api.createTask('server-session', { requestId: 'planned-edit', content: '检查配置' })
  backend.timelines.set('run-1', { runId: 'run-1', status: 'succeeded', done: true, entries: [], plan: testPlan })
  renderChat(backend, '/agent?session=server-session')
  await screen.findByRole('region', { name: '任务进度' })
  const edit = screen.getByRole('button', { name: '编辑这条消息' })
  await waitFor(() => expect(edit).toBeEnabled())
  fireEvent.click(edit)
  fireEvent.change(screen.getByRole('textbox', { name: '编辑消息内容' }), { target: { value: '改为查询日志' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('改为查询日志')
  expect(screen.queryByRole('region', { name: '任务进度' })).not.toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('region', { name: 'Ely 会话' })).getByRole('button', { name: '新会话' }))
  expect(screen.queryByRole('region', { name: '任务进度' })).not.toBeInTheDocument()
})

it('实时计划更新保持展开，等待回答时进度留在选择卡片上方，切换会话隔离迟到输出', async () => {
  const backend = chatTestApi()
  backend.hold()
  await backend.api.createTask('server-session', { requestId: 'live-plan', content: '检查并验证' })
  let output!: (event: AgentChatOutput) => void
  backend.api.stream.mockImplementation(async (_id, onOutput, signal) => {
    output = onOutput
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  renderChat(backend, '/agent?session=server-session')
  await waitFor(() => expect(output).toBeDefined())
  const timeline = { runId: 'run-1', status: 'running' as const, done: false, entries: [], plan: testPlan }
  act(() => output({ runId: 'run-1', responseId: 'm1', content: '', reasoning: '', done: false, timeline }))
  const panel = screen.getByRole('region', { name: '任务进度' })
  fireEvent.click(within(panel).getByRole('button'))
  const updated = { ...testPlan, revision: 2, steps: testPlan.steps.map(step => ({ ...step, status: 'completed' as const })) }
  act(() => output({ runId: 'run-1', responseId: 'm1', content: '', reasoning: '', done: false, timeline: { ...timeline, plan: updated } }))
  expect(within(panel).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  expect(within(panel).getByText('2/2 已完成')).toBeInTheDocument()
  backend.runs.get('run-1')!.status = 'waiting-input'
  act(() => output({ runId: 'run-1', responseId: 'm1', content: '', reasoning: '', done: false, timeline: {
    ...timeline, status: 'waiting-input', entries: [{ id: 'question', kind: 'user-input', modelRequestId: 'm1', requestIndex: 1, startedAt: '', userInput: chatTestUserInput }],
  } }))
  await act(async () => { await useAgentChatStore.getState().refresh(backend.api) })
  expect(within(panel).getByRole('status')).toHaveTextContent('等待回答')
  expect(screen.queryByRole('textbox', { name: '发送给 Ely 的消息' })).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '回答 Ely 的问题' })).getByText('需要查看哪个范围？')).toBeInTheDocument()
  expect(panel.closest('.chat-compose-area')).not.toBeNull()
  fireEvent.click(within(screen.getByRole('region', { name: 'Ely 会话' })).getByRole('button', { name: '新会话' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: '任务进度' })).not.toBeInTheDocument())
  act(() => output({ runId: 'run-1', responseId: 'm1', content: '', reasoning: '', done: false, timeline }))
  expect(screen.queryByRole('region', { name: '任务进度' })).not.toBeInTheDocument()
})

it('轮次之间显示模型与思考等级切换', async () => {
  const backend = chatTestApi()
  await backend.api.createTask('server-session', { requestId: 'switch-first', content: '第一轮' })
  await backend.api.switchModel('server-session', { modelProfileId: chatVisionTestModel.id, modelRevision: chatVisionTestModel.revision })
  await backend.api.createTask('server-session', { requestId: 'switch-second', content: '第二轮' })
  backend.messages[0]!.runConfig = { modelName: 'test-model', modelService: '测试服务', modelProfileId: chatTestModel.id, modelRevision: 1, reasoningLevel: 'high' }
  backend.messages[2]!.runConfig = { modelName: 'test-vision-model', modelService: '测试服务', modelProfileId: chatVisionTestModel.id, modelRevision: 1, reasoningLevel: 'low' }
  renderChat(backend, '/agent?session=server-session', undefined, [chatTestModel, chatVisionTestModel])
  expect(await screen.findByText('模型已切换 test-model（测试服务） → test-vision-model（测试服务） · 思考等级已切换 高 → 低')).toBeInTheDocument()
})

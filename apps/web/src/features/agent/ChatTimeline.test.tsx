import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatTimelineEntry, AgentChatTimelineSnapshot, AgentMessage, RuntimeCall } from '@elysian/contracts'
import { chatTestApi, chatTestUsage } from '../../test/agentChatFixtures'
import { useMessageStore } from '../../stores/messageStore'
import { ChatTimeline } from './ChatTimeline'

const base = { startedAt: '', status: 'succeeded' as const, incomplete: false }
const text = (requestIndex: number, kind: 'reasoning' | 'content', value: string): AgentChatTimelineEntry => ({ ...base, id: `m${requestIndex}:${kind}`, modelRequestId: `m${requestIndex}`, requestIndex, kind, text: value })
const tool: Extract<AgentChatTimelineEntry, { kind: 'tool' }> = { ...base, id: 'm0:tool:p', modelRequestId: 'm0', requestIndex: 0, kind: 'tool', tool: 'docker_images_list', modelCallId: 'p', callIndex: 0, argumentsJson: '{"n":9007199254740993}', callId: 'c1', truncated: true }
const snapshot = (entries: readonly AgentChatTimelineEntry[], done = false): AgentChatTimelineSnapshot => ({ runId: 'run-1', status: done ? 'succeeded' : 'running', done, finalResponseId: done ? 'm2' : undefined, entries })
const call: RuntimeCall = { id: 'c1', runId: 'run-1', modelRequestId: 'm0', modelCallId: 'p', tool: tool.tool, status: 'succeeded', stepIndex: 0, args: {}, result: { items: ['结果内容'] }, truncated: true }
const answer: AgentMessage = { id: 'answer', role: 'assistant', content: '最终结果已确认', runId: 'run-1', taskId: 'task-1', sessionId: 'session-1', seq: '2', createdAt: '' }
const runtimeContent = '本轮任务未能完成。\n\n原因：执行容器通道不可用'
beforeEach(() => useMessageStore.getState().clear())

describe('分段回复过程', () => {
  it('失败结果在过程末尾显示，公开消息回读后只保留一次且不替换模型片段', async () => {
    const user = userEvent.setup()
    const { api } = chatTestApi()
    const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'failed', done: true, finalResponseId: 'm0',
      plan: { revision: 1, updatedAt: '', steps: [{ id: 'read', title: '读取页面', status: 'in_progress' }] },
      terminalResult: { origin: 'runtime', content: runtimeContent }, error: { code: 'execution-unavailable', message: '执行容器通道不可用' }, entries: [text(0, 'content', '已经读取部分资料')] }
    const draw = (final?: AgentMessage) => <Tooltip.Provider><ChatTimeline timeline={timeline} answer={final} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>
    const view = render(draw())
    const result = screen.getByRole('article', { name: '运行结果' })
    expect(screen.getByLabelText('回复过程').lastElementChild).toBe(result)
    expect(result).toHaveTextContent('本轮任务未能完成。')
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveTextContent('已经读取部分资料')
    expect(screen.queryByText(/运行未完成：/)).not.toBeInTheDocument()
    view.rerender(draw({ ...answer, origin: 'runtime', runStatus: 'failed', content: runtimeContent }))
    expect(screen.getAllByRole('article', { name: '运行结果' })).toEqual([result])
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveTextContent('已经读取部分资料')
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '复制运行结果' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(runtimeContent)
  })

  it('历史失败空过程可展示快照结果，手动停止不补失败结果', () => {
    const { api } = chatTestApi()
    const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'interrupted', done: true, terminalResult: { origin: 'runtime', content: runtimeContent }, entries: [] }
    const draw = (stopped: boolean) => <Tooltip.Provider><ChatTimeline timeline={timeline} api={api} active={false} stopped={stopped} onProgress={vi.fn()} /></Tooltip.Provider>
    const view = render(draw(false))
    expect(screen.getByRole('article', { name: '运行结果' })).toHaveTextContent('原因：执行容器通道不可用')
    view.rerender(draw(true))
    expect(screen.queryByRole('article', { name: '运行结果' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('已停止')
  })

  it('正式运行结果先回读而时间线仍旧时立即展示，随后快照不重复', () => {
    const { api } = chatTestApi()
    const final: AgentMessage = { ...answer, origin: 'runtime', content: runtimeContent, runStatus: 'failed' }
    const draw = (timeline: AgentChatTimelineSnapshot) => <Tooltip.Provider><ChatTimeline timeline={timeline} answer={final} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>
    const view = render(draw({ runId: 'run-1', status: 'running', done: false, entries: [] }))
    expect(screen.getAllByRole('article', { name: '运行结果' })).toHaveLength(1)
    view.rerender(draw({ runId: 'run-1', status: 'failed', done: true, entries: [], terminalResult: { origin: 'runtime', content: runtimeContent } }))
    expect(screen.getAllByRole('article', { name: '运行结果' })).toHaveLength(1)
  })

  it('系统自动取消保留的历史片段仍是过程，最终仅运行结果提供消息复制', () => {
    const { api } = chatTestApi()
    const partial = { ...answer, content: '中断前的片段', runStatus: 'cancelled' as const }
    const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'cancelled', done: true, finalResponseId: 'm0', terminalResult: { origin: 'runtime', content: runtimeContent }, entries: [text(0, 'content', partial.content)] }
    render(<Tooltip.Provider><ChatTimeline timeline={timeline} answer={partial} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveClass('chat-message-intermediate')
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '复制运行结果' })).toHaveLength(1)
  })
  it('三轮按顺序追加，保留前段节点和独立展开状态，终答在原节点确认一次', async () => {
    const { api } = chatTestApi()
    const onProgress = vi.fn()
    const first = [text(0, 'reasoning', '第一轮思考'), text(0, 'content', '第一段正文'), tool]
    const draw = (timeline: AgentChatTimelineSnapshot, final?: AgentMessage) => <Tooltip.Provider><ChatTimeline timeline={timeline} answer={final} api={api} active={!timeline.done} stopped={false} onProgress={onProgress} /></Tooltip.Provider>
    const view = render(draw(snapshot(first)))
    const firstArticle = screen.getByRole('article', { name: '助手回复' })
    expect(firstArticle).toHaveClass('chat-message-intermediate')
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }))
    expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('第一轮思考')
    const all = [...first, text(1, 'reasoning', '第二轮思考'), text(1, 'content', '第二段正文'), text(2, 'reasoning', '末轮思考'), text(2, 'content', '终答预览')]
    view.rerender(draw(snapshot(all)))
    const articles = screen.getAllByRole('article', { name: '助手回复' })
    const finalArticle = articles.at(-1)
    expect(articles[0]).toBe(firstArticle)
    expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('第一轮思考')
    expect(screen.getAllByRole('button', { name: '展开思考内容' })).toHaveLength(2)
    expect(articles.every(article => article.classList.contains('chat-message-intermediate'))).toBe(true)
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    const process = screen.getByLabelText('回复过程')
    expect(process.textContent).toMatch(/第一轮思考.*第一段正文.*docker_images_list.*第二轮思考.*第二段正文.*末轮思考.*终答预览/)
    view.rerender(draw({ ...snapshot(all, true), usage: chatTestUsage }, answer))
    expect(screen.getAllByRole('article', { name: '助手回复' })).toHaveLength(3)
    expect(screen.getAllByRole('article', { name: '助手回复' }).at(-1)).toBe(finalArticle)
    expect(screen.getAllByText(answer.content)).toHaveLength(1)
    expect(screen.queryByText('终答预览')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '复制回复内容' })).toHaveLength(1)
    expect(within(finalArticle!).getByRole('button', { name: '复制回复内容' })).toBeInTheDocument()
    expect(finalArticle).not.toHaveClass('chat-message-intermediate')
    expect(firstArticle).toHaveClass('chat-message-intermediate')
    expect(screen.queryByText(/tokens|缓存|占总量/)).not.toBeInTheDocument()
    expect(api.calls).not.toHaveBeenCalled()
  })

  it('工具展开后才读取结果，读取失败进入通知并可重试，保留精确参数及截断状态', async () => {
    const { api } = chatTestApi()
    api.calls.mockRejectedValueOnce(new Error('详情读取失败')).mockResolvedValue([call])
    render(<Tooltip.Provider><ChatTimeline timeline={snapshot([tool])} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(api.calls).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `展开工具 ${tool.tool} 详情` }))
    expect(screen.getByText(tool.argumentsJson)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '重试读取工具详情' }))
    expect(await screen.findByText(/结果内容/)).toBeInTheDocument()
    expect(useMessageStore.getState().messages).toEqual([expect.objectContaining({ message: '详情读取失败', tone: 'danger' })])
    expect(screen.getByText('结果已截断')).toBeInTheDocument()
    expect(api.calls).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /复制/ })).not.toBeInTheDocument()
  })

  it('工具状态更新保留展开面板，执行完成后重新读取结果', async () => {
    const { api } = chatTestApi()
    api.calls.mockResolvedValue([{ ...call, status: 'running', result: undefined }])
    const draw = (entry: typeof tool) => <Tooltip.Provider><ChatTimeline timeline={snapshot([entry])} api={api} active stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>
    const view = render(draw({ ...tool, status: 'running' }))
    fireEvent.click(screen.getByRole('button', { name: `展开工具 ${tool.tool} 详情` }))
    await waitFor(() => expect(api.calls).toHaveBeenCalledOnce())
    api.calls.mockResolvedValue([call])
    view.rerender(draw(tool))
    expect(await screen.findByText(/结果内容/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `收起工具 ${tool.tool} 详情` })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('成功')).toBeInTheDocument()
  })

  it.each(['failed', 'cancelled'] as const)('刷新可展示 %s 的未完成片段，停止仅标记一次', status => {
    const { api } = chatTestApi()
    const entries = [text(0, 'reasoning', '已收到思考'), text(0, 'content', '已收到正文')].map(entry => ({ ...entry, status, incomplete: true }))
    render(<Tooltip.Provider><ChatTimeline timeline={{ runId: 'run-1', status, done: true, entries }} api={api} active={false} stopped={status === 'cancelled'} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.getByText('已收到正文')).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(status === 'cancelled' ? '已停止' : '未完成')
  })

  it('请求成功但正文未完成时不将片段标记为回复成功', () => {
    const { api } = chatTestApi()
    const entry = { ...text(0, 'content', '达到输出上限前的正文'), incomplete: true }
    render(<Tooltip.Provider><ChatTimeline timeline={{ runId: 'run-1', status: 'failed', done: true, entries: [entry] }} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.getByRole('status')).toHaveTextContent(/^未完成$/)
    expect(screen.getByText('达到输出上限前的正文')).toBeInTheDocument()
  })
})

describe('过程文本与公开答复', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'interrupted'] as const)('%s 后仅保留公开答复及停止标记，时间线不再显示用量', status => {
    const { api } = chatTestApi()
    const stopped = status === 'cancelled'
    render(<Tooltip.Provider><ChatTimeline timeline={{ runId: 'run-1', status, done: true, entries: [], usage: chatTestUsage }} answer={answer} api={api} active={false} stopped={stopped} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.getAllByText(answer.content)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '复制回复内容' })).toHaveLength(1)
    expect(screen.getByRole('article', { name: '助手回复' })).not.toHaveClass('chat-message-intermediate')
    expect(screen.queryByText(/tokens|缓存|占总量/)).not.toBeInTheDocument()
    if (stopped) {
      expect(screen.getAllByText('已停止')).toHaveLength(1)
    } else expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('终态失败与中断显示运行原因，成功与取消不显示', () => {
    const { api } = chatTestApi()
    const draw = (timeline: AgentChatTimelineSnapshot, stopped = false) => <Tooltip.Provider><ChatTimeline timeline={timeline} api={api} active={false} stopped={stopped} onProgress={vi.fn()} /></Tooltip.Provider>
    const failed: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'failed', done: true, error: { code: 'model-budget', message: '模型请求次数或 token 预算已耗尽' }, entries: [] }
    const view = render(draw(failed))
    expect(screen.getByText('运行未完成：模型请求次数或 token 预算已耗尽')).toHaveClass('text-danger')
    view.rerender(draw({ ...failed, status: 'interrupted', error: { code: 'panel-restarted', message: '面板重启中断了运行，未自动重跑' } }))
    expect(screen.getByText('运行未完成：面板重启中断了运行，未自动重跑')).toHaveClass('text-fg-muted')
    view.rerender(draw({ ...failed, status: 'cancelled', error: { code: 'cancelled', message: '已取消' } }, true))
    expect(screen.queryByText(/运行未完成/)).not.toBeInTheDocument()
    view.rerender(draw({ runId: 'run-1', status: 'succeeded', done: true, entries: [] }))
    expect(screen.queryByText(/运行未完成/)).not.toBeInTheDocument()
  })

  it('只有 finalResponseId 而尚未确认公开答复时，不给过程正文复制按钮', () => {
    const { api } = chatTestApi()
    render(<Tooltip.Provider><ChatTimeline timeline={{ runId: 'run-1', status: 'succeeded', done: true, finalResponseId: 'm0', entries: [text(0, 'content', '终答预览')] }} api={api} active={false} stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveClass('chat-message-intermediate')
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
  })

  it('停止的中间片段没有复制条带，服务端确认的部分答复可复制一次', async () => {
    const user = userEvent.setup()
    const { api } = chatTestApi()
    const entry = { ...text(0, 'content', '停止前的预览'), status: 'cancelled' as const, incomplete: true }
    const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'cancelled', done: true, finalResponseId: 'm0', entries: [entry] }
    const draw = (final?: AgentMessage) => <Tooltip.Provider><ChatTimeline timeline={timeline} answer={final} api={api} active={false} stopped onProgress={vi.fn()} /></Tooltip.Provider>
    const view = render(draw())
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveClass('chat-message-intermediate')
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    const partial = { ...answer, content: '**服务端保留的部分答复**' }
    view.rerender(draw(partial))
    expect(screen.getByRole('article', { name: '助手回复' })).not.toHaveClass('chat-message-intermediate')
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '复制回复内容' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(partial.content)
  })

  it('过程正文仍保留代码块复制，不提供整段正文复制', async () => {
    const user = userEvent.setup()
    const { api } = chatTestApi()
    render(<Tooltip.Provider><ChatTimeline timeline={snapshot([text(0, 'content', '检查命令：\n\n```sh\ndocker ps\n```')])} api={api} active stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>)
    expect(screen.queryByRole('button', { name: '复制回复内容' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: '助手回复' })).toHaveClass('chat-message-intermediate')
    await user.click(screen.getByRole('button', { name: '复制代码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('docker ps\n')
  })
})


it('正常计划更新隐藏原始工具条目，失败仍可查看详情', () => {
  const { api } = chatTestApi()
  const draw = (status: 'succeeded' | 'failed') => <Tooltip.Provider><ChatTimeline
    timeline={snapshot([{ ...tool, tool: 'update_plan', status }])} api={api} active stopped={false} onProgress={vi.fn()} /></Tooltip.Provider>
  const view = render(draw('succeeded'))
  expect(screen.queryByRole('button', { name: /update_plan/ })).not.toBeInTheDocument()
  view.rerender(draw('failed'))
  expect(screen.getByRole('button', { name: '展开工具 update_plan 详情' })).toBeInTheDocument()
})

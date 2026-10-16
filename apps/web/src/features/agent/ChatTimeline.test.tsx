import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatTimelineEntry, AgentChatTimelineSnapshot, AgentMessage, RuntimeCall } from '@elysian/contracts'
import { chatTestApi } from '../../test/agentChatFixtures'
import { useNotificationStore } from '../../stores/notificationStore'
import { ChatTimeline } from './ChatTimeline'

const base = { startedAt: '', status: 'succeeded' as const, incomplete: false }
const text = (requestIndex: number, kind: 'reasoning' | 'content', value: string): AgentChatTimelineEntry => ({ ...base, id: `m${requestIndex}:${kind}`, modelRequestId: `m${requestIndex}`, requestIndex, kind, text: value })
const tool: Extract<AgentChatTimelineEntry, { kind: 'tool' }> = { ...base, id: 'm0:tool:p', modelRequestId: 'm0', requestIndex: 0, kind: 'tool', tool: 'docker_images_list', modelCallId: 'p', callIndex: 0, argumentsJson: '{"n":9007199254740993}', callId: 'c1', truncated: true }
const snapshot = (entries: readonly AgentChatTimelineEntry[], done = false): AgentChatTimelineSnapshot => ({ runId: 'run-1', status: done ? 'succeeded' : 'running', done, finalResponseId: done ? 'm2' : undefined, entries })
const call: RuntimeCall = { id: 'c1', runId: 'run-1', modelRequestId: 'm0', modelCallId: 'p', tool: tool.tool, status: 'succeeded', stepIndex: 0, args: {}, result: { items: ['结果内容'] }, truncated: true }
const answer: AgentMessage = { id: 'answer', role: 'assistant', content: '最终结果已确认', runId: 'run-1', taskId: 'task-1', sessionId: 'session-1', seq: '2', createdAt: '' }
beforeEach(() => useNotificationStore.getState().clear())

describe('分段回复过程', () => {
  it('三轮按顺序追加，保留前段节点和独立展开状态，终答在原节点确认一次', async () => {
    const { api } = chatTestApi()
    const onProgress = vi.fn()
    const first = [text(0, 'reasoning', '第一轮思考'), text(0, 'content', '第一段正文'), tool]
    const draw = (timeline: AgentChatTimelineSnapshot, final?: AgentMessage) => <Tooltip.Provider><ChatTimeline timeline={timeline} answer={final} api={api} active={!timeline.done} stopped={false} onProgress={onProgress} /></Tooltip.Provider>
    const view = render(draw(snapshot(first)))
    const firstArticle = screen.getByRole('article', { name: '助手回复' })
    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }))
    expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('第一轮思考')
    const all = [...first, text(1, 'reasoning', '第二轮思考'), text(1, 'content', '第二段正文'), text(2, 'reasoning', '末轮思考'), text(2, 'content', '终答预览')]
    view.rerender(draw(snapshot(all)))
    const articles = screen.getAllByRole('article', { name: '助手回复' })
    const finalArticle = articles.at(-1)
    expect(articles[0]).toBe(firstArticle)
    expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('第一轮思考')
    expect(screen.getAllByRole('button', { name: '展开思考内容' })).toHaveLength(2)
    const process = screen.getByLabelText('回复过程')
    expect(process.textContent).toMatch(/第一轮思考.*第一段正文.*docker_images_list.*第二轮思考.*第二段正文.*末轮思考.*终答预览/)
    view.rerender(draw(snapshot(all, true), answer))
    expect(screen.getAllByRole('article', { name: '助手回复' })).toHaveLength(3)
    expect(screen.getAllByRole('article', { name: '助手回复' }).at(-1)).toBe(finalArticle)
    expect(screen.getAllByText(answer.content)).toHaveLength(1)
    expect(screen.queryByText('终答预览')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '复制回复内容' })).toHaveLength(3)
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
    expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ message: '详情读取失败', tone: 'danger' })])
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

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatTimelineEntry, AgentChatTimelineSnapshot } from '@elysian/contracts'
import { chatTestApi } from '../../test/agentChatFixtures'
import { ChatTimeline } from './ChatTimeline'

type Tool = Extract<AgentChatTimelineEntry, { kind: 'tool' }>
const tool: Tool = { id: 'm:tool:t', kind: 'tool', tool: 'docker_image_pull', modelRequestId: 'm', modelCallId: 't', requestIndex: 0,
  callIndex: 0, callId: 'c', startedAt: '', status: 'waiting-task', argumentsJson: '{"id":"mysql:8.4"}', truncated: false }
const snapshot = (entry: Tool): AgentChatTimelineSnapshot => ({ runId: 'r', status: 'waiting-task', done: false, entries: [entry] })

describe('异步工具进度', () => {
  it('资源等待直接显示阻塞来源，未派发或中断时不显示执行动画', () => {
    const { api } = chatTestApi()
    const entry: Tool = { ...tool, callId: undefined, tool: 'docker_container_inspect', status: 'waiting-resource', resourceWait: {
      resource: 'docker-container:local:container', runId: 'old-run', operationId: 'old-operation', since: '2026-11-10T08:44:26Z', elapsedSeconds: 46, message: '等待其他操作释放资源', unknown: false,
    } }
    const view = render(<ChatTimeline timeline={snapshot(entry)} api={api} active stopped={false} onProgress={vi.fn()} />)
    expect(screen.getByText('等待资源')).toBeInTheDocument()
    expect(screen.getByText(/已等待 46 秒/)).toBeInTheDocument()
    expect(screen.getByText(/运行 old-run · 操作 old-operation/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    view.rerender(<ChatTimeline timeline={{ ...snapshot({ ...entry, status: 'not-executed', resourceWait: { ...entry.resourceWait!, unknown: true, message: '此前操作结果待核实' } }), status: 'interrupted', done: true }} api={api} active={false} stopped={false} onProgress={vi.fn()} />)
    expect(screen.getByText('未执行')).toBeInTheDocument()
    expect(screen.getByText(/此前操作结果待核实/)).toBeInTheDocument()
    expect(document.querySelector('.chat-tool-status-icon')).not.toHaveClass('animate-spin')
    expect(api.calls).not.toHaveBeenCalled()
  })
  it('未展开也显示当前镜像层的真实进度，切层不继承旧比例，完成后保留展开的结果', async () => {
    const { api } = chatTestApi()
    api.calls.mockResolvedValue([{ id: 'c', runId: 'r', tool: tool.tool, modelRequestId: 'm', modelCallId: 't', status: 'running', stepIndex: 0, args: {}, truncated: false }])
    const draw = (entry: Tool) => <ChatTimeline timeline={snapshot(entry)} api={api} active stopped={false} onProgress={vi.fn()} />
    const first: Tool = { ...tool, progress: { state: 'running', message: '正在下载镜像层', layerId: 'abcdef123456', currentBytes: 512, totalBytes: 1024 } }
    const view = render(draw(first))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(/512 B \/ 1.0 KiB · 50%/)).toBeInTheDocument()
    expect(screen.getByText(/当前层 abcdef123456/)).toBeInTheDocument()
    expect(api.calls).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `展开工具 ${tool.tool} 详情` }))
    await waitFor(() => expect(api.calls).toHaveBeenCalledOnce())
    view.rerender(draw({ ...tool, progress: { state: 'running', message: '正在解压镜像层', layerId: 'other-layer' } }))
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/50%/)).not.toBeInTheDocument()
    view.rerender(draw({ ...first, progress: { ...first.progress!, currentBytes: 0 } }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    api.calls.mockResolvedValue([{ id: 'c', runId: 'r', tool: tool.tool, modelRequestId: 'm', modelCallId: 't', status: 'succeeded', stepIndex: 0, args: {}, truncated: false, result: { state: 'succeeded' } }])
    view.rerender(draw({ ...first, status: 'succeeded' }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(await screen.findByText(/"succeeded"/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `收起工具 ${tool.tool} 详情` })).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([
    ['website_deployment_submit', '安装依赖、测试与构建'],
    ['container_app_build_submit', '打包构建上下文'],
    ['database_create', '正在执行数据库任务'],
    ['docker_image_pull', '正在准备镜像拉取'],
  ])('刷新后 %s 从快照恢复阶段，不编造百分比', (name, message) => {
    const { api } = chatTestApi()
    render(<ChatTimeline timeline={snapshot({ ...tool, tool: name, progress: { state: 'running', message } })} api={api} active stopped={false} onProgress={vi.fn()} />)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(api.calls).not.toHaveBeenCalled()
  })

  it('结果未确认时停止进度动画并常驻显示原因，旧任务没有进度字段仍能展示', () => {
    const { api } = chatTestApi()
    const draw = (entry: Tool) => <ChatTimeline timeline={snapshot(entry)} api={api} active stopped={false} onProgress={vi.fn()} />
    const view = render(draw(tool))
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    const message = 'Docker 连续 5 分钟未返回拉取数据，结果未确认，禁止重新拉取或换源重投'
    view.rerender(draw({ ...tool, progress: { state: 'unknown', message } }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('结果未确认')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(document.querySelector('.chat-tool-status-icon')).not.toHaveClass('animate-spin')
  })
})

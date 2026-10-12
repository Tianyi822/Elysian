import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { AgentChatPage } from './AgentChatPage'

function renderChat() {
  const gateway = createMockGateway({ eventStream: 'memory' })
  const runtime = vi.spyOn(gateway.agentRuntime, 'runtime')
  const view = render(<MemoryRouter><Tooltip.Provider><GatewayProvider gateway={gateway}><AgentChatPage /></GatewayProvider></Tooltip.Provider></MemoryRouter>)
  return { ...view, runtime }
}

beforeEach(async () => { await useAgentChatStore.getState().newSession() })

describe('智能体会话输入', () => {
  it('输入法确认和 Shift+Enter 不发送，Enter 将消息留在本地', async () => {
    const { runtime } = renderChat()
    const textbox = await screen.findByRole('textbox', { name: '发送给 Ely 的消息' })
    fireEvent.change(textbox, { target: { value: '检查最近的服务日志' } })
    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(useAgentChatStore.getState().session?.messages).toHaveLength(0)
    fireEvent.compositionEnd(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(useAgentChatStore.getState().session?.messages).toHaveLength(0)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(await screen.findByText('检查最近的服务日志', { selector: 'p' })).toBeInTheDocument()
    expect(textbox).toHaveValue('')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    expect(runtime).not.toHaveBeenCalled()
  })

  it('允许不同类型的多文件附件，移除后只发送保留的文件', async () => {
    renderChat()
    const input = screen.getByLabelText('添加会话附件')
    fireEvent.change(input, { target: { files: [new File(['{}'], 'config.json', { type: 'application/json' }), new File(['pdf'], 'report.pdf', { type: 'application/pdf' })] } })
    const attachments = await screen.findByRole('list', { name: '待发送附件' })
    expect(within(attachments).getByText('config.json')).toBeInTheDocument()
    expect(within(attachments).getByText('report.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除附件 config.json' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    expect(useAgentChatStore.getState().session?.messages[0]?.attachments.map(file => file.name)).toEqual(['report.pdf'])
    expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument()
  })

  it('并发拖放与粘贴尚未全部完成时，不提前允许发送', async () => {
    renderChat()
    const finishes: (() => void)[] = []
    const original = useAgentChatStore.getState().addAttachments
    useAgentChatStore.setState({ addAttachments: () => new Promise<void>(resolve => { finishes.push(resolve) }) })
    try {
      const textbox = screen.getByRole('textbox', { name: '发送给 Ely 的消息' })
      fireEvent.change(textbox, { target: { value: '分析这些文件' } })
      fireEvent.paste(textbox, { clipboardData: { files: [new File(['1'], 'a.txt')] } })
      fireEvent.drop(screen.getByRole('region', { name: 'Ely 会话' }), { dataTransfer: { types: ['Files'], files: [new File(['2'], 'b.txt')] } })
      expect(finishes).toHaveLength(2)
      await act(async () => finishes[0]?.())
      expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
      fireEvent.keyDown(textbox, { key: 'Enter' })
      expect(useAgentChatStore.getState().session?.messages).toHaveLength(0)
      await act(async () => finishes[1]?.())
      expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled()
    } finally { act(() => useAgentChatStore.setState({ addAttachments: original })) }
  })
})

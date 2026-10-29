import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { advanceAuthGeneration } from '../../adapters/http/unauthorized'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { SessionRenameDialog } from './SessionRenameDialog'
import { SessionRemoveDialog } from './SessionRemoveDialog'

const originalActions = {
  renameSession: useAgentChatStore.getState().renameSession,
  deleteSession: useAgentChatStore.getState().deleteSession,
  reportOperation: useAgentChatStore.getState().reportOperation,
}

beforeEach(async () => {
  useAgentChatStore.getState().clearDisplay()
  await useAgentChatStore.getState().newSession()
})

afterEach(() => {
  useAgentChatStore.setState(originalActions)
})

describe.each([
  { name: '重命名', Dialog: SessionRenameDialog, action: 'renameSession' as const, button: '确认重命名' },
  { name: '删除', Dialog: SessionRemoveDialog, action: 'deleteSession' as const, button: '确认删除' },
])('$name 弹窗通知归属', ({ Dialog, action, button }) => {
  it.each(['unmount', 'target', 'session', 'auth'] as const)('%s 变化后忽略旧请求的迟到错误', async changed => {
    const report = vi.fn()
    let reject!: (error: Error) => void
    const operation = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    useAgentChatStore.setState({ [action]: operation, reportOperation: report })
    const gateway = createMockGateway({ eventStream: 'memory' })
    const onClose = vi.fn()
    const dialog = (id: string) => <GatewayProvider gateway={gateway}><Dialog target={{ id, title: `会话 ${id}` }} onClose={onClose} /></GatewayProvider>
    const view = render(dialog('a'))
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(operation).toHaveBeenCalledOnce()
    if (changed === 'unmount') view.unmount()
    else if (changed === 'target') view.rerender(dialog('b'))
    else if (changed === 'session') await act(() => useAgentChatStore.getState().newSession())
    else advanceAuthGeneration()
    await act(async () => { reject(new Error('旧请求失败')) })
    expect(report).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('当前请求失败仅上报一次并保留弹窗', async () => {
    const report = vi.fn()
    useAgentChatStore.setState({ [action]: vi.fn().mockRejectedValueOnce(new Error('请稍后重试')), reportOperation: report })
    const gateway = createMockGateway({ eventStream: 'memory' })
    const onClose = vi.fn()
    render(<GatewayProvider gateway={gateway}><Dialog target={{ id: 'a', title: '会话 A' }} onClose={onClose} /></GatewayProvider>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: button })) })
    expect(report).toHaveBeenCalledExactlyOnceWith('请稍后重试')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('请稍后重试')
    expect(screen.getByRole('button', { name: button })).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

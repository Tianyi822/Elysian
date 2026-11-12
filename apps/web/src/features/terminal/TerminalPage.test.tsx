import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandTerminalProps } from '../../components/terminal/CommandTerminal'
import { renderApp } from '../../test/renderApp'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { createMockGateway } from '../../adapters/mock/gateway'
vi.mock('../../components/terminal/CommandTerminal', () => ({
  CommandTerminal: (props: CommandTerminalProps) => <div role="log" data-session={props.sessionKey} style={{ fontSize: props.fontSize }} onWheel={event => { if (event.ctrlKey) props.onFontZoom?.(event.deltaY < 0 ? 1 : -1) }}><button onClick={() => void props.execute('help')}>执行演示命令</button>{props.prompt}</div>,
}))
vi.mock('../../components/terminal/RawTerminalViewport', () => ({ RawTerminalViewport: ({ sessionKey }: { sessionKey: string }) => <div data-testid="raw-terminal">{sessionKey}</div> }))
beforeEach(() => useTerminalsStore.getState().resetLocal())
describe('终端页面集成', () => {
  it('自动创建会话并显示第三方 REPL，命令交给演示适配器', async () => {
    const gateway = createMockGateway()
    const execute = vi.spyOn(gateway.terminals, 'executeCommand')
    renderApp('/terminals', { gateway })
    const button = await screen.findByRole('button', { name: '执行演示命令' })
    fireEvent.click(button)
    expect(execute).toHaveBeenCalledWith(expect.any(String), 'help')
    expect(screen.getByRole('log')).toHaveAttribute('data-session', expect.stringContaining('host:'))
  })
  it('建立多个会话并经过确认关闭，关闭最后一个保持空态', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway()
    renderApp('/terminals', { gateway })
    await screen.findByRole('log')
    await user.click(screen.getByRole('button', { name: '新建终端' }))
    await waitFor(() => expect(useTerminalsStore.getState().sessions).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: '关闭 ops@elysian-demo 1' }))
    expect(screen.getByRole('dialog', { name: '确认关闭终端？' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(useTerminalsStore.getState().sessions).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '关闭 ops@elysian-demo' }))
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(await screen.findByText('还没有终端会话')).toBeInTheDocument()
  })
  it('字体按钮和滚轮共用像素字号', async () => {
    const user = userEvent.setup()
    renderApp('/terminals')
    const log = await screen.findByRole('log')
    expect(log).toHaveStyle({ fontSize: '12px' })
    await user.click(screen.getByRole('button', { name: '放大终端字体' }))
    expect(log).toHaveStyle({ fontSize: '14px' })
    fireEvent.wheel(log, { deltaY: -10, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '15px' })
  })
})

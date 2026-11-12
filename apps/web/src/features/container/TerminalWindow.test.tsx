import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { CONTAINERS } from '../../adapters/mock/containersData'
import { useContainersStore } from '../../stores/containersStore'
import type { CommandTerminalProps } from '../../components/terminal/CommandTerminal'
import { TerminalWindow } from './TerminalWindow'
vi.mock('../../components/terminal/CommandTerminal', () => ({ CommandTerminal: (props: CommandTerminalProps) => <div role="log" style={{ fontSize: props.fontSize }} data-interactive={props.interactive} onWheel={event => { if (event.ctrlKey) props.onFontZoom?.(event.deltaY < 0 ? 1 : -1) }} /> }))
function mount() {
  useContainersStore.setState({ containers: [...CONTAINERS], terminal: { containerId: 'ctr-nginx-proxy', sessionId: 'mock', status: 'connected', prompt: '$ ' } })
  return render(<GatewayProvider gateway={createMockGateway()}><TerminalWindow /></GatewayProvider>)
}
beforeEach(() => useContainersStore.setState({ terminal: undefined }))
describe('容器终端弹窗', () => {
  it('第三方 REPL 接收字号缩放并限制边界', () => {
    mount()
    const log = screen.getByRole('log')
    fireEvent.wheel(log, { deltaY: -100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '13px' })
    for (let index = 0; index < 30; index++) fireEvent.wheel(log, { deltaY: -100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '24px' })
  })
  it('连接中和断开原因明确展示，断开后第三方 REPL 禁止输入', () => {
    mount()
    act(() => useContainersStore.setState(state => ({ terminal: state.terminal && { ...state.terminal, status: 'connecting' } })))
    expect(screen.getByRole('status')).toHaveTextContent('正在连接')
    act(() => useContainersStore.setState(state => ({ terminal: state.terminal && { ...state.terminal, status: 'error', errorMessage: '连接已中断' } })))
    expect(screen.getByRole('alert')).toHaveTextContent('连接已中断')
    expect(screen.getByRole('log')).toHaveAttribute('data-interactive', 'false')
  })
})

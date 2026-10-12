import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { CONTAINERS } from '../../adapters/mock/containersData'
import type { ElysianGateway } from '../../contracts/adapters'
import { useContainersStore } from '../../stores/containersStore'
import { TerminalWindow } from './TerminalWindow'

/*
 * 容器终端弹窗壳的字号缩放：与平台终端页同一口径（terminalFontSize 像素连续值），
 * 弹窗以 useState 持有、不持久化。这里只锚定壳层接线，键位与栅格行为由内核用例覆盖。
 */

function gatewayStub(): ElysianGateway {
  return {
    containers: {
      completeTerminal: (_sessionId: string, draft: string, cursor: number) => ({ draft, cursor }),
    },
  } as unknown as ElysianGateway
}

function mountTerminalWindow() {
  useContainersStore.setState({
    containers: [...CONTAINERS],
    terminal: {
      containerId: 'ctr-nginx-proxy',
      sessionId: 'sess-test',
      prompt: '$ ',
      awaitingPrompt: false,
      status: 'connected',
      lines: [],
      history: [],
    },
  })
  return render(
    <GatewayProvider gateway={gatewayStub()}>
      <TerminalWindow />
    </GatewayProvider>,
  )
}

describe('TerminalWindow 字号缩放', () => {
  beforeEach(() => {
    useContainersStore.setState({ containers: [], terminal: undefined })
  })

  it('Ctrl+滚轮缩放字号，向上放大、向下缩小', () => {
    mountTerminalWindow()
    const log = screen.getByRole('log')
    expect(log).toHaveStyle({ fontSize: '12px' })

    fireEvent.wheel(log, { deltaY: -100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '13px' })

    fireEvent.wheel(log, { deltaY: 100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '12px' })
  })

  it('字号夹在边界内：连滚不越上限 24px，也不跌破下限 10px', () => {
    mountTerminalWindow()
    const log = screen.getByRole('log')

    for (let i = 0; i < 30; i += 1) fireEvent.wheel(log, { deltaY: -100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '24px' })

    for (let i = 0; i < 40; i += 1) fireEvent.wheel(log, { deltaY: 100, ctrlKey: true })
    expect(log).toHaveStyle({ fontSize: '10px' })
  })

  it('不带 Ctrl/Cmd 修饰键的滚轮不改字号', () => {
    mountTerminalWindow()
    const log = screen.getByRole('log')
    fireEvent.wheel(log, { deltaY: -100 })
    expect(log).toHaveStyle({ fontSize: '12px' })
  })

  it('连接中与失败时保留状态行并禁止提交，连接成功后恢复提示符', () => {
    mountTerminalWindow()
    act(() => useContainersStore.setState((state) => ({
      terminal: state.terminal && {
        ...state.terminal,
        status: 'connecting',
        lines: [{ kind: 'output', text: '正在连接容器终端…' }],
      },
    })))
    expect(screen.getByRole('log')).toHaveTextContent('正在连接容器终端…')
    expect(screen.getByLabelText('命令输入')).toBeDisabled()

    act(() => useContainersStore.setState((state) => ({
      terminal: state.terminal && {
        ...state.terminal,
        status: 'error',
        lines: [{ kind: 'output', text: '连接容器终端失败' }],
      },
    })))
    expect(screen.getByRole('log')).toHaveTextContent('连接容器终端失败')
    expect(screen.getByLabelText('命令输入')).toBeDisabled()

    act(() => useContainersStore.setState((state) => ({
      terminal: state.terminal && { ...state.terminal, status: 'connected', lines: [] },
    })))
    expect(screen.getByLabelText('命令输入')).toBeEnabled()
    expect(screen.getByRole('log')).toHaveTextContent('$')
  })

  it('容器命令运行时保留输入但隐藏 Shell 提示符，prompt 帧到达后恢复', () => {
    mountTerminalWindow()
    act(() => useContainersStore.setState((state) => ({
      terminal: state.terminal && { ...state.terminal, awaitingPrompt: true },
    })))
    expect(screen.getByLabelText('命令输入')).toBeEnabled()
    expect(screen.getByRole('log')).not.toHaveTextContent('$')
    act(() => useContainersStore.getState().applyTerminalFrame('sess-test', { type: 'prompt', prompt: '$ ' }))
    expect(screen.getByRole('log')).toHaveTextContent('$')
  })
})

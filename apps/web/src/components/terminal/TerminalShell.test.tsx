import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { pushHistory, recallHistory, type TerminalLine } from './terminalSession'
import { TerminalShell } from './TerminalShell'

/**
 * 受控壳：lines 与 history 由外层 useState 持有，onSubmit 按契约回填——
 * input 行只存裸命令，提示符由 TerminalShell 渲染时拼在行首。
 * 文案、提示符与补全引擎全部用非容器默认值，证明内核不私藏领域词。
 */
function Harness({
  sessionKey = 'session-a',
  complete = (draft: string, cursor: number) => ({ draft, cursor }),
  onClose = () => {},
  fontSize,
  onFontZoom,
  interactive = true,
}: {
  sessionKey?: string
  complete?: (draft: string, cursor: number) => { draft: string; cursor: number }
  onClose?: () => void
  fontSize?: number
  onFontZoom?: (deltaPx: number) => void
  interactive?: boolean
}) {
  const [lines, setLines] = useState<readonly TerminalLine[]>([
    { kind: 'banner', text: '欢迎 · mock 数据' },
  ])
  const [history, setHistory] = useState<readonly string[]>([])
  return (
    <>
      <div data-testid="outside">终端外部</div>
      <TerminalShell
        title="演示会话"
        banner="演示会话 · mock"
        subject="db-main"
        prompt="sql> "
        sessionKey={sessionKey}
        lines={lines}
        history={history}
        onSubmit={(command) => {
          setHistory((prev) => pushHistory(prev, command))
          setLines((prev) => [
            ...prev,
            { kind: 'input', text: command },
            { kind: 'output', text: `执行：${command}` },
          ])
        }}
        complete={complete}
        onAppendOutput={(appended) =>
          setLines((prev) => [
            ...prev,
            ...appended.map((text): TerminalLine => ({ kind: 'output', text })),
          ])
        }
        onClear={() => setLines([])}
        onClose={onClose}
        fontSize={fontSize}
        onFontZoom={onFontZoom}
        interactive={interactive}
        labels={{
          input: '语句输入',
          close: '关闭会话',
          confirmTitle: '确认关闭会话？',
          confirmDescription: '会话历史将不再保留。',
          confirmCancel: '继续使用',
          confirmAccept: '确认关闭',
        }}
      />
    </>
  )
}

describe('终端交互内核', () => {
  it('打开即聚焦命令输入，顶栏标注与主体文案来自 props', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: '演示会话' })
    expect(within(dialog).getByText('演示会话 · mock')).toBeInTheDocument()
    expect(within(dialog).getByText('db-main')).toBeInTheDocument()
    const input = within(dialog).getByLabelText('语句输入')
    expect(document.activeElement).toBe(input)
  })

  it('连接中由关闭按钮接收焦点，连接后聚焦输入框，弹窗容器不画蓝框', () => {
    const view = render(<Harness interactive={false} />)
    const dialog = screen.getByRole('dialog', { name: '演示会话' })
    expect(dialog).toHaveClass('focus-visible:outline-none')
    expect(screen.getByRole('button', { name: '关闭会话' })).toHaveFocus()
    view.rerender(<Harness interactive />)
    expect(screen.getByLabelText('语句输入')).toHaveFocus()
    view.rerender(<Harness interactive={false} />)
    expect(screen.getByRole('button', { name: '关闭会话' })).toHaveFocus()
  })

  it('回车提交后，日志里的输入行是提示符与裸命令在同一行拼接', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByLabelText('语句输入')

    await user.type(input, 'demo one{Enter}')

    expect(await screen.findByText('sql> demo one')).toBeInTheDocument()
    expect(screen.getByRole('log')).toHaveTextContent('执行：demo one')
  })

  it('↑ 召回上一条历史，↓ 回到新输入', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByLabelText('语句输入')
    await user.type(input, 'first{Enter}')
    await user.type(input, 'second{Enter}')

    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('second')
    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('first')
    await user.type(input, '{ArrowDown}')
    expect(input).toHaveValue('second')
    await user.type(input, '{ArrowDown}')
    expect(input).toHaveValue('')
  })

  it('Tab 走 complete 的结果补全草稿', async () => {
    const user = userEvent.setup()
    const complete = vi.fn((draft: string, cursor: number) =>
      draft === 'hel' ? { draft: 'help ', cursor: 5 } : { draft, cursor },
    )
    render(<Harness complete={complete} />)
    const input = screen.getByLabelText('语句输入')

    await user.type(input, 'hel')
    // Tab 用 fireEvent 派发：userEvent 造出的 keydown 不可取消，会抢走焦点。
    fireEvent.keyDown(input, { key: 'Tab' })

    expect(complete).toHaveBeenCalledWith('hel', 3)
    expect(input).toHaveValue('help ')
  })

  it('外部点击与 Esc 都不关闭终端', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '演示会话' })).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.getByRole('dialog', { name: '演示会话' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点关闭先出确认框，取消不关，确认后才调 onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: '关闭会话' }))
    const confirm = await screen.findByRole('dialog', { name: '确认关闭会话？' })
    expect(confirm.textContent).toContain('会话历史将不再保留')

    await user.click(within(confirm).getByRole('button', { name: '继续使用' }))
    expect(screen.getByRole('dialog', { name: '演示会话' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '关闭会话' }))
    await user.click(await screen.findByRole('button', { name: '确认关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sessionKey 变化重置草稿与历史游标', async () => {
    const user = userEvent.setup()
    const view = render(<Harness sessionKey="session-a" />)
    const input = screen.getByLabelText('语句输入')

    await user.type(input, 'stale draft')
    view.rerender(<Harness sessionKey="session-b" />)

    expect(input).toHaveValue('')
  })

  it('fontSize 与 onFontZoom 透传给视口：字号落到日志区，Ctrl+滚轮触发缩放回调', () => {
    const onFontZoom = vi.fn()
    render(<Harness fontSize={14} onFontZoom={onFontZoom} />)
    const log = screen.getByRole('log')
    expect(log).toHaveStyle({ fontSize: '14px' })

    fireEvent.wheel(log, { deltaY: -120, ctrlKey: true })
    expect(onFontZoom).toHaveBeenCalledWith(1)

    fireEvent.wheel(log, { deltaY: 120, ctrlKey: true })
    expect(onFontZoom).toHaveBeenCalledWith(-1)
  })

  it('不传 fontSize 时日志区用终端基准字号，滚轮保持原生滚动', () => {
    render(<Harness />)
    expect(screen.getByRole('log')).toHaveStyle({ fontSize: '12px' })
  })
})

describe('terminalSession 纯函数', () => {
  it('pushHistory 连续重复只记一次', () => {
    expect(pushHistory([], 'ls')).toEqual(['ls'])
    expect(pushHistory(['ls'], 'ls')).toEqual(['ls'])
    expect(pushHistory(['ls'], 'env')).toEqual(['ls', 'env'])
  })

  it('recallHistory 游标语义：length 是新输入，两端夹紧', () => {
    const history = ['ls', 'env']
    expect(recallHistory(history, null, -1)).toEqual({ draft: 'env', index: 1 })
    expect(recallHistory(history, 1, -1)).toEqual({ draft: 'ls', index: 0 })
    expect(recallHistory(history, 0, -1)).toEqual({ draft: 'ls', index: 0 })
    expect(recallHistory(history, 0, 1)).toEqual({ draft: 'env', index: 1 })
    expect(recallHistory(history, 1, 1)).toEqual({ draft: '', index: 2 })
    expect(recallHistory(history, 2, 1)).toEqual({ draft: '', index: 2 })
  })
})

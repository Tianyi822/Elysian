import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { pushHistory, type TerminalLine } from './terminalSession'
import { TerminalViewport } from './TerminalViewport'

function ViewportHarness({
  sessionKey = 'session-a',
  inputLabel = '命令输入',
}: {
  sessionKey?: string
  inputLabel?: string
}) {
  const [lines, setLines] = useState<readonly TerminalLine[]>([
    { kind: 'banner', text: '欢迎 · mock 数据' },
  ])
  const [history, setHistory] = useState<readonly string[]>([])
  return (
    <TerminalViewport
      prompt="$ "
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
      complete={(draft, cursor) => ({ draft, cursor })}
      onAppendOutput={(appended) =>
        setLines((prev) => [
          ...prev,
          ...appended.map((text): TerminalLine => ({ kind: 'output', text })),
        ])
      }
      onClear={() => setLines([])}
      inputLabel={inputLabel}
    />
  )
}

describe('终端嵌入视口', () => {
  it('不渲染 dialog，打开即聚焦命令输入', () => {
    render(<ViewportHarness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const input = screen.getByLabelText('命令输入')
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('log')).toBeInTheDocument()
  })

  it('两枚视口的输入 id 互不相同，且不使用写死的 terminal-input', () => {
    render(
      <>
        <ViewportHarness inputLabel="会话甲输入" />
        <ViewportHarness inputLabel="会话乙输入" />
      </>,
    )
    const first = screen.getByLabelText('会话甲输入')
    const second = screen.getByLabelText('会话乙输入')
    expect(first.id).toBeTruthy()
    expect(second.id).toBeTruthy()
    expect(first.id).not.toBe(second.id)
    expect(first.id).not.toBe('terminal-input')
    expect(second.id).not.toBe('terminal-input')
  })

  it('回车提交后日志把提示符与裸命令拼在同一行', async () => {
    const user = userEvent.setup()
    render(<ViewportHarness />)
    await user.type(screen.getByLabelText('命令输入'), 'whoami{Enter}')
    expect(await screen.findByText('$ whoami')).toBeInTheDocument()
    expect(screen.getByText('执行：whoami')).toBeInTheDocument()
  })
})

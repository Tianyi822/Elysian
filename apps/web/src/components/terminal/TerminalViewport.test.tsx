import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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

  it('未接字号缩放通道时滚轮不接管，弹窗终端保持原生滚动', () => {
    render(<ViewportHarness />)
    const log = screen.getByRole('log')
    const event = new WheelEvent('wheel', {
      deltaY: -120,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    log.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('已提交输入行保留提交时的提示符，活动行使用当前提示符', () => {
    render(
      <TerminalViewport
        prompt="root@host:/$ "
        sessionKey="s"
        lines={[
          { kind: 'input', text: 'pwd', prompt: 'root@host:~$ ' },
          { kind: 'output', text: '/root' },
        ]}
        history={[]}
        onSubmit={() => {}}
        complete={(draft, cursor) => ({ draft, cursor })}
        onAppendOutput={() => {}}
        onClear={() => {}}
        inputLabel="命令输入"
      />,
    )
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('root@host:~$ pwd')
    expect(log).toHaveTextContent('/root')
    expect(log).toHaveTextContent('root@host:/$')
    expect(screen.getByText('root@host:~$ pwd')).toBeInTheDocument()
    expect(screen.queryByText('root@host:/$ pwd')).not.toBeInTheDocument()
  })

  it('日志区保留连续空白，补位对齐的输出不错列', () => {
    const aligned = 'drwxr-xr-x  22 root root  704 Sep 22 17:27 app'
    render(
      <TerminalViewport
        prompt="$ "
        sessionKey="s"
        lines={[{ kind: 'output', text: aligned }]}
        history={[]}
        onSubmit={() => {}}
        complete={(draft, cursor) => ({ draft, cursor })}
        onAppendOutput={() => {}}
        onClear={() => {}}
        inputLabel="命令输入"
      />,
    )
    const log = screen.getByRole('log')
    expect(log).toHaveClass('whitespace-pre-wrap')
    expect(log.querySelector('p')?.textContent).toBe(aligned)
  })

  it('宽字符各占固定两格宽的盒子，半角文本不拆分；空行保留一行高', () => {
    render(
      <TerminalViewport
        prompt="$ "
        sessionKey="s"
        lines={[
          { kind: 'output', text: '| 1  | 巡检 |' },
          { kind: 'output', text: '' },
          { kind: 'output', text: 'total 84' },
        ]}
        history={[]}
        onSubmit={() => {}}
        complete={(draft, cursor) => ({ draft, cursor })}
        onAppendOutput={() => {}}
        onClear={() => {}}
        inputLabel="命令输入"
      />,
    )
    const [table, blank, plain] = Array.from(screen.getByRole('log').querySelectorAll('p'))
    const cells = Array.from(table!.querySelectorAll('span'))
    expect(cells.map((cell) => cell.textContent)).toEqual(['巡', '检'])
    expect(cells.every((cell) => cell.classList.contains('w-[2ch]'))).toBe(true)
    expect(table!.textContent).toBe('| 1  | 巡检 |')
    expect(blank).toHaveClass('min-h-[1lh]')
    expect(plain!.querySelector('span')).toBeNull()
    expect(screen.getByText('total 84')).toBeInTheDocument()
  })

  it('Tab 多候选按 ls -C 的方式分栏列出', async () => {
    const user = userEvent.setup()
    const appended: string[] = []
    render(
      <TerminalViewport
        prompt="$ "
        sessionKey="s"
        lines={[]}
        history={[]}
        onSubmit={() => {}}
        complete={(draft, cursor) => ({ draft, cursor, candidates: ['cat', 'chmod', 'chown', 'clear'] })}
        onAppendOutput={(lines) => appended.push(...lines)}
        onClear={() => {}}
        inputLabel="命令输入"
      />,
    )
    await user.type(screen.getByLabelText('命令输入'), 'c{Tab}')
    expect(appended).toEqual(['cat  chmod  chown  clear'])
  })

  it('回车提交后日志把提示符与裸命令拼在同一行', async () => {
    const user = userEvent.setup()
    render(<ViewportHarness />)
    await user.type(screen.getByLabelText('命令输入'), 'whoami{Enter}')
    expect(await screen.findByText('$ whoami')).toBeInTheDocument()
    expect(screen.getByRole('log')).toHaveTextContent('执行：whoami')
  })

  it('Ctrl+C 落本地 ^C 外观并调 onInterrupt；不传 onInterrupt 时只有本地外观', async () => {
    const user = userEvent.setup()
    const onInterrupt = vi.fn()
    const hooked = render(<InterruptHarness onInterrupt={onInterrupt} label="挂接中断的输入" />)

    await user.type(screen.getByLabelText('挂接中断的输入'), 'sleep{Control>}c{/Control}')
    expect(screen.getByRole('log')).toHaveTextContent('$ sleep^C')
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    // 草稿清空：中断后的下一次输入从空行开始。
    await user.type(screen.getByLabelText('挂接中断的输入'), 'x')
    expect(screen.getByRole('log')).toHaveTextContent('$ x')
    hooked.unmount()

    render(<InterruptHarness label="未挂接中断的输入" />)
    await user.type(screen.getByLabelText('未挂接中断的输入'), 'top{Control>}c{/Control}')
    expect(screen.getByRole('log')).toHaveTextContent('$ top^C')
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('Cmd+C 是复制不是中断：日志区有选区时写剪贴板，草稿与日志不动', async () => {
    const user = userEvent.setup()
    const onInterrupt = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(
      <InterruptHarness onInterrupt={onInterrupt} label="复制输入" lines={[{ kind: 'output', text: 'copy-target-123' }]} />,
    )

    selectWithinLog('copy-target-123')
    await user.type(screen.getByLabelText('复制输入'), 'draf')
    // 用 fireEvent 直发按键：user-event 自带 cmd/ctrl+c 的剪贴板拦截，会污染断言。
    fireEvent.keyDown(screen.getByLabelText('复制输入'), { key: 'c', metaKey: true })
    expect(writeText).toHaveBeenCalledWith('copy-target-123')
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('log')).not.toHaveTextContent('^C')
  })

  it('Cmd+C 无选区时既不中断也不写剪贴板', async () => {
    const user = userEvent.setup()
    const onInterrupt = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<InterruptHarness onInterrupt={onInterrupt} label="复制输入" />)

    await user.type(screen.getByLabelText('复制输入'), 'abc')
    fireEvent.keyDown(screen.getByLabelText('复制输入'), { key: 'c', metaKey: true })
    expect(writeText).not.toHaveBeenCalled()
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('log')).not.toHaveTextContent('^C')
  })

  it('选中即复制：日志内 mouseup 时非空选区写入剪贴板', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<InterruptHarness label="选中输入" lines={[{ kind: 'output', text: 'select-on-mouseup-42' }]} />)

    selectWithinLog('select-on-mouseup-42')
    fireEvent.mouseUp(screen.getByRole('log'))
    expect(writeText).toHaveBeenCalledWith('select-on-mouseup-42')
  })

  it('mouseup 时选区为空或不落在日志内不写剪贴板', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(
      <>
        <p>log 外的文本 outside-text</p>
        <InterruptHarness label="选中输入" lines={[{ kind: 'output', text: 'inside-text' }]} />
      </>,
    )

    // 选区落在日志外
    selectTextInNode(screen.getByText(/log 外的文本/).firstChild!, 'outside-text')
    fireEvent.mouseUp(screen.getByRole('log'))
    // 日志内的空选区（collapsed）
    const log = screen.getByRole('log')
    window.getSelection()?.removeAllRanges()
    fireEvent.mouseUp(log)
    expect(writeText).not.toHaveBeenCalled()
  })
})

/** Ctrl+C 用例的 harness：把 onAppendOutput 的行真正收集进日志（^C 外观经它落屏）。 */
function InterruptHarness({
  onInterrupt,
  label,
  lines: initialLines,
}: {
  onInterrupt?: () => void
  label: string
  lines?: readonly TerminalLine[]
}) {
  const [lines, setLines] = useState<readonly TerminalLine[]>(initialLines ?? [])
  return (
    <TerminalViewport
      prompt="$ "
      sessionKey="s"
      lines={lines}
      history={[]}
      onSubmit={() => {}}
      complete={(draft, cursor) => ({ draft, cursor })}
      onAppendOutput={(appended) =>
        setLines((prev) => [
          ...prev,
          ...appended.map((text): TerminalLine => ({ kind: 'output', text })),
        ])
      }
      onClear={() => setLines([])}
      onInterrupt={onInterrupt}
      inputLabel={label}
    />
  )
}

/** jsdom 里给 navigator 装剪贴板桩；每个用例自备新的 writeText。 */
function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

/** 在日志内找到含目标文本（纯 ASCII，TerminalText 不会拆分）的文本节点并选中它。 */
function selectWithinLog(text: string) {
  const log = screen.getByRole('log')
  const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  while ((node = walker.nextNode()) !== null) {
    const content = node.textContent ?? ''
    const start = content.indexOf(text)
    if (start !== -1) {
      selectTextInNode(node, text)
      return
    }
  }
  throw new Error(`日志内未找到目标文本：${text}`)
}

/** 在指定文本节点上建立精确选区。 */
function selectTextInNode(node: Node, text: string) {
  const content = node.textContent ?? ''
  const start = content.indexOf(text)
  if (start === -1) throw new Error(`节点内未找到目标文本：${text}`)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

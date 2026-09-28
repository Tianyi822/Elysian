import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import {
  formatTerminalColumns,
  recallHistory,
  type TerminalCompletion,
  type TerminalLine,
} from './terminalSession'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_WHEEL_STEP,
} from './terminalFontSize'
import { TerminalText } from './TerminalText'

/**
 * 终端交互内核的嵌入视口：没有弹窗壳，给页面内会话与弹窗壳共用。
 *
 * 形态是真终端：没有独立输入条，活动提示行（提示符 + 草稿 + 反色块光标）跟在日志末尾，
 * 键入汇点是一枚 sr-only 的 input——可打印字符与退格由它原生编辑（输入法因此可用），
 * Tab、方向键与 Ctrl 组合键在 keydown 里接管，光标位置经 onSelect 回读进模型。
 *
 * input 行存裸语句。行上带提交时的提示符快照时用快照，否则用当前提示符拼在行首。
 * 活动行始终用当前提示符。提示符随工作目录变化时，已提交的行保持提交当时的样子。
 * 复制口径：Ctrl+C 恒为中断，Cmd+C 恒为复制（macOS 习惯，原生 Cmd+C 会复制到
 * input 的不可见选区上，所以复制由内核接管）；选中即复制，mouseup 收尾时写入剪贴板。
 * 日志按终端栅格排版：保留连续空白（ls -l、SQL 结果表靠空格补位对齐）、宽字符固定两格、
 * 空行保留一行高，Tab 候选按 ls -C 的方式分栏列出。
 * 输入 id 用 useId 生成，同页多会话不会撞到写死的 terminal-input。
 */

export type TerminalViewportProps = {
  prompt: string
  sessionKey: string
  lines: readonly TerminalLine[]
  history: readonly string[]
  onSubmit: (command: string) => void
  complete: (draft: string, cursor: number) => TerminalCompletion
  onAppendOutput: (lines: readonly string[]) => void
  onClear: () => void
  /**
   * Ctrl+C 的领域侧通道（本机真实终端与容器终端经它发 interrupt 帧到 PTY）。
   * 可选：不传则只有本地 ^C 外观，行为逐字节不变（SQL 会话弹窗不传）。
   */
  onInterrupt?: () => void
  inputLabel: string
  /** 连接中或已断开时保留日志，但隐藏活动提示行并禁止键入。 */
  interactive?: boolean
  /** 日志区字号（px），由页面持有；缺省为终端基准字号。 */
  fontSize?: number
  /**
   * Ctrl/Cmd + 滚轮的字号缩放通道（正值放大、负值缩小）。
   * 可选：不传则滚轮保持原生滚动，弹窗里的终端不受影响。
   */
  onFontZoom?: (deltaPx: number) => void
  /** 缺省挂载即聚焦；弹窗壳依赖它赢过 Radix FocusScope。 */
  autoFocus?: boolean
  className?: string
  /**
   * Tab 捕获范围。缺省为视口自身；弹窗把 Dialog.Content 传进来，
   * 让关闭按钮上的 Tab 也回到命令行。
   */
  trapRootRef?: RefObject<HTMLElement | null>
}

export function TerminalViewport({
  prompt,
  sessionKey,
  lines,
  history,
  onSubmit,
  complete,
  onAppendOutput,
  onClear,
  onInterrupt,
  inputLabel,
  interactive = true,
  fontSize = TERMINAL_FONT_SIZE_DEFAULT,
  onFontZoom,
  autoFocus = true,
  className,
  trapRootRef,
}: TerminalViewportProps) {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const attachInput = (node: HTMLTextAreaElement | null) => {
    inputRef.current = node
    if (autoFocus && interactive) node?.focus()
  }
  useEffect(() => {
    if (autoFocus && interactive) inputRef.current?.focus()
  }, [autoFocus, interactive])
  // 输入法组合态与「组合刚结束」的一次性标记：组合中的回车是确认候选而非发送。
  // Safari 派发确认回车的 keydown 晚于 compositionend（isComposing 已为 false），
  // 只能靠该标记吞掉这一枚；setTimeout(0) 复位保证之后的人工回车不受影响。
  const composingRef = useRef(false)
  const swallowEnterRef = useRef(false)

  useEffect(() => {
    setDraft('')
    setCursor(0)
    setHistoryIndex(null)
  }, [sessionKey])

  useEffect(() => {
    // jsdom 未实现 Element.scrollTo，可选调用让测试环境降级为 no-op，浏览器行为不变。
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight })
  }, [lines.length, draft])

  useEffect(() => {
    const input = inputRef.current
    if (input && document.activeElement === input) input.setSelectionRange(cursor, cursor)
  }, [draft, cursor])

  /**
   * Ctrl/Cmd + 滚轮缩放字号。监听器只能自己挂：React 的 onWheel 在根上是 passive 的，
   * 里面 preventDefault 无效，浏览器会把它当成页面缩放。触控板的捏合手势也走 ctrlKey，
   * 因此同一通道顺带覆盖双指缩放。
   */
  useEffect(() => {
    const log = logRef.current
    if (!log || !onFontZoom) return
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      onFontZoom((event.deltaY < 0 ? 1 : -1) * TERMINAL_FONT_SIZE_WHEEL_STEP)
    }
    log.addEventListener('wheel', onWheel, { passive: false })
    return () => log.removeEventListener('wheel', onWheel)
  }, [onFontZoom])

  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!interactive) return
      if (event.key !== 'Tab') return
      const root = trapRootRef?.current ?? rootRef.current
      if (!root || !root.contains(event.target as Node | null)) return
      if (document.activeElement === inputRef.current) return
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDownCapture, true)
    return () => document.removeEventListener('keydown', onKeyDownCapture, true)
  }, [interactive, trapRootRef])

  const recall = (direction: -1 | 1) => {
    if (!history.length) return
    const { draft: nextDraft, index: next } = recallHistory(history, historyIndex, direction)
    setHistoryIndex(next)
    setDraft(nextDraft)
    setCursor(nextDraft.length)
  }

  const submit = () => {
    const command = draft
    setDraft('')
    setCursor(0)
    setHistoryIndex(null)
    onSubmit(command)
  }

  const runCompletion = () => {
    const result = complete(draft, cursor)
    if (result.candidates) {
      onAppendOutput(formatTerminalColumns(result.candidates))
      return
    }
    setDraft(result.draft)
    setCursor(result.cursor)
  }

  const interrupt = () => {
    onAppendOutput([`${prompt}${draft}^C`])
    setDraft('')
    setCursor(0)
    setHistoryIndex(null)
    onInterrupt?.()
  }

  /**
   * 复制必须在这里接管：键入焦点在 sr-only input 上，原生 Cmd+C 复制的是 input
   * 里的（不可见的）选区而不是日志区高亮。Ctrl+C 恒为中断，Cmd+C 恒为复制
   * （macOS 习惯）；选区两端都落在日志内才复制，写失败静默降级。
   */
  const copyLogSelection = () => {
    const selection = window.getSelection()
    const log = logRef.current
    if (!selection || selection.isCollapsed || !log) return
    const anchor = selection.anchorNode
    const focus = selection.focusNode
    if (!anchor || !focus || !log.contains(anchor) || !log.contains(focus)) return
    const text = selection.toString()
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!interactive) return
    if (event.nativeEvent.isComposing || composingRef.current) return
    if (event.key === 'Enter') {
      if (event.shiftKey) return
      if (swallowEnterRef.current) {
        swallowEnterRef.current = false
        return
      }
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      runCompletion()
      return
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !draft.includes('\n')) {
      event.preventDefault()
      recall(event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'c' && event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        copyLogSelection()
      } else if (key === 'c') {
        event.preventDefault()
        interrupt()
      } else if (key === 'l') {
        event.preventDefault()
        onClear()
      } else if (key === 'u') {
        event.preventDefault()
        setDraft(draft.slice(cursor))
        setCursor(0)
      } else if (key === 'k') {
        event.preventDefault()
        setDraft(draft.slice(0, cursor))
      } else if (key === 'a') {
        event.preventDefault()
        setCursor(0)
      } else if (key === 'e') {
        event.preventDefault()
        setCursor(draft.length)
      }
    }
  }

  return (
    <div ref={rootRef} className={['flex min-h-0 flex-1 flex-col', className].filter(Boolean).join(' ')}>
      <label htmlFor={inputId} className="sr-only">
        {inputLabel}
      </label>
      <textarea
        id={inputId}
        ref={attachInput}
        value={draft}
        disabled={!interactive}
        onChange={(event) => {
          setDraft(event.target.value)
          setCursor(event.target.selectionStart ?? event.target.value.length)
        }}
        onSelect={(event) =>
          setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
        }
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          swallowEnterRef.current = true
          window.setTimeout(() => {
            swallowEnterRef.current = false
          }, 0)
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        className="sr-only"
      />

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        onClick={() => { if (interactive) inputRef.current?.focus() }}
        onMouseUp={copyLogSelection}
        style={{ fontSize }}
        className="min-w-0 flex-1 cursor-text overflow-auto whitespace-pre px-4 py-3 font-mono leading-relaxed text-fg"
      >
        {lines.map((line, index) => (
          <p
            key={index}
            className={[
              'min-h-[1lh]',
              line.kind === 'input' ? 'text-accent' : line.kind === 'banner' ? 'text-warning' : undefined,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <TerminalText
              text={line.kind === 'input' ? `${line.prompt ?? prompt}${line.text}` : line.text}
            />
          </p>
        ))}
        {interactive ? <p aria-hidden="true">
          <span className="text-success">
            <TerminalText text={prompt} />
          </span>
          <TerminalText text={draft.slice(0, cursor)} />
          <span className="bg-fg text-bg motion-safe:animate-caret-blink">
            <TerminalText text={draft.slice(cursor, cursor + 1) || ' '} />
          </span>
          <TerminalText text={draft.slice(cursor + 1)} />
        </p> : null}
      </div>
    </div>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { recallHistory, type TerminalCompletion, type TerminalLine } from './terminalSession'

/**
 * 终端交互内核的嵌入视口：没有弹窗壳，给页面内会话与弹窗壳共用。
 *
 * 形态是真终端：没有独立输入条，活动提示行（提示符 + 草稿 + 反色块光标）跟在日志末尾，
 * 键入汇点是一枚 sr-only 的 input——可打印字符与退格由它原生编辑（输入法因此可用），
 * Tab、方向键与 Ctrl 组合键在 keydown 里接管，光标位置经 onSelect 回读进模型。
 *
 * input 行只存裸语句，提示符由本组件渲染时拼在行首（提示符只有一个家）。
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
  inputLabel: string
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
  inputLabel,
  autoFocus = true,
  className,
  trapRootRef,
}: TerminalViewportProps) {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const attachInput = (node: HTMLInputElement | null) => {
    inputRef.current = node
    if (autoFocus) node?.focus()
  }
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

  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
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
  }, [trapRootRef])

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
      onAppendOutput([result.candidates.join('  ')])
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
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return
    if (event.key === 'Enter') {
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
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      recall(event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'c') {
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
      <input
        id={inputId}
        ref={attachInput}
        value={draft}
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
        onClick={() => inputRef.current?.focus()}
        className="flex-1 cursor-text overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-fg"
      >
        {lines.map((line, index) => (
          <p
            key={index}
            className={
              line.kind === 'input'
                ? 'text-accent'
                : line.kind === 'banner'
                  ? 'text-warning'
                  : undefined
            }
          >
            {line.kind === 'input' ? `${prompt}${line.text}` : line.text}
          </p>
        ))}
        <p aria-hidden="true" className="whitespace-pre-wrap break-all">
          <span className="text-success">{prompt}</span>
          {draft.slice(0, cursor)}
          <span className="bg-fg text-bg motion-safe:animate-caret-blink">
            {draft.slice(cursor, cursor + 1) || ' '}
          </span>
          {draft.slice(cursor + 1)}
        </p>
      </div>
    </div>
  )
}

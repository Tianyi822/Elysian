import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { recallHistory, type TerminalCompletion, type TerminalLine } from './terminalSession'

/**
 * 终端交互内核：外部点击与 Esc 一律拦截，唯一关闭路径是
 * 关闭按钮 → 确认对话框 → 确认关闭。输出区用语义令牌配色。
 *
 * 形态是真终端：没有独立输入条，活动提示行（提示符 + 草稿 + 反色块光标）跟在日志末尾，
 * 键入汇点是一枚 sr-only 的 input——可打印字符与退格由它原生编辑（输入法因此可用），
 * Tab、方向键与 Ctrl 组合键在 keydown 里接管，光标位置经 onSelect 回读进模型。
 *
 * 领域差异全部经 props 注入：标注、主体、提示符、命令引擎、补全引擎与关闭文案；
 * input 行只存裸语句，提示符由本组件渲染时拼在行首（提示符只有一个家）。
 */

export type TerminalShellProps = {
  /** Dialog.Title（sr-only）：弹窗的无障碍名称。 */
  title: string
  /** 顶栏的演示标注徽章文案。 */
  banner: string
  /** 顶栏的主体名称（会话面向的对象，如服务名、连接名）。 */
  subject: string
  /** 提示符：input 行渲染时拼在行首，行文本本身不带。 */
  prompt: string
  /** 会话标识：变化时重置草稿与历史游标。 */
  sessionKey: string
  lines: readonly TerminalLine[]
  history: readonly string[]
  /** 提交裸命令（未 trim），引擎自行决定取舍。 */
  onSubmit: (command: string) => void
  complete: (draft: string, cursor: number) => TerminalCompletion
  onAppendOutput: (lines: readonly string[]) => void
  onClear: () => void
  onClose: () => void
  labels: {
    input: string
    close: string
    confirmTitle: string
    confirmDescription: string
    confirmCancel: string
    confirmAccept: string
  }
}

function ConfirmCloseDialog({
  open,
  labels,
  onCancel,
  onConfirm,
}: {
  open: boolean
  labels: TerminalShellProps['labels']
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">{labels.confirmTitle}</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">{labels.confirmDescription}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              {labels.confirmCancel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger"
            >
              {labels.confirmAccept}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function TerminalShell({
  title,
  banner,
  subject,
  prompt,
  sessionKey,
  lines,
  history,
  onSubmit,
  complete,
  onAppendOutput,
  onClear,
  onClose,
  labels,
}: TerminalShellProps) {
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  // 输入框在 Portal 的第二次提交才挂载，打开时的 effect 里 ref 还是 null；
  // 挂载即聚焦才能赢过 Radix FocusScope 交给关闭按钮的首焦点。
  const attachInput = (node: HTMLInputElement | null) => {
    inputRef.current = node
    node?.focus()
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
    setConfirmOpen(false)
  }, [sessionKey])

  useEffect(() => {
    // jsdom 未实现 Element.scrollTo，可选调用让测试环境降级为 no-op，浏览器行为不变。
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight })
  }, [lines.length, draft])

  // 程序改写草稿（历史召回、补全、Ctrl 组合键）后，把隐藏输入的光标摆回模型位置。
  useEffect(() => {
    const input = inputRef.current
    if (input && document.activeElement === input) input.setSelectionRange(cursor, cursor)
  }, [draft, cursor])

  // Tab 只服务命令行：窗口内除输入框自身（Tab 用于补全）外，任何元素上的 Tab
  // 都拦掉默认行为与冒泡，把焦点送回命令行，避免 Tab 选中终端里的其他网页组件。
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const content = contentRef.current
      if (!content || !content.contains(event.target as Node | null)) return
      if (document.activeElement === inputRef.current) return
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDownCapture, true)
    return () => document.removeEventListener('keydown', onKeyDownCapture, true)
  }, [])

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
    // 无法再收敛时按 bash 的习惯把候选列出来，草稿不动。
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
    if (event.nativeEvent.isComposing || composingRef.current) return // 组合中的键全部留给输入法
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
    // 其余键（可打印字符、退格、←→、Home/End）交给隐藏输入原生编辑，光标经 onSelect 回读。
  }

  return (
    <Dialog.Root open onOpenChange={() => {/* 外部来源全部忽略，只能走关闭确认 */}}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex h-[min(44rem,calc(100vh-3rem))] w-[min(72rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                {banner}
              </span>
              <span className="text-fg-muted">{subject}</span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              {labels.close}
            </button>
          </div>

          <label htmlFor="terminal-input" className="sr-only">
            {labels.input}
          </label>
          <input
            id="terminal-input"
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
                {/* 提示符只有一个家：input 行只存裸语句，渲染时在同一 <p> 里拼在行首。 */}
                {line.kind === 'input' ? `${prompt}${line.text}` : line.text}
              </p>
            ))}
            {/* 活动提示行对读屏隐藏：草稿的值由上面那枚带 label 的输入承载，避免读两遍。 */}
            <p aria-hidden="true" className="whitespace-pre-wrap break-all">
              <span className="text-success">{prompt}</span>
              {draft.slice(0, cursor)}
              <span className="bg-fg text-bg motion-safe:animate-caret-blink">
                {draft.slice(cursor, cursor + 1) || ' '}
              </span>
              {draft.slice(cursor + 1)}
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      <ConfirmCloseDialog
        open={confirmOpen}
        labels={labels}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          onClose()
        }}
      />
    </Dialog.Root>
  )
}

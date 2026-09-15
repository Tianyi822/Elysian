import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { completeTerminalCommand } from '../../adapters/mock/containerTerminal'
import { useContainersStore } from '../../stores/containersStore'

/**
 * 演示终端窗口：外部点击与 Esc 一律拦截，唯一关闭路径是
 * 「关闭终端」→ 确认对话框 →「确认关闭」。输出区用语义令牌配色。
 *
 * 形态是真终端：没有独立输入条，活动提示行（$ + 草稿 + 反色块光标）跟在日志末尾，
 * 键入汇点是一枚 sr-only 的 input——可打印字符与退格由它原生编辑（输入法因此可用），
 * Tab、方向键与 Ctrl 组合键在 keydown 里接管，光标位置经 onSelect 回读进模型。
 */

function ConfirmCloseDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
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
          <Dialog.Title className="text-sm font-semibold">确认关闭终端？</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">会话历史将不再保留。</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              继续使用
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger"
            >
              确认关闭
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function TerminalWindow() {
  const gateway = useGateway()
  const terminal = useContainersStore((s) => s.terminal)
  const container = useContainersStore((s) =>
    s.containers.find((candidate) => candidate.id === s.terminal?.containerId),
  )
  const submitCommand = useContainersStore((s) => s.submitCommand)
  const appendTerminalOutput = useContainersStore((s) => s.appendTerminalOutput)
  const clearTerminalScreen = useContainersStore((s) => s.clearTerminalScreen)
  const closeTerminal = useContainersStore((s) => s.closeTerminal)

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
    if (terminal) {
      setDraft('')
      setCursor(0)
      setHistoryIndex(null)
      setConfirmOpen(false)
    }
  }, [terminal?.containerId])

  useEffect(() => {
    // jsdom 未实现 Element.scrollTo，可选调用让测试环境降级为 no-op，浏览器行为不变。
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight })
  }, [terminal?.lines.length, draft])

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

  if (!terminal || !container) return null

  const recall = (direction: -1 | 1) => {
    const history = terminal.history
    if (!history.length) return
    // 游标语义：history.length 表示「回到新输入」，0..length-1 指向历史条目。
    const position = historyIndex ?? history.length
    const next =
      direction === -1 ? Math.max(0, position - 1) : Math.min(history.length, position + 1)
    const nextDraft = next === history.length ? '' : (history[next] ?? '')
    setHistoryIndex(next)
    setDraft(nextDraft)
    setCursor(nextDraft.length)
  }

  const submit = () => {
    const command = draft
    setDraft('')
    setCursor(0)
    setHistoryIndex(null)
    void submitCommand(gateway, command)
  }

  const complete = () => {
    const result = completeTerminalCommand(draft, cursor)
    // 无法再收敛时按 bash 的习惯把候选列出来，草稿不动。
    if (result.candidates) {
      appendTerminalOutput([result.candidates.join('  ')])
      return
    }
    setDraft(result.draft)
    setCursor(result.cursor)
  }

  const interrupt = () => {
    appendTerminalOutput([`$ ${draft}^C`])
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
      complete()
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
        clearTerminalScreen()
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
    <Dialog.Root open onOpenChange={() => {/* 外部来源全部忽略，只能走关闭终端确认 */}}>
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
          <Dialog.Title className="sr-only">{container.name} 终端</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                演示终端 · 待接入真实执行
              </span>
              <span className="text-fg-muted">{container.name}</span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              关闭终端
            </button>
          </div>

          <label htmlFor="terminal-input" className="sr-only">
            命令输入
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
            {terminal.lines.map((line, index) => (
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
                {line.text}
              </p>
            ))}
            {/* 活动提示行对读屏隐藏：草稿的值由上面那枚带 label 的输入承载，避免读两遍。 */}
            <p aria-hidden="true" className="whitespace-pre-wrap break-all">
              <span className="text-success">$ </span>
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
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          closeTerminal()
        }}
      />
    </Dialog.Root>
  )
}

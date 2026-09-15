import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useContainersStore } from '../../stores/containersStore'

/**
 * 演示终端窗口：外部点击与 Esc 一律拦截，唯一关闭路径是
 * 「关闭终端」→ 确认对话框 →「确认关闭」。输出区用语义令牌配色。
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
  const closeTerminal = useContainersStore((s) => s.closeTerminal)

  const [draft, setDraft] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (terminal) {
      setDraft('')
      setHistoryIndex(null)
      setConfirmOpen(false)
      inputRef.current?.focus()
    }
  }, [terminal?.containerId])

  useEffect(() => {
    // jsdom 未实现 Element.scrollTo，可选调用让测试环境降级为 no-op，浏览器行为不变。
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight })
  }, [terminal?.lines.length])

  if (!terminal || !container) return null

  const recall = (direction: -1 | 1) => {
    const history = terminal.history
    if (!history.length) return
    // 游标语义：history.length 表示「回到新输入」，0..length-1 指向历史条目。
    const cursor = historyIndex ?? history.length
    const next =
      direction === -1
        ? Math.max(0, cursor - 1)
        : Math.min(history.length, cursor + 1)
    setHistoryIndex(next)
    setDraft(next === history.length ? '' : (history[next] ?? ''))
  }

  const submit = () => {
    const command = draft
    setDraft('')
    setHistoryIndex(null)
    void submitCommand(gateway, command)
  }

  return (
    <Dialog.Root open onOpenChange={() => {/* 外部来源全部忽略，只能走关闭终端确认 */}}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex h-[32rem] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
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

          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-fg"
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
          </div>

          <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
            <label htmlFor="terminal-input" className="sr-only">
              命令输入
            </label>
            <span aria-hidden className="font-mono text-xs text-success">
              $
            </span>
            <input
              id="terminal-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
                else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  recall(-1)
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  recall(1)
                }
              }}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-transparent font-mono text-xs text-fg outline-none"
            />
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

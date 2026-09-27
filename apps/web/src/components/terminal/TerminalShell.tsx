import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { TerminalViewport } from './TerminalViewport'
import type { TerminalCompletion, TerminalLine } from './terminalSession'

/**
 * 终端交互内核的弹窗壳：外部点击与 Esc 一律拦截，唯一关闭路径是
 * 关闭按钮 → 确认对话框 → 确认关闭。输出区用语义令牌配色。
 *
 * 交互内核在 TerminalViewport；领域差异全部经 props 注入。
 */

export type TerminalShellProps = {
  /** Dialog.Title（sr-only）：弹窗的无障碍名称。 */
  title: string
  /** 顶栏的演示标注徽章文案。 */
  banner: string
  /** 顶栏的主体名称（会话面向的对象，如服务名、连接名）。 */
  subject: string
  /** 当前提示符：活动行用它；已提交的 input 行若自带快照则不被它覆盖。 */
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
  /** Ctrl+C 的领域侧通道；不传时仅本地 ^C 外观（如 SQL 弹窗）。 */
  onInterrupt?: () => void
  interactive?: boolean
  /** 日志区字号（px），由弹窗持有；缺省为终端基准字号。 */
  fontSize?: number
  /**
   * Ctrl/Cmd + 滚轮的字号缩放通道（正值放大、负值缩小）。
   * 可选：不传则滚轮保持原生滚动（如 SQL 弹窗）。
   */
  onFontZoom?: (deltaPx: number) => void
  labels: {
    input: string
    close: string
    confirmTitle: string
    confirmDescription: string
    confirmCancel: string
    confirmAccept: string
  }
}

export function ConfirmCloseDialog({
  open,
  title,
  description,
  cancelLabel,
  acceptLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  cancelLabel: string
  acceptLabel: string
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
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">{description}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger"
            >
              {acceptLabel}
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
  onInterrupt,
  interactive = true,
  fontSize,
  onFontZoom,
  labels,
}: TerminalShellProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!interactive) closeRef.current?.focus()
  }, [interactive])

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
          onOpenAutoFocus={(event) => {
            if (!interactive) {
              event.preventDefault()
              closeRef.current?.focus()
            }
          }}
          className="fixed left-1/2 top-1/2 z-[55] flex h-[min(44rem,calc(100vh-3rem))] w-[min(72rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl focus-visible:outline-none"
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
              ref={closeRef}
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              {labels.close}
            </button>
          </div>

          <TerminalViewport
            prompt={prompt}
            sessionKey={sessionKey}
            lines={lines}
            history={history}
            onSubmit={onSubmit}
            complete={complete}
            onAppendOutput={onAppendOutput}
            onClear={onClear}
            onInterrupt={onInterrupt}
            interactive={interactive}
            fontSize={fontSize}
            onFontZoom={onFontZoom}
            inputLabel={labels.input}
            trapRootRef={contentRef}
          />
        </Dialog.Content>
      </Dialog.Portal>

      <ConfirmCloseDialog
        open={confirmOpen}
        title={labels.confirmTitle}
        description={labels.confirmDescription}
        cancelLabel={labels.confirmCancel}
        acceptLabel={labels.confirmAccept}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          onClose()
        }}
      />
    </Dialog.Root>
  )
}

import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 弹窗只管理布局和关闭确认；终端内容由第三方组件持有。 */
export type TerminalShellProps = {
  title: string
  banner: string
  subject: string
  children: ReactNode
  onClose: () => void
  interactive?: boolean
  labels: {
    input?: string
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
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-80 -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
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

export function TerminalShell({ title, banner, subject, children, onClose, interactive = true, labels }: TerminalShellProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!interactive) closeRef.current?.focus() }, [interactive])

  return (
    <Dialog.Root open onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay-strong" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // Third-party terminal inputs initialize asynchronously and claim focus themselves.
            event.preventDefault()
            if (!interactive) closeRef.current?.focus()
          }}
          className="fixed left-1/2 top-1/2 z-[55] flex h-[min(44rem,calc(100vh-3rem))] w-[min(72rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl focus-visible:outline-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="shell-terminal-dialog-header flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">{banner}</span>
              <span className="truncate text-fg-muted">{subject}</span>
            </div>
            <button ref={closeRef} type="button" onClick={() => setConfirmOpen(true)} className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg">
              {labels.close}
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
      <ConfirmCloseDialog open={confirmOpen} title={labels.confirmTitle} description={labels.confirmDescription}
        cancelLabel={labels.confirmCancel} acceptLabel={labels.confirmAccept}
        onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); onClose() }} />
    </Dialog.Root>
  )
}

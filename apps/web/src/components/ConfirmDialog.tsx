import type { ReactElement, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from './Button'
import { DialogSurface, type DialogSurfaceProps } from './DialogSurface'
import { CTL_DANGER, CTL_PRIMARY, CTL_SECONDARY } from './formControl'

const cancelStyle = 'rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg'
const dangerStyle = 'rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50'

interface ConfirmDialogProps {
  open?: boolean
  title: ReactNode
  titleClassName?: string
  description?: ReactElement
  describe?: boolean
  children?: ReactNode
  confirmLabel: ReactNode
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  blockCloseWhileBusy?: boolean
  onConfirm(): void
  onClose(): void
  surface?: Omit<DialogSurfaceProps, 'children'>
  footerClassName?: string
  cancelClassName?: string
  confirmClassName?: string
}

export function ConfirmDialog({
  open = true, title, titleClassName = 'text-sm font-semibold', description, describe = false, children,
  confirmLabel, cancelLabel = '取消', danger = false, busy = false, blockCloseWhileBusy = false,
  onClose, onConfirm, surface, footerClassName = 'mt-4 flex justify-end gap-2',
  cancelClassName = cancelStyle, confirmClassName = danger ? dangerStyle : 'px-3',
}: ConfirmDialogProps) {
  const closeBlocked = busy && blockCloseWhileBusy
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !closeBlocked) onClose() }}>
      <DialogSurface {...(describe ? {} : { 'aria-describedby': undefined })} {...surface}>
        <Dialog.Title className={titleClassName}>{title}</Dialog.Title>
        {description && (describe ? <Dialog.Description asChild>{description}</Dialog.Description> : description)}
        {children}
        <div className={footerClassName}>
          <Dialog.Close asChild>
            <Button variant="outline" type="button" disabled={closeBlocked} className={`${CTL_SECONDARY} ${cancelClassName}`}>
              {cancelLabel}
            </Button>
          </Dialog.Close>
          <Button variant={danger ? 'destructive' : 'primary'} type="button" disabled={busy} onClick={onConfirm}
            className={`${danger ? CTL_DANGER : CTL_PRIMARY} ${confirmClassName}`}>
            {confirmLabel}
          </Button>
        </div>
      </DialogSurface>
    </Dialog.Root>
  )
}

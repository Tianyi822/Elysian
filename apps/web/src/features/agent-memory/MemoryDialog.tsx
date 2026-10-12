import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'

/*
 * 长期记忆模块共用的 Radix 弹窗骨架（照 RenameDialog 形态：Overlay bg-overlay＋
 * Content panel-surface，Dialog.Title 必写）。宽度按内容档位传入；关闭按钮带
 * 无障碍名。
 */
export function MemoryDialog({
  title,
  children,
  onClose,
  width = 'w-[min(28rem,calc(100vw-2rem))]',
}: {
  title: string
  children: ReactNode
  onClose(): void
  width?: string
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 z-[61] max-h-[min(38rem,calc(100vh-4rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto panel-surface p-4 shadow-xl ${width}`}
        >
          <div className="flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="关闭弹窗"
              className="rounded-lg border border-line p-1.5 text-fg-muted transition-colors hover:text-fg"
            >
              <X aria-hidden size={14} />
            </Dialog.Close>
          </div>
          <div className="mt-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

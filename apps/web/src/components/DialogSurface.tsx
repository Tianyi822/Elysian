import type { ComponentProps } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

const layers = {
  standard: ['z-[60]', 'z-[61]'],
  lower: ['z-50', 'z-[55]'],
  nested: ['z-[62]', 'z-[63]'],
} as const

export interface DialogSurfaceProps extends ComponentProps<typeof Dialog.Content> {
  layer?: keyof typeof layers
  preventOutsideDismiss?: boolean
}

/** Portal and surface only. The caller owns the Radix root and open state. */
export function DialogSurface({
  layer = 'standard', preventOutsideDismiss = false,
  className = 'w-[min(24rem,calc(100vw-2rem))] p-4 shadow-xl', ...content
}: DialogSurfaceProps) {
  const [overlayLayer, contentLayer] = layers[layer]
  return (
    <Dialog.Portal>
      <Dialog.Overlay className={`fixed inset-0 ${overlayLayer} bg-overlay`} />
      <Dialog.Content
        className={`fixed left-1/2 top-1/2 ${contentLayer} -translate-x-1/2 -translate-y-1/2 panel-surface ${className}`}
        onPointerDownOutside={preventOutsideDismiss ? (event) => event.preventDefault() : undefined}
        onInteractOutside={preventOutsideDismiss ? (event) => event.preventDefault() : undefined}
        {...content}
      />
    </Dialog.Portal>
  )
}

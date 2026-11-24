// EasyUI Sheet right-side variant. Radix owns modal presence and focus.
import * as Dialog from '@radix-ui/react-dialog'
import { motion, useDragControls, useReducedMotion } from 'framer-motion'
import { createContext, useContext, useRef, type ReactNode } from 'react'

const spring = { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 } as const
const Drag = createContext<ReturnType<typeof useDragControls> | null>(null)

export const Sheet = Dialog.Root
export const SheetTitle = Dialog.Title

export function SheetContent({ children, onDismiss }: { children: ReactNode; onDismiss(): void }) {
  const reduced = useReducedMotion()
  const controls = useDragControls()
  const previous = useRef<HTMLElement | null>(null)
  return <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
    <Dialog.Content asChild aria-describedby={undefined}
      onOpenAutoFocus={() => { previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
      onCloseAutoFocus={event => {
        if (!previous.current?.isConnected) return
        event.preventDefault()
        previous.current.focus({ preventScroll: true })
      }}>
      <motion.div
        data-easyui="sheet"
        className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full min-w-0 flex-col overflow-hidden border-l border-line bg-surface text-fg shadow-xl outline-none sm:max-w-[28rem] lg:max-w-[36rem] motion-safe:data-[state=closed]:animate-sheet-panel-out"
        initial={reduced ? false : { x: '100%' }} animate={{ x: 0 }}
        transition={reduced ? { duration: 0 } : spring}
        drag={reduced ? false : 'x'} dragControls={controls} dragListener={false}
        dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0, right: 0.6 }} dragMomentum={false}
        onDragEnd={(_, info) => { if (info.offset.x > 96 || info.velocity.x > 500) onDismiss() }}
      >
        <Drag.Provider value={reduced ? null : controls}>{children}</Drag.Provider>
      </motion.div>
    </Dialog.Content>
  </Dialog.Portal>
}

export function SheetHeader({ children }: { children: ReactNode }) {
  const controls = useContext(Drag)
  return <header className="shrink-0 touch-pan-y border-b border-line px-4 py-3 sm:px-5"
    onPointerDown={event => {
      if (event.pointerType === 'mouse' || (event.target instanceof Element && event.target.closest('button,a,input'))) return
      controls?.start(event)
    }}>{children}</header>
}

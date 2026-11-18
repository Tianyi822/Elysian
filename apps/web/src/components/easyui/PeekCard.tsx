/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya. MIT, see ./LICENSE.
 * Upstream: src/components/ui/PeekCard.tsx
 * Revision: f2287ce01ae6b6e7be28ca8d6a803dff91a20c96
 * Adaptations are recorded in ./upstream.json.
 */
import * as Popover from '@radix-ui/react-popover'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion'
import type { ComponentProps, ReactNode } from 'react'
import { motionTransitions } from './motion-tokens'
import './peekCard.css'

interface PeekCardProps {
  open: boolean
  ariaLabel: string
  placement: 'top' | 'bottom'
  align?: 'center' | 'end'
  appearance?: 'upstream' | 'login'
  onOpenAutoFocus?: ComponentProps<typeof Popover.Content>['onOpenAutoFocus']
  renderContent: () => ReactNode
}

/** Custom-content Peek Card inside a Radix Popover.Root. */
export function PeekCard({ open, ...props }: PeekCardProps) {
  return <AnimatePresence>{open && <PeekCardContent key="peek-card" {...props} />}</AnimatePresence>
}

function PeekCardContent({ ariaLabel, placement, align, appearance = 'upstream', onOpenAutoFocus, renderContent }: Omit<PeekCardProps, 'open'>) {
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()

  return (
    <Popover.Portal forceMount>
      <Popover.Content asChild side={placement} align={align} sideOffset={8} collisionPadding={8} aria-label={ariaLabel} onOpenAutoFocus={onOpenAutoFocus}>
        <motion.div
          aria-hidden={!present || undefined}
          inert={!present}
          data-easyui="peek-card"
          data-appearance={appearance}
          initial={reducedMotion ? false : { opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reducedMotion ? { opacity: 0, transition: { duration: 0 } }
            : { opacity: 0, y: 4, scale: 0.96, transition: { duration: 0.12 } }}
          transition={reducedMotion ? { duration: 0 } : motionTransitions.springSnappy}
          // Radix sets data-side after collision detection. Keep the official motion toward/from the trigger even after a flip.
          transformTemplate={({ y = '0px', scale = 1 }) => `translateY(calc(${y} * var(--peek-card-direction, 1))) scale(${scale})`}
          className={`easyui-peek-card z-50 w-72 sm:w-80 cursor-default rounded-[19.6px] border p-4 text-left ${
            appearance === 'login'
              ? 'border-login-line bg-login-card text-login-fg shadow-[0_16px_40px_var(--t-panel-shadow)]'
              : 'border-[#1F1F1F] bg-[#0E0E0E] shadow-[0_16px_40px_rgba(0,0,0,0.6)]'
          }`}
        >
          {renderContent()}
        </motion.div>
      </Popover.Content>
    </Popover.Portal>
  )
}

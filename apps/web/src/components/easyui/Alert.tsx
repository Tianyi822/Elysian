/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya - MIT, see ./LICENSE.
 * Upstream: src/components/ui/alert.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client'

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { cn } from './utils'

export type AlertTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const tones: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  neutral: {
    box: 'border-line bg-surface-raised',
    icon: 'text-fg-muted',
    Icon: Info,
  },
  info: {
    box: 'border-info/30 bg-info/10',
    icon: 'text-info',
    Icon: Info,
  },
  success: {
    box: 'border-success/30 bg-success/10',
    icon: 'text-success',
    Icon: CircleCheck,
  },
  warning: {
    box: 'border-warning/30 bg-warning/10',
    icon: 'text-warning',
    Icon: TriangleAlert,
  },
  danger: {
    box: 'border-danger/30 bg-danger/10',
    icon: 'text-danger',
    Icon: CircleAlert,
  },
}

export interface AlertProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  tone?: AlertTone
  /** Custom icon, or `false` for none. */
  icon?: React.ReactNode | false
  dismissible?: boolean
  /** Fires after the collapse animation finishes. */
  onDismiss?: () => void
  /** Right-side slot, e.g. a button. */
  action?: React.ReactNode
}

export function Alert({
  tone = 'neutral',
  icon,
  dismissible,
  onDismiss,
  action,
  className,
  children,
  ...props
}: AlertProps) {
  const [visible, setVisible] = React.useState(true)
  const t = tones[tone]

  return (
    <AnimatePresence initial={false} onExitComplete={onDismiss}>
      {visible && (
        <motion.div
          key="alert"
          initial={false}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
          className="overflow-hidden"
        >
          <div
            role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
            className={cn('flex items-start gap-3 rounded-xl border p-4 text-sm', t.box, className)}
            {...props}
          >
            {icon !== false && (
              <span className={cn('mt-0.5 shrink-0 [&>svg]:size-4', t.icon)}>{icon ?? <t.Icon />}</span>
            )}
            <div className="min-w-0 flex-1">{children}</div>
            {action && <div className="-my-1 shrink-0">{action}</div>}
            {dismissible && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setVisible(false)}
                className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-fg-subtle outline-none transition hover:bg-surface-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-focus active:scale-95"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('font-medium text-fg', className)} {...props} />
}

export function AlertDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('mt-0.5 text-fg-muted', className)} {...props} />
}

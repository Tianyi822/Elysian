/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya - MIT, see ./LICENSE.
 * Upstream: src/components/ui/stepper.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client'

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { cn } from './utils'

const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const
const fill = { duration: 0.35, ease: [0.32, 0.72, 0, 1] } as const

export interface Step {
  title: string
  description?: string
}

export interface StepperProps {
  steps: Step[]
  current: number
  completed?: boolean
  failed?: boolean
  ariaLabel?: string
  onStepChange?: (index: number) => void
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function Stepper({
  steps,
  current,
  completed = false,
  failed = false,
  ariaLabel = 'Progress',
  onStepChange,
  orientation = 'horizontal',
  className,
}: StepperProps) {
  const uid = React.useId()
  const reduced = useReducedMotion()
  const vertical = orientation === 'vertical'
  const last = steps.length - 1
  const active = Math.min(Math.max(current, 0), Math.max(last, 0))
  const ready = React.useRef(false)

  React.useEffect(() => {
    ready.current = true
  }, [])

  return (
    <ol aria-label={ariaLabel} className={cn(vertical ? 'flex flex-col' : 'flex w-full items-center', className)}>
      {steps.map((step, index) => {
        const state = completed
          ? 'complete'
          : failed && index === active
            ? 'failed'
            : index < active
              ? 'complete'
              : index === active
                ? 'current'
                : 'upcoming'
        const clickable = Boolean(onStepChange) && state === 'complete'
        const status = state === 'complete' ? '已完成' : state === 'failed' ? '失败' : state === 'current' ? '进行中' : '待执行'

        const indicator = (
          <span
            className={cn(
              'relative grid size-7 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums transition-colors duration-300',
              state === 'complete' && 'border-fg bg-fg text-surface',
              state === 'current' && 'border-fg text-fg',
              state === 'failed' && 'border-danger bg-danger/10 text-danger',
              state === 'upcoming' && 'border-line text-fg-subtle',
            )}
          >
            {state === 'current' && !reduced ? (
              <motion.span
                layoutId={`${uid}-ring`}
                transition={spring}
                className="absolute -inset-[5px] rounded-full border border-line"
              />
            ) : null}
            {state === 'failed' ? (
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            ) : state === 'complete' ? (
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <motion.path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  initial={ready.current && !reduced ? { pathLength: 0 } : false}
                  animate={{ pathLength: 1 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.3, delay: 0.08, ease: 'easeOut' }}
                />
              </svg>
            ) : index + 1}
          </span>
        )

        const label = (
          <span className={cn('flex min-w-0 flex-col text-left', !vertical && index !== active && 'hidden sm:flex')}>
            <span
              className={cn(
                'truncate text-sm transition-colors duration-300',
                state === 'upcoming' ? 'text-fg-subtle' : 'font-medium text-fg',
              )}
            >
              {step.title} <span className="sr-only">（{status}）</span>
            </span>
            {step.description ? <span className="truncate text-xs text-fg-muted">{step.description}</span> : null}
          </span>
        )

        const row = clickable ? (
          <button
            type="button"
            onClick={() => onStepChange?.(index)}
            className={cn(
              'flex gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
              vertical ? 'items-start' : 'items-center',
            )}
          >
            {indicator}
            {label}
          </button>
        ) : (
          <div className={cn('flex gap-3', vertical ? 'items-start' : 'items-center')}>
            {indicator}
            {label}
          </div>
        )

        return (
          <li
            key={step.title}
            aria-label={`${step.title}：${status}${step.description ? `，${step.description}` : ''}`}
            aria-current={state === 'current' || state === 'failed' ? 'step' : undefined}
            className={cn(vertical ? 'relative pb-7 last:pb-0' : 'flex items-center', !vertical && index < last && 'flex-1')}
          >
            {row}
            {index < last ? (
              <span
                aria-hidden
                className={cn(
                  'relative overflow-hidden bg-line',
                  vertical ? 'absolute bottom-1 left-[13.5px] top-[34px] w-px' : 'mx-3 h-px flex-1',
                )}
              >
                <motion.span
                  initial={false}
                  animate={vertical ? { scaleY: index < active || completed ? 1 : 0 } : { scaleX: index < active || completed ? 1 : 0 }}
                  transition={reduced ? { duration: 0 } : fill}
                  className={cn('absolute inset-0 bg-fg', vertical ? 'origin-top' : 'origin-left')}
                />
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

const slide: Variants = {
  enter: (direction: number) => ({ x: direction * 24, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction * -24, opacity: 0 }),
}

export interface StepPanelsProps {
  current: number
  children: React.ReactNode
  className?: string
}

export function StepPanels({ current, children, className }: StepPanelsProps) {
  const panels = React.Children.toArray(children)
  const reduced = useReducedMotion()
  const previous = React.useRef(current)
  const direction = current >= previous.current ? 1 : -1

  React.useEffect(() => {
    previous.current = current
  }, [current])

  const variants: Variants = reduced
    ? { enter: { x: 0, opacity: 0 }, center: { x: 0, opacity: 1 }, exit: { x: 0, opacity: 0 } }
    : slide

  return (
    <div className={className} aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={current}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={reduced ? { duration: 0 } : { duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          {panels[current]}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

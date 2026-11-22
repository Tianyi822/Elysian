/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya - MIT, see ./LICENSE.
 * Upstream: src/components/ui/stepper.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client'

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { observeElementSize } from '../../utils/observeElementSize'
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
  const activeTitle = steps[active]?.title
  const ready = React.useRef(false)
  const viewportRef = React.useRef<HTMLOListElement>(null)
  const activeStepRef = React.useRef<HTMLLIElement>(null)
  const previousViewport = React.useRef<HTMLOListElement | null>(null)
  const [scrollable, setScrollable] = React.useState(false)
  const rowClassName = cn(
    'flex min-w-0',
    vertical
      ? 'items-start gap-3 text-left'
      : 'w-full flex-col items-center gap-2 px-1.5 text-center',
  )

  React.useEffect(() => {
    ready.current = true
  }, [])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const step = activeStepRef.current
    if (!viewport || !step) {
      previousViewport.current = null
      setScrollable(false)
      return
    }

    let width = viewport.clientWidth
    const followStep = (behavior: ScrollBehavior) => {
      const overflowing = width > 0 && viewport.scrollWidth > width
      setScrollable(overflowing)
      if (!overflowing) return

      const bounds = step.getBoundingClientRect()
      const offset = bounds.left - viewport.getBoundingClientRect().left
      viewport.scrollTo({ left: viewport.scrollLeft + offset + (bounds.width - width) / 2, behavior })
    }

    followStep(previousViewport.current === viewport ? 'auto' : 'instant')
    previousViewport.current = viewport
    return observeElementSize([viewport], () => {
      if (viewport.clientWidth === width) return
      width = viewport.clientWidth
      followStep('instant')
    })
  }, [active, activeTitle, completed, failed, last, vertical])

  const list = (
    <motion.ol
      ref={vertical ? undefined : viewportRef}
      layoutScroll={!vertical}
      role="list"
      aria-label={ariaLabel}
      tabIndex={!vertical && scrollable ? 0 : undefined}
      className={cn(
        vertical ? 'flex flex-col' : [
          'table-scrollbar grid w-full min-w-0 auto-cols-[minmax(7rem,1fr)] grid-flow-col items-start',
          'overflow-x-auto overscroll-x-contain py-1.5 motion-safe:scroll-smooth',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
          '@min-[36rem]/stepper:auto-cols-fr @min-[36rem]/stepper:pb-0',
        ],
        className,
      )}
    >
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
          <span className={cn('flex min-w-0 flex-col', !vertical && 'w-full [overflow-wrap:anywhere]')}>
            <span
              className={cn(
                'text-sm transition-colors duration-300',
                vertical ? 'truncate' : 'text-balance',
                state === 'upcoming' ? 'text-fg-subtle' : 'font-medium text-fg',
              )}
            >
              {step.title} <span className="sr-only">（{status}）</span>
            </span>
            {step.description ? (
              <span className={cn('text-xs text-fg-muted', vertical ? 'truncate' : 'mt-0.5 hidden text-balance @min-[36rem]/stepper:block')}>
                {step.description}
              </span>
            ) : null}
          </span>
        )

        const row = clickable ? (
          <button
            type="button"
            onClick={() => onStepChange?.(index)}
            className={cn(rowClassName, 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus/50')}
          >
            {indicator}
            {label}
          </button>
        ) : (
          <div className={rowClassName}>
            {indicator}
            {label}
          </div>
        )

        return (
          <li
            key={step.title}
            ref={!vertical && index === active ? activeStepRef : undefined}
            aria-label={`${step.title}：${status}${step.description ? `，${step.description}` : ''}`}
            aria-current={state === 'current' || state === 'failed' ? 'step' : undefined}
            className={cn('relative min-w-0', vertical && 'pb-7 last:pb-0')}
          >
            {row}
            {index < last ? (
              <span
                aria-hidden
                className={cn(
                  'absolute overflow-hidden bg-line',
                  vertical
                    ? 'bottom-1 left-[13.5px] top-[34px] w-px'
                    : 'start-[calc(50%+1.375rem)] end-[calc(1.375rem-50%)] top-3.5 h-px',
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
    </motion.ol>
  )

  return vertical ? list : <div className="@container/stepper min-w-0">{list}</div>
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

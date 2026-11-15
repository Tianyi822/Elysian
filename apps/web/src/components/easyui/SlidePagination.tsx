/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/SlidePagination.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { useState, useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ChevronLeft, ChevronRight } from '../icons';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';
import './original-controls.css';
import { Button } from '../Button'

export interface SlidePaginationProps {
  /** Total number of pages */
  pageCount: number;
  /** Currently active page (controlled) */
  page?: number;
  /** Default active page (uncontrolled) */
  defaultPage?: number;
  /** Visible sibling count (pages shown around the current one) */
  siblingCount?: number;
  /** Page change callback */
  onChange?: (page: number) => void;
  /** Show previous / next buttons */
  showControls?: boolean;
  /** Stable name when several tables have independent pagination. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

function PageControl({ label, disabled, onPress, children }: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button unstyled type="button" aria-label={label} disabled={disabled} onClick={onPress}
          className={cn(
            'w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-[var(--easyui-pagination-radius)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-raised)] hover:border-[var(--border-hover)] transition-colors focus-ring cursor-pointer',
            disabled && 'opacity-30 cursor-not-allowed hover:bg-transparent hover:text-[var(--text-secondary)]'
          )}
        >{children}</Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
          {label}<Tooltip.Arrow className="fill-surface-raised" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * SlidePagination — Active indicator slides between pages rather than
 * instantly switching. The active background uses framer-motion's shared
 * layoutId so the indicator visibly travels from one item to the next.
 *
 * The visible page range stays focused on the current page and its siblings.
 */
export const SlidePagination: React.FC<SlidePaginationProps> = ({
  pageCount,
  page: controlledPage,
  defaultPage = 1,
  siblingCount = 1,
  onChange,
  showControls = true,
  ariaLabel = '分页',
  disabled = false,
  className,
}) => {
  const total = Math.max(1, Math.floor(pageCount));
  const [internalPage, setInternalPage] = useState<number>(() => Math.min(Math.max(1, defaultPage), total));
  const isControlled = controlledPage !== undefined;
  const current = Math.min(Math.max(1, isControlled ? controlledPage : internalPage), total);
  const layoutId = useId();
  const reduced = useReducedMotion();

  const setCurrent = (next: number) => {
    if (disabled) return;
    const clamped = Math.min(Math.max(1, next), total);
    if (!isControlled) setInternalPage(clamped);
    onChange?.(clamped);
  };

  // Build the page range with ellipsis.
  const range = (): (number | '…')[] => {
    const totalNumbers = siblingCount * 2 + 5; // siblings + first + last + current + 2 ellipsis
    if (total <= totalNumbers) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    const left = Math.max(current - siblingCount, 1);
    const right = Math.min(current + siblingCount, total);

    const showLeftEllipsis = left > 2;
    const showRightEllipsis = right < total - 1;

    const items: (number | '…')[] = [];

    if (!showLeftEllipsis && showRightEllipsis) {
      const leftRange = Array.from({ length: 3 + siblingCount * 2 }, (_, i) => i + 1);
      items.push(...leftRange, '…', total);
    } else if (showLeftEllipsis && !showRightEllipsis) {
      const rightRange = Array.from(
        { length: 3 + siblingCount * 2 },
        (_, i) => total - (3 + siblingCount * 2) + i + 1
      );
      items.push(1, '…', ...rightRange);
    } else if (showLeftEllipsis && showRightEllipsis) {
      items.push(1, '…', ...Array.from({ length: siblingCount * 2 + 1 }, (_, i) => left + i), '…', total);
    }

    return items;
  };

  const pages = range();

  return (
    <nav
      data-easyui="slide-pagination"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto select-none [scrollbar-width:none]',
        className
      )}
    >
      {showControls && (
        <PageControl label="上一页"
          disabled={disabled || current <= 1}
          onPress={() => setCurrent(current - 1)}
        >
          <ChevronLeft aria-hidden className="w-3.5 h-3.5" />
        </PageControl>
      )}

      <ul className="flex shrink-0 items-center gap-1">
        {pages.map((p, idx) => {
          if (p === '…') {
            return (
              <li
                key={`ellipsis-${idx}`}
                className="w-8 h-8 inline-flex items-center justify-center text-[var(--text-muted)] text-xs"
                aria-hidden="true"
              >
                …
              </li>
            );
          }

          const isActive = p === current;
          return (
            <li key={p}>
              <Button unstyled
                type="button"
                aria-current={isActive ? 'page' : undefined}
                aria-label={String(p)}
                disabled={disabled}
                onClick={() => setCurrent(p)}
                className={cn(
                  'relative w-8 h-8 inline-flex items-center justify-center rounded-[var(--easyui-pagination-radius)] text-xs font-medium transition-colors focus-ring cursor-pointer disabled:cursor-not-allowed disabled:opacity-30',
                  isActive
                    ? 'text-[var(--bg)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-raised)]'
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId={`slide-pagination-indicator-${layoutId}`}
                    data-pagination-indicator
                    className="absolute inset-0 rounded-[var(--easyui-pagination-radius)] bg-[var(--text-primary)] border border-[var(--text-primary)] shadow-xs"
                    initial={false}
                    aria-hidden="true"
                    transition={reduced ? { duration: 0 } : motionTransitions.springSnappy}
                  />
                )}
                <span className="relative z-10">{p}</span>
              </Button>
            </li>
          );
        })}
      </ul>

      {showControls && (
        <PageControl label="下一页"
          disabled={disabled || current >= total}
          onPress={() => setCurrent(current + 1)}
        >
          <ChevronRight aria-hidden className="w-3.5 h-3.5" />
        </PageControl>
      )}
    </nav>
  );
};

'use client';

import React, { useId, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ChevronDown } from '../icons';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export interface AccordionItem {
  id: string;
  title: string;
  subtitle?: string;
  content: React.ReactNode;
}

export interface SmoothAccordionProps {
  items: AccordionItem[];
  allowMultiple?: boolean;
  defaultOpen?: string[];
  className?: string;
}

export const SmoothAccordion: React.FC<SmoothAccordionProps> = ({
  items,
  allowMultiple = false,
  defaultOpen = [],
  className,
}) => {
  const baseId = useId();
  const reduced = useReducedMotion();
  const [openIds, setOpenIds] = useState<string[]>(defaultOpen);

  const toggle = (id: string) => {
    if (allowMultiple) {
      setOpenIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      );
    } else {
      setOpenIds((prev) => (prev.includes(id) ? [] : [id]));
    }
  };

  return (
    <div data-easyui="smooth-accordion" className={cn('flex flex-col divide-y divide-line rounded-xl border border-line bg-surface overflow-hidden', className)}>
      {items.map((item) => {
        const isOpen = openIds.includes(item.id);
        return (
          <div key={item.id} className="transition-colors">
            <h3>
            <button
              type="button" id={`${baseId}-${item.id}-button`} aria-controls={`${baseId}-${item.id}`}
              onClick={() => toggle(item.id)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left font-medium text-fg hover:bg-surface-hover transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus cursor-pointer"
              aria-expanded={isOpen}
            >
              <div>
                <div className="text-sm font-medium text-fg">{item.title}</div>
                {item.subtitle && (
                  <div className="text-xs text-fg-muted mt-0.5">{item.subtitle}</div>
                )}
              </div>
              <motion.div
                animate={{ rotate: isOpen ? 180 : 0 }}
                transition={reduced ? { duration: 0 } : motionTransitions.springSnappy}
                className="text-fg-subtle ml-2 shrink-0"
              >
                <ChevronDown className="w-4 h-4" />
              </motion.div>
            </button>
            </h3>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={`${baseId}-${item.id}`} aria-labelledby={`${baseId}-${item.id}-button`} key="content"
                  initial={reduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={reduced ? { duration: 0 } : motionTransitions.springGentle}
                  className="overflow-hidden"
                >
                  <div className="min-w-0 px-3 pb-3 pt-1 text-xs sm:text-sm text-fg-muted leading-relaxed">
                    {item.content}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
};

/**
 * EasyUI NotificationBell trigger, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/NotificationBell.tsx
 * The existing Radix message drawer owns the panel and focus lifecycle.
 */
'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { Bell } from 'lucide-react';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export interface NotificationBellProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  unread: boolean;
  arrivalKey?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export const NotificationBell = forwardRef<HTMLButtonElement, NotificationBellProps>(
  ({ unread, arrivalKey, isOpen, onOpenChange, className, onClick, ...props }, ref) => {
    const [isShaking, setIsShaking] = useState(false);
    const previousArrival = useRef(arrivalKey);
    const reduced = useReducedMotion();

    useEffect(() => {
      const arrived = previousArrival.current !== arrivalKey;
      previousArrival.current = arrivalKey;
      setIsShaking(false);
      if (!arrived || !unread || reduced) return;
      setIsShaking(true);
      const timer = setTimeout(() => setIsShaking(false), 600);
      return () => clearTimeout(timer);
    }, [arrivalKey, unread, reduced]);

    return (
      <motion.button
        data-easyui="notification-bell"
        ref={ref}
        type="button"
        onClick={event => {
          onClick?.(event);
          if (!event.defaultPrevented) onOpenChange(!isOpen);
        }}
        animate={isShaking && !reduced ? { rotate: [0, -12, 10, -8, 6, -2, 0] } : { rotate: 0 }}
        transition={{ duration: reduced ? 0 : 0.5, ease: 'easeInOut' }}
        whileHover={reduced ? undefined : { scale: 1.05 }}
        whileTap={reduced ? undefined : { scale: 0.95 }}
        aria-expanded={isOpen}
        aria-label="消息"
        className={cn(
          'relative inline-flex items-center justify-center rounded-full border transition-colors focus-ring cursor-pointer',
          isOpen
            ? 'bg-surface-raised border-control-line text-fg'
            : 'bg-surface border-control-line text-fg-muted hover:text-fg hover:bg-surface-raised',
          className
        )}
        {...props}
      >
        <Bell aria-hidden size={18} />
        <span aria-label={unread ? '有未读消息' : undefined}>
        <AnimatePresence>
          {unread && (
            <motion.span
              aria-hidden="true"
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={reduced ? { duration: 0 } : motionTransitions.springSnappy}
              className="absolute right-1 top-1 size-1.5 rounded-full bg-accent-fg"
            />
          )}
        </AnimatePresence>
        </span>
      </motion.button>
    );
  }
);

NotificationBell.displayName = 'NotificationBell';

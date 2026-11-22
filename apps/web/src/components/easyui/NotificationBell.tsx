/**
 * EasyUI NotificationBell trigger, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/notification-bell.tsx
 * The existing Radix message drawer owns the panel and focus lifecycle.
 */
'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { Bell } from 'lucide-react';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';
import { Button } from '../Button'

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
      <Button size="icon" variant="outline"
        data-easyui="notification-bell"
        ref={ref}
        type="button"
        onClick={event => {
          onClick?.(event);
          if (!event.defaultPrevented) onOpenChange(!isOpen);
        }}
        animate={isShaking && !reduced ? { rotate: [0, -12, 10, -8, 6, -2, 0] } : { rotate: 0 }}
        transition={{ duration: reduced ? 0 : 0.5, ease: 'easeInOut' }}
        aria-expanded={isOpen}
        aria-label="消息"
        data-unread={unread || undefined}
        className={cn(
          'size-8 rounded-full aria-expanded:bg-surface-raised [&>span]:size-full',
          className
        )}
        {...props}
      >
        <Bell aria-hidden size={14} />
        <AnimatePresence>
          {unread && (
            <motion.span
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={reduced ? { duration: 0 } : motionTransitions.springSnappy}
              className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-surface bg-danger"
              aria-hidden="true"
            />
          )}
        </AnimatePresence>
      </Button>
    );
  }
);

NotificationBell.displayName = 'NotificationBell';

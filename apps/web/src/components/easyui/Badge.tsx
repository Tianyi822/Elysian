/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/badge.tsx
 * Adaptations are recorded in ./upstream.json.
 */
"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "./utils";

const spring = { type: "spring", stiffness: 520, damping: 36, mass: 0.6 } as const;

export type BadgeVariant = "soft" | "solid" | "outline";
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const styles: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: {
    neutral: 'bg-surface-raised text-fg-muted',
    info: 'bg-info/10 text-info',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
  },
  solid: {
    neutral: 'bg-fg text-surface',
    info: 'bg-info/10 text-info border-info/40',
    success: 'bg-success/10 text-success border-success/40',
    warning: 'bg-warning/10 text-warning border-warning/40',
    danger: 'bg-danger/10 text-danger border-danger/40',
  },
  outline: {
    neutral: 'border-line text-fg-muted',
    info: 'border-info/40 text-info',
    success: 'border-success/40 text-success',
    warning: 'border-warning/40 text-warning',
    danger: 'border-danger/40 text-danger',
  },
};

const dots: Record<BadgeTone, string> = {
  neutral: 'bg-current', info: 'bg-info', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger',
};

export type BadgeProps = Omit<HTMLMotionProps<"span">, "children"> & {
  variant?: BadgeVariant;
  tone?: BadgeTone;
  /** Leading status dot. */
  dot?: boolean;
  /** Soft ping on the dot, use for live status only. */
  pulse?: boolean;
  animateChanges?: boolean;
  /** Shows an × button (chip). */
  onRemove?: () => void;
  children?: React.ReactNode;
};

export function Badge({
  variant = "soft",
  tone = "neutral",
  dot,
  pulse,
  animateChanges = true,
  onRemove,
  className,
  children,
  ...props
}: BadgeProps) {
  // strings & numbers roll when they change (counts, status labels)
  const reduced = useReducedMotion();
  const roll = animateChanges && !reduced && (typeof children === "string" || typeof children === "number");

  return (
    <motion.span
      data-easyui="badge"

      className={cn(
        "font-sans relative inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 text-xs font-medium",
        styles[variant][tone],
        onRemove && "pr-1.5",
        className
      )}
      {...props}
    >
      {dot && (
        <span className="relative flex size-1.5 shrink-0">
          {pulse && (
            <span
              className={cn(
                "absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none",
                variant === "solid" ? "bg-current" : dots[tone]
              )}
            />
          )}
          <span className={cn("relative size-1.5 rounded-full", variant === "solid" ? "bg-current" : dots[tone])} />
        </span>
      )}

      {roll ? (
        <span className="relative inline-flex overflow-hidden py-px">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={String(children)}
              initial={{ y: "70%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-70%", opacity: 0 }}
              transition={spring}
              className="inline-block tabular-nums"
            >
              {children}
            </motion.span>
          </AnimatePresence>
        </span>
      ) : (
        children
      )}

      {onRemove && (
        <button
          type="button"
          aria-label="移除"
          onClick={onRemove}
          className="grid size-4 place-items-center rounded-full opacity-60 outline-none transition hover:bg-nav-hover hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current"
        >
          <X className="size-3" />
        </button>
      )}
    </motion.span>
  );
}

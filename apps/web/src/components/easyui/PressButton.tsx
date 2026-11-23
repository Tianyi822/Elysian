/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/PressButton.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { forwardRef, useEffect, useState } from 'react';
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export type PressButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost';
export type PressButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface PressButtonProps
  extends Omit<HTMLMotionProps<'button'>, 'children'> {
  /** Visual presentation style */
  variant?: PressButtonVariant;
  /** Dimension scale */
  size?: PressButtonSize;
  /** Press compression strength (0-1). Higher = more compression */
  pressStrength?: number;
  /** Enable compression and rebound on pointer or keyboard activation. */
  pressFeedback?: boolean;
  /** Expand button to fill 100% of container width */
  fullWidth?: boolean;
  /** Preserve a compound control's geometry while sharing the press interaction. */
  unstyled?: boolean;
  /** Native controls must not synthesize pointer events from Enter (Radix,
   * drag handles and menus distinguish keyboard and pointer activation). */
  nativePress?: boolean;
  /** Button content */
  children?: React.ReactNode;
}

const variantStyles: Record<PressButtonVariant, string> = {
  primary:
    'bg-fg text-surface hover:opacity-90 border border-transparent',
  secondary:
    'bg-surface border border-control-line text-fg hover:bg-surface-raised hover:border-control-line',
  outline:
    'bg-transparent border border-control-line text-fg hover:bg-surface hover:border-control-line',
  ghost:
    'bg-transparent text-fg-muted hover:text-fg hover:bg-surface border border-transparent',
};

const sizeStyles: Record<PressButtonSize, string> = {
  // EasyUI 的 md/lg 圆角令牌为 10/14px，独立声明避免受工作台同名令牌影响。
  sm: 'h-8 px-3.5 text-xs rounded-[10px] gap-1.5',
  md: 'h-10 px-4.5 text-sm rounded-[14px] gap-2',
  lg: 'h-12 px-6 text-base rounded-[14px] gap-2.5',
  icon: 'h-10 w-10 p-0 rounded-[14px] justify-center shrink-0',
};

/**
 * PressButton — Compresses slightly on press, then settles with a tiny natural overshoot.
 * Uses a layered scaleX + scaleY motion for a tactile, physical feel.
 */
export const PressButton = forwardRef<HTMLButtonElement, PressButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      pressStrength = 0.04,
      pressFeedback = true,
      fullWidth = false,
      unstyled = false,
      nativePress = false,
      disabled,
      className,
      children,
      type = 'button',
      onTapStart,
      onTap,
      onTapCancel,
      animate,
      transition,
      whileTap,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      onKeyDown,
      onKeyUp,
      onBlur,
      ...props
    },
    ref
  ) => {
    const reduced = useReducedMotion();
    const [isPressed, setIsPressed] = useState(false);
    useEffect(() => { if (disabled || !pressFeedback) setIsPressed(false); }, [disabled, pressFeedback]);
    const canCompress = pressFeedback && !disabled && !reduced;
    const compression = Math.min(0.06, Math.max(0.01, pressStrength));
    const compressed = isPressed && canCompress;
    const pressAnimation = pressFeedback ? {
      scaleX: compressed ? 1 - compression : 1,
      scaleY: compressed ? 1 - compression * 1.6 : 1,
      ...(nativePress ? { scale: compressed ? 0.97 : 1 } : {}),
    } : undefined;
    // Compound controls may also animate rotation or entry/exit. Do not replace
    // their animation or their gesture callbacks with the shared press feedback.
    const animation = pressAnimation && animate && typeof animate === 'object' && !Array.isArray(animate) && !('start' in animate)
      ? { ...animate, ...pressAnimation }
      : animate ?? pressAnimation;

    return (
      <motion.button
        data-easyui="press-button"
        data-press-button={pressFeedback ? '' : undefined}
        initial={false}
        ref={ref}
        type={type}
        disabled={disabled}
        onTapStart={nativePress || !pressFeedback ? onTapStart : (event, info) => {
          if (canCompress) setIsPressed(true);
          onTapStart?.(event, info);
        }}
        onTap={nativePress || !pressFeedback ? onTap : (event, info) => { setIsPressed(false); onTap?.(event, info); }}
        onTapCancel={nativePress || !pressFeedback ? onTapCancel : (event, info) => { setIsPressed(false); onTapCancel?.(event, info); }}
        onPointerDown={event => {
          onPointerDown?.(event);
          if (nativePress && canCompress && !event.defaultPrevented && event.button === 0) setIsPressed(true);
        }}
        onPointerUp={event => { if (nativePress) setIsPressed(false); onPointerUp?.(event); }}
        onPointerCancel={event => { if (nativePress) setIsPressed(false); onPointerCancel?.(event); }}
        onPointerLeave={event => { if (nativePress) setIsPressed(false); onPointerLeave?.(event); }}
        onKeyDown={event => {
          onKeyDown?.(event);
          if (nativePress && canCompress && !event.defaultPrevented && ['Enter', ' '].includes(event.key)) setIsPressed(true);
        }}
        onKeyUp={event => { if (nativePress) setIsPressed(false); onKeyUp?.(event); }}
        onBlur={event => { if (nativePress) setIsPressed(false); onBlur?.(event); }}
        animate={animation}
        transition={reduced ? { duration: 0 } : !pressFeedback ? transition : {
          ...(transition ?? motionTransitions.springSnappy),
          scaleX: motionTransitions.springSnappy,
          scaleY: motionTransitions.springSnappy,
          scale: motionTransitions.springSnappy,
        }}
        whileTap={disabled || reduced || nativePress ? undefined : whileTap ?? (pressFeedback ? { scale: 0.97 } : undefined)}
        className={cn(
          !unstyled && 'relative inline-flex items-center justify-center font-medium select-none focus-ring transition-colors duration-150 cursor-pointer',
          !unstyled && variantStyles[variant],
          !unstyled && sizeStyles[size],
          fullWidth && 'w-full',
          disabled && !unstyled && 'opacity-30 cursor-not-allowed',
          className
        )}
        {...props}
      >
        {unstyled ? children : <span className="relative z-10 flex min-w-0 items-center justify-center gap-[inherit]">{children}</span>}
      </motion.button>
    );
  }
);

PressButton.displayName = 'PressButton';

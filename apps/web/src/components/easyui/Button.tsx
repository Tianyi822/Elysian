/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/Button.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { forwardRef } from 'react';
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export type ButtonVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'success'
  | 'link'
  | 'gradient';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps
  extends Omit<HTMLMotionProps<'button'>, 'children'> {
  /** Visual presentation style */
  variant?: ButtonVariant;
  /** Dimension scale */
  size?: ButtonSize;
  /** Loading state displaying an animated spinner */
  isLoading?: boolean;
  /** Text or element displayed during loading */
  loadingText?: string;
  /** Icon placed before the button children */
  leftIcon?: React.ReactNode;
  /** Icon placed after the button children */
  rightIcon?: React.ReactNode;
  /** Expand button to fill 100% of container width */
  fullWidth?: boolean;
  /** Button content */
  children?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  default: 'bg-fg text-surface border border-transparent hover:opacity-90',
  primary: 'bg-fg text-surface border border-transparent hover:opacity-90',
  secondary: 'bg-surface border border-control-line text-fg hover:bg-surface-raised',
  outline: 'bg-transparent border border-control-line text-fg hover:bg-surface-raised',
  ghost: 'bg-transparent border border-transparent text-fg-muted hover:text-fg hover:bg-surface-raised',
  destructive: 'bg-danger/10 border border-danger/40 text-danger hover:bg-danger/20',
  success: 'bg-success/10 border border-success/40 text-success hover:bg-success/20',
  link: 'bg-transparent text-accent-fg underline-offset-4 hover:underline p-0 h-auto border-0',
  gradient: 'bg-surface border border-control-line text-fg hover:bg-surface-raised relative overflow-hidden',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs rounded-md gap-1.5',
  md: 'h-10 px-4.5 text-sm rounded-lg gap-2',
  lg: 'h-12 px-6 text-base rounded-lg gap-2.5',
  icon: 'h-10 w-10 p-0 rounded-lg justify-center shrink-0',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      loadingText,
      leftIcon,
      rightIcon,
      fullWidth = false,
      disabled,
      className,
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || isLoading;
    const reduced = useReducedMotion();

    return (
      <motion.button
        data-easyui="button"
        ref={ref}
        type={type}
        disabled={isDisabled}
        whileTap={isDisabled || reduced ? undefined : { scale: 0.97 }}
        transition={motionTransitions.springSnappy}
        aria-busy={isLoading}
        className={cn(
          'relative inline-flex items-center justify-center font-medium select-none focus-ring transition-colors duration-150',
          variantStyles[variant],
          variant !== 'link' && sizeStyles[size],
          fullWidth && 'w-full',
          isDisabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        {...props}
      >
        {/* Subtle shimmer gradient for gradient variant */}
        {variant === 'gradient' && (
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out pointer-events-none"
            aria-hidden="true"
          />
        )}

        {/* Loading Spinner or Left Icon */}
        {isLoading ? (
          <Loader2 className={cn('animate-spin shrink-0', size === 'sm' ? 'w-3 h-3' : 'w-4 h-4')} />
        ) : (
          leftIcon && <span className="shrink-0">{leftIcon}</span>
        )}

        {/* Button Content */}
        {isLoading && loadingText ? (
          <span>{loadingText}</span>
        ) : (
          children && <span>{children}</span>
        )}

        {/* Right Icon */}
        {!isLoading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </motion.button>
    );
  }
);

Button.displayName = 'Button';

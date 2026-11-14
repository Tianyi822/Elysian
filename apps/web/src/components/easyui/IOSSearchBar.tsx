/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/IOSSearchBar.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { useState, useRef } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Search, X } from 'lucide-react';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export interface IOSSearchBarProps {
  /** Stable input identity and accessible name, independent of its hint. */
  id?: string;
  label?: string;
  /** Current search input value. */
  value: string;
  /** Text change handler. */
  onChange: (value: string) => void;
  /** Submit handler fired on Enter. */
  onSubmit?: (value: string) => void;
  /** Optional clear handler. */
  onClear?: () => void;
  /** Placeholder text. Default is "搜索…". */
  placeholder?: string;
  /** Disables input. */
  disabled?: boolean;
  /** Auto focus on mount. */
  autoFocus?: boolean;
  /** Collapsed default width in pixels or CSS string. Default is '220px'. */
  collapsedWidth?: number | string;
  /** Expanded width in pixels or CSS string. Default is '340px'. */
  expandedWidth?: number | string;
  /** Custom CSS class names. */
  className?: string;
}

export const IOSSearchBar: React.FC<IOSSearchBarProps> = ({
  id,
  label,
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder = '搜索…',
  disabled = false,
  autoFocus = false,
  collapsedWidth = '220px',
  expandedWidth = '340px',
  className,
}) => {
  const reduced = useReducedMotion();
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = () => {
    onChange('');
    if (onClear) onClear();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit(value);
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  };

  const isExpanded = isFocused || value.length > 0;

  return (
    <motion.div
      data-easyui="ios-search-bar"
      initial={false}
      animate={{
        width: isExpanded ? expandedWidth : collapsedWidth,
      }}
      transition={reduced ? { duration: 0 } : motionTransitions.springSmooth}
      className={cn('relative flex max-w-full items-center', className)}
    >
      <div
        className={cn(
          'relative flex h-10 w-full min-w-0 items-center rounded-full border px-3.5 transition-colors duration-200 motion-reduce:transition-none',
          isFocused
            ? 'bg-surface-raised border-focus'
            : 'bg-surface border-control-line hover:bg-surface-raised'
        )}
      >
        <Search
          aria-hidden="true"
          className={cn(
            'w-4 h-4 shrink-0 transition-colors mr-2.5',
            isFocused ? 'text-fg' : 'text-fg-subtle'
          )}
        />

        <input
          ref={inputRef}
          id={id}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={label ?? placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-0 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:hidden [&::-webkit-search-results-button]:hidden [&::-webkit-search-results-decoration]:hidden disabled:opacity-40 disabled:cursor-not-allowed"
        />

        {/* Clear Button */}
        <AnimatePresence>
          {value.length > 0 && (
            <Tooltip.Root key="clear-search">
              <Tooltip.Trigger asChild>
                <motion.button
                  type="button"
                  onClick={handleClear}
                  disabled={disabled}
                  initial={reduced ? false : { opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: reduced ? 0 : 0.15 }}
                  aria-label="清空搜索"
                  className="ml-1.5 grid size-6 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-nav-hover hover:text-fg focus-ring disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <X aria-hidden="true" className="w-3 h-3" />
                </motion.button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content side="bottom" sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
                  清空搜索<Tooltip.Arrow className="fill-surface-raised" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

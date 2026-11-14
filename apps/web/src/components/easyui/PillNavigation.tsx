/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/PillNavigation.tsx
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { useState, useRef, useId } from 'react';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { cn } from './utils';
import { motionTransitions } from './motion-tokens';

export interface PillSubItem {
  id: string;
  label: string;
  badge?: string;
}

export interface PillNavigationItem {
  id: string;
  label: string;
  children?: PillSubItem[];
}

export interface PillNavigationProps extends Omit<HTMLMotionProps<'div'>, 'onChange'> {
  items?: PillNavigationItem[];
  value?: string;
  defaultValue?: string;
  ariaLabel?: string;
  disabled?: boolean;
  itemClassName?: string;
  defaultSubValue?: string;
  onChange?: (id: string, subId?: string) => void;
}

const defaultItems: PillNavigationItem[] = [
  { id: 'overview', label: 'Overview' },
  {
    id: 'motion',
    label: 'Motion',
    children: [
      { id: 'springs', label: 'Spring Physics' },
      { id: 'caustics', label: 'Liquid Caustics' },
      { id: 'gestures', label: 'Gesture Drag' },
    ],
  },
  { id: 'access', label: 'Access' },
  {
    id: 'code',
    label: 'Code',
    children: [
      { id: 'react', label: 'React JSX' },
      { id: 'tailwind', label: 'Tailwind v3' },
    ],
  },
];

export const PillNavigation: React.FC<PillNavigationProps> = ({
  items = defaultItems,
  defaultValue,
  value,
  ariaLabel = '选项',
  disabled = false,
  itemClassName,
  defaultSubValue,
  onChange,
  className,
  ...props
}) => {
  const [internalActiveId, setActiveId] = useState(defaultValue || items[0]?.id || '');
  const activeId = value ?? internalActiveId;
  const instanceId = useId();
  const [activeSubId, setActiveSubId] = useState<string | undefined>(defaultSubValue);
  const [submenuOpen, setSubmenuOpen] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const activeItem = items.find((item) => item.id === activeId) || items[0];
  const hasSubmenu = Boolean(activeItem?.children && activeItem.children.length > 0);

  const selectMain = (id: string) => {
    if (disabled) return;
    const item = items.find((i) => i.id === id);
    if (id === activeId && item?.children) {
      // Toggle submenu on repeated click
      setSubmenuOpen((prev) => !prev);
      return;
    }

    if (id === activeId) {
      onChange?.(id, activeSubId);
      return;
    }
    if (value === undefined) setActiveId(id);
    setSubmenuOpen(true);
    const firstChild = item?.children?.[0]?.id;
    setActiveSubId(firstChild);
    onChange?.(id, firstChild);
  };

  const selectSub = (subId: string) => {
    if (disabled) return;
    setActiveSubId(subId);
    onChange?.(activeId, subId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    // 主选项使用漫游焦点；隐藏的桌面控件不会进入窄屏键盘顺序。
    const mainButton = e.target instanceof Element && e.target.closest('[data-pill-main]');
    const currentIndex = items.findIndex((item) => item.id === activeId);
    if (currentIndex === -1) return;

    if (mainButton && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const nextIndex = e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
        : (currentIndex + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      const next = items[nextIndex];
      if (!next) return;
      selectMain(next.id);
      containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-pill-main]')[nextIndex]?.focus();
    } else if (e.key === 'ArrowDown' && hasSubmenu && activeItem?.children) {
      e.preventDefault();
      const currentSubIndex = activeItem.children.findIndex((s) => s.id === activeSubId);
      const nextSubIndex = (currentSubIndex + 1) % activeItem.children.length;
      const next = activeItem.children[nextSubIndex];
      if (next) selectSub(next.id);
    } else if (e.key === 'ArrowUp' && hasSubmenu && activeItem?.children) {
      e.preventDefault();
      const currentSubIndex = activeItem.children.findIndex((s) => s.id === activeSubId);
      const prevSubIndex =
        (currentSubIndex - 1 + activeItem.children.length) % activeItem.children.length;
      const previous = activeItem.children[prevSubIndex];
      if (previous) selectSub(previous.id);
    } else if (e.key === 'Escape') {
      setSubmenuOpen(false);
    }
  };

  return (
    <motion.div
      data-easyui="pill-navigation"
      ref={containerRef}
      layout={!reducedMotion}
      transition={motionTransitions.springGentle}
      className={cn('inline-flex min-w-0 max-w-full flex-col items-center gap-2 select-none', className)}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {/* 1. Main Segmented Control Bar */}
      <div
        className="inline-flex max-w-full items-center overflow-x-auto rounded-full border border-control-line bg-surface-raised p-1 [scrollbar-width:none]"
      >
        {items.map((item) => {
          const active = item.id === activeId;
          const itemHasChildren = Boolean(item.children && item.children.length > 0);

          return (
            <motion.button
              key={item.id}
              type="button"
              data-pill-main
              aria-pressed={active}
              aria-expanded={active && itemHasChildren ? submenuOpen : undefined}
              tabIndex={active && !disabled ? 0 : -1}
              disabled={disabled}
              whileTap={reducedMotion ? undefined : { scale: 0.96 }}
              onClick={() => selectMain(item.id)}
              className={cn(
                'focus-ring relative flex h-[calc(var(--ctl-height,2.25rem)-0.5rem-2px)] shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm whitespace-nowrap font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                active ? 'text-surface font-medium' : 'text-fg-muted hover:text-fg',
                itemClassName
              )}
            >
              {active && !reducedMotion && (
                <motion.span
                  data-easyui-indicator
                  aria-hidden="true"
                  layoutId={`easyui-pill-main-${instanceId}`}
                  transition={motionTransitions.springMorph}
                  className="absolute inset-0 rounded-full bg-fg"
                />
              )}
              {active && reducedMotion && (
                <span data-easyui-indicator aria-hidden="true" className="absolute inset-0 rounded-full bg-fg" />
              )}

              <span className="relative z-10">{item.label}</span>

              {itemHasChildren && (
                <ChevronDown
                  className={cn(
                    'relative z-10 h-3 w-3 transition-transform duration-200',
                    active ? 'text-surface' : 'text-fg-subtle',
                    active && submenuOpen && 'rotate-180'
                  )}
                />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* 2. Fluid Morphing Submenu Bar */}
      <AnimatePresence mode="wait">
        {activeItem && hasSubmenu && submenuOpen && (
          <motion.div
            key={activeItem.id}
            layout={!reducedMotion}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.96 }}
            transition={motionTransitions.springGentle}
            role="menu"
            aria-label={`${activeItem.label}子选项`}
            className="inline-flex items-center gap-1 rounded-full border border-control-line bg-surface p-1"
          >
            {(activeItem.children || []).map((subItem) => {
              const isSubActive = subItem.id === activeSubId;

              return (
                <motion.button
                  key={subItem.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSubActive}
                  disabled={disabled}
                  whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  onClick={() => selectSub(subItem.id)}
                  className={cn(
                    'focus-ring relative flex min-h-7 items-center rounded-full px-3 py-1 text-[11px] font-medium transition-colors cursor-pointer',
                    isSubActive ? 'text-fg font-semibold' : 'text-fg-muted hover:text-fg'
                  )}
                >
                  {isSubActive && !reducedMotion && (
                    <motion.span
                      layoutId={`easyui-pill-sub-${instanceId}`}
                      transition={motionTransitions.springMorph}
                      className="absolute inset-0 rounded-full bg-surface-raised border border-control-line"
                    />
                  )}
                  {isSubActive && reducedMotion && (
                    <span className="absolute inset-0 rounded-full bg-surface-raised border border-control-line" />
                  )}

                  <span className="relative z-10">{subItem.label}</span>
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default PillNavigation;

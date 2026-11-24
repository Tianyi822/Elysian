/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/GooeyMenu.tsx
 * Revision: a4d68b641d39b0782cc83103cc407760da2fce4b
 * Adaptations are recorded in ./upstream.json.
 */
'use client';

import React, { useState, useRef, useEffect, useLayoutEffect, useId, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Button } from '../Button';
import { revealMenuItem } from '../dropdownScroll';
import { observeElementSize } from '../../utils/observeElementSize';
import { cn } from './utils';

export interface GooeyMenuProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** List of menu item labels */
  options?: string[];
  /** Controlled active/selected item */
  value?: string;
  /** Initial selected option if uncontrolled */
  defaultValue?: string;
  /** Controlled open state */
  open?: boolean;
  /** Initial open state if uncontrolled */
  defaultOpen?: boolean;
  /** Callback fired when open state changes */
  onOpenChange?: (open: boolean) => void;
  /** Callback fired when an option is selected */
  onSelect?: (option: string, index: number) => void;
  /** Pixel width of the panel and the default pill (default: 306) */
  width?: number;
  /** Non-interactive content for an optional custom trigger button */
  trigger?: React.ReactNode;
  /** Accessible name for a custom trigger (default: 'Toggle menu') */
  triggerLabel?: string;
  /** Custom trigger dimensions, padding, and corner shape */
  triggerClassName?: string;
  /** Inline styles for the trigger button */
  triggerStyle?: React.CSSProperties;
  /** Logical panel alignment relative to the trigger (default: 'start') */
  align?: 'start' | 'center' | 'end';
  /** Additional classes for all options or individual actions */
  optionClassName?: string | ((option: string, index: number) => string | undefined);
  /** Keep domain identities separate from visible labels, including duplicate labels. */
  getOptionLabel?: (option: string, index: number) => string;
  getOptionDetails?: (option: string, index: number) => { description?: string; icon?: React.ReactNode };
  portal?: boolean;
  isOptionDisabled?: (option: string, index: number) => boolean;
  menuLabel?: string;
  disabled?: boolean;
  /** Responsive consumers dismiss their hidden navigation without changing selection. */
  active?: boolean;
  /** Additional container styling */
  className?: string;
}

const DEFAULT_OPTIONS = ['Home', 'About', 'Projects', 'Contact', 'Book a call', 'Follow us'];

const W = 306;
const PILL_H = 56;
const GAP = 12;
const ROW_H = 44;
const PANEL_PAD = 10;
const ROW_GAP = 4;
/**
 * 说明折行时的选项统一高度：上下 8px 内距、一行标题、4px 间隔和至多两行 12px/16px 说明。
 * 说明不足两行时内容居中，面板高度因此可以按它精确算出。
 */
const DETAILED_ROW_H = 72;

const DROP_SPRING = { type: 'spring', stiffness: 240, damping: 17, mass: 1 } as const;
const GROW_SPRING = { type: 'spring', stiffness: 210, damping: 22, mass: 1 } as const;
const SNAP_SPRING = { type: 'spring', stiffness: 240, damping: 20, mass: 0.9 } as const;
const ROW_SPRING = { type: 'spring', stiffness: 420, damping: 26 } as const;

type Corner = [number, number];
type Corners = [Corner, Corner, Corner, Corner];
type TriggerGeometry = {
  width: number;
  height: number;
  corners: Corners;
  rtl: boolean;
};

function roundRectPath(x: number, y: number, { width, height, corners }: TriggerGeometry) {
  const [[tlX, tlY], [trX, trY], [brX, brY], [blX, blY]] = corners;
  const right = x + width;
  const bottom = y + height;
  return `M ${x + tlX} ${y} H ${right - trX} A ${trX} ${trY} 0 0 1 ${right} ${y + trY}
    V ${bottom - brY} A ${brX} ${brY} 0 0 1 ${right - brX} ${bottom}
    H ${x + blX} A ${blX} ${blY} 0 0 1 ${x} ${bottom - blY}
    V ${y + tlY} A ${tlX} ${tlY} 0 0 1 ${x + tlX} ${y} Z`.replace(/\s+/g, ' ');
}

function measureTrigger(button: HTMLButtonElement): TriggerGeometry {
  // Layout dimensions stay correct inside scaled registry/demo previews.
  const width = button.offsetWidth;
  const height = button.offsetHeight;
  const style = getComputedStyle(button);
  const resolveRadius = (value: string, size: number) =>
    value.endsWith('%') ? parseFloat(value) / 100 * size : parseFloat(value) || 0;
  const corners = [style.borderTopLeftRadius, style.borderTopRightRadius,
    style.borderBottomRightRadius, style.borderBottomLeftRadius].map((radius) => {
    const [x = '0', y = x] = radius.split(' ');
    return [resolveRadius(x, width), resolveRadius(y, height)];
  }) as Corners;
  // CSS scales overlapping radii together. Match the actual rendered outline.
  const factor = Math.min(1, width / (corners[0][0] + corners[1][0]),
    width / (corners[3][0] + corners[2][0]), height / (corners[0][1] + corners[3][1]),
    height / (corners[1][1] + corners[2][1]));
  return { width, height, corners: corners.map(([x, y]) => [x * factor, y * factor]) as Corners, rtl: style.direction === 'rtl' };
}

/**
 * GooeyMenu creates an ultra-smooth liquid dropdown menu using SVG metaball
 * color matrix filtering and spring physics.
 */
export const GooeyMenu: React.FC<GooeyMenuProps> = ({
  options = DEFAULT_OPTIONS,
  value,
  defaultValue,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  onSelect,
  width = W,
  trigger,
  triggerLabel,
  triggerClassName,
  triggerStyle,
  align = 'start',
  optionClassName,
  getOptionLabel = option => option,
  getOptionDetails,
  portal = false,
  isOptionDisabled = () => false,
  menuLabel,
  disabled = false,
  active = true,
  className,
  style,
  onKeyDown,
  ...props
}) => {
  const hasCustomTrigger = trigger !== undefined;
  const reducedMotion = useReducedMotion();
  const id = useId().replace(/:/g, '');
  const filterId = `easyui-goo-drop-${id}`;
  const listId = `easyui-goo-list-${id}`;
  const isControlledOpen = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const requestedOpen = isControlledOpen ? controlledOpen : internalOpen;
  const open = requestedOpen && active && !disabled;

  const setOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const nextVal = typeof next === 'function' ? next(open) : next;
    if (!isControlledOpen) {
      setInternalOpen(nextVal);
    }
    onOpenChange?.(nextVal);
  }, [isControlledOpen, open, onOpenChange]);

  const [selected, setSelected] = useState(value ?? defaultValue ?? options[0] ?? 'Home');
  const [activeIndex, setActiveIndex] = useState(
    Math.max(0, options.indexOf(value ?? defaultValue ?? options[0] ?? ''))
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const contains = useCallback((target: Node | null) =>
    containerRef.current?.contains(target) || listRef.current?.contains(target), []);
  const renderLayer = (layer: React.ReactNode) => portal ? createPortal(layer, document.body) : layer;
  const focusListOnOpen = useRef(false);
  const [settling, setSettling] = useState(false);
  // The surface and the list share one height, so options are counted before layout.
  const hasDescriptions = options.some((option, index) => Boolean(getOptionDetails?.(option, index)?.description));
  const [wrappedDescriptions, setWrappedDescriptions] = useState(false);
  // Descriptions that wrap at the current panel width get the roomy layout; single-line ones keep the upstream row.
  const roomy = hasDescriptions && wrappedDescriptions;
  const naturalHeight = PANEL_PAD * 2 + options.reduce((sum, option, index) =>
    sum + (roomy && getOptionDetails?.(option, index)?.description ? DETAILED_ROW_H : ROW_H), 0)
    + (roomy ? (options.length - 1) * ROW_GAP : 0);
  const [placement, setPlacement] = useState({ left: 0, top: 0, panelX: 0, panelY: PILL_H + GAP, width, height: naturalHeight });
  const typeahead = useRef({ text: '', at: 0 });
  const previousValue = useRef(value);
  const [geometry, setGeometry] = useState<TriggerGeometry>({
    width, height: PILL_H, corners: Array.from({ length: 4 }, () => [PILL_H / 2, PILL_H / 2]) as Corners, rtl: false,
  });

  useLayoutEffect(() => {
    const button = triggerRef.current;
    if (!button) return;
    const measure = () => {
      const next = measureTrigger(button);
      if (!next.width || !next.height) return;
      setGeometry((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const cleanup = observeElementSize([button], measure);
    window.addEventListener('resize', measure);
    return () => {
      cleanup();
      window.removeEventListener('resize', measure);
    };
  }, [width, trigger, triggerClassName, triggerStyle, open]);

  useEffect(() => {
    if (!active || disabled) {
      if (requestedOpen) setOpen(false);
      setSettling(false);
    }
  }, [requestedOpen, active, disabled, setOpen]);

  // A fixed surface keeps the original fused pill/panel together while escaping
  // clipped terminal and dashboard containers. Only its viewport placement changes.
  useLayoutEffect(() => {
    if (!open) return;
    setSettling(true);
    const button = triggerRef.current;
    if (!button) return;
    const measure = () => {
      const rect = button.getBoundingClientRect();
      // Ancestor CSS/container queries can hide a still-mounted navigation.
      for (let element: HTMLElement | null = button; element; element = element.parentElement) {
        if (element.hidden || getComputedStyle(element).display === 'none') {
          setOpen(false);
          return;
        }
      }
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const panelWidth = Math.max(1, Math.min(width, viewportWidth - 16));
      const preferredX = align === 'center' ? (geometry.width - panelWidth) / 2
        : (align === 'end') !== geometry.rtl ? geometry.width - panelWidth : 0;
      const left = Math.max(8, Math.min(rect.left + preferredX, viewportWidth - panelWidth - 8));
      const below = Math.max(0, viewportHeight - rect.bottom - GAP - 8);
      const above = Math.max(0, rect.top - GAP - 8);
      const placeAbove = naturalHeight > below && above > below;
      const height = Math.min(naturalHeight, placeAbove ? above : below);
      const next = { left: rect.left, top: rect.top, panelX: left - rect.left,
        panelY: placeAbove ? -GAP - height : geometry.height + GAP, width: panelWidth, height };
      setPlacement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const cleanup = observeElementSize([button], measure);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const onScroll = (event: Event) => { if (event.target !== listRef.current) measure(); };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cleanup();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, width, align, geometry, naturalHeight, setOpen]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!hasDescriptions || !list) return;
    // The hidden list is still laid out at the panel width, so this also settles before the first opening.
    const wrapped = [...list.querySelectorAll<HTMLElement>('[role="option"]')].some((option) => {
      const description = option.querySelector<HTMLElement>('[id$="-description"]');
      return !!description && description.getBoundingClientRect().height > (parseFloat(getComputedStyle(description).lineHeight) || 0) + 1;
    });
    setWrappedDescriptions(wrapped);
  }, [width, hasDescriptions, placement.width]);

  useEffect(() => {
    if (open && focusListOnOpen.current) {
      listRef.current?.focus({ preventScroll: true });
      focusListOnOpen.current = false;
    }
  }, [open]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const item = list?.children[activeIndex];
    if (open && list && item instanceof HTMLElement) revealMenuItem(list, item);
  }, [open, activeIndex, placement.height]);

  // Sync external controlled value
  useEffect(() => {
    if (value !== undefined) {
      setSelected(value);
      const idx = options.indexOf(value);
      if ((!open || previousValue.current !== value) && idx !== -1 && !isOptionDisabled(value, idx)) {
        setActiveIndex(previous => previous === idx ? previous : idx);
      }
    }
    previousValue.current = value;
  }, [value, options, isOptionDisabled, open]);

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !contains(e.target as Node)) {
        if (listRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus({ preventScroll: true });
        }
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener('pointerdown', handlePointerDown);
    }
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [contains, open, setOpen]);

  const enabledIndices = options.flatMap((option, index) => isOptionDisabled(option, index) ? [] : [index]);
  const move = (direction: number) => {
    const current = enabledIndices.indexOf(activeIndex);
    setActiveIndex(enabledIndices[(current + direction + enabledIndices.length) % enabledIndices.length] ?? -1);
  };

  // Retain the upstream listbox focus model and add disabled-item skipping,
  // Home/End, typeahead and Tab/outside dismissal for panel navigation.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || disabled || !active) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        typeahead.current = { text: '', at: 0 };
        const selectedIndex = options.indexOf(value ?? selected);
        setActiveIndex(e.key === 'ArrowUp' ? enabledIndices.at(-1) ?? -1
          : enabledIndices.includes(selectedIndex) ? selectedIndex : enabledIndices[0] ?? -1);
        focusListOnOpen.current = true;
        setOpen(true);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      listRef.current?.focus({ preventScroll: true });
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      listRef.current?.focus({ preventScroll: true });
      move(-1);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      listRef.current?.focus({ preventScroll: true });
      setActiveIndex((e.key === 'Home' ? enabledIndices[0] : enabledIndices.at(-1)) ?? -1);
    } else if (e.key === 'Tab') {
      // Focus the original trigger before the browser advances to its next peer.
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (e.target === triggerRef.current) return;
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const now = Date.now();
      const text = (now - typeahead.current.at < 700 ? typeahead.current.text : '') + e.key.toLocaleLowerCase();
      typeahead.current = { text, at: now };
      const query = new Set(text).size === 1 ? text.charAt(0) : text;
      const candidates = [...enabledIndices.filter(index => index > activeIndex), ...enabledIndices.filter(index => index <= activeIndex)];
      const match = candidates.find(index => getOptionLabel(options[index]!, index).toLocaleLowerCase().startsWith(query));
      if (match !== undefined) {
        e.preventDefault();
        setActiveIndex(match);
        listRef.current?.focus({ preventScroll: true });
      }
    }
  };

  const choose = (index: number) => {
    const opt = options[index];
    if (opt !== undefined && !isOptionDisabled(opt, index)) {
      setSelected(opt);
      setActiveIndex(index);
      onSelect?.(opt, index);
    } else return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const panelHeight = Math.max(1, placement.height);
  const panelWidth = placement.width;
  const { panelX, panelY } = placement;
  const totalHeight = panelY + panelHeight + 24;
  const surfaceLeft = Math.min(0, panelX);
  const surfaceWidth = Math.max(geometry.width, panelX + panelWidth) - surfaceLeft;
  const surfaceTop = Math.min(0, panelY);
  const surfaceHeight = Math.max(totalHeight, geometry.height) - surfaceTop;
  // Filter the blobs together first, then reveal the real trigger through the portal layer.
  const surfaceClip = portal ? `path(evenodd, "M -24 -24 H ${surfaceWidth + 24} V ${surfaceHeight + 24} H -24 Z ${roundRectPath(-surfaceLeft, -surfaceTop, geometry)}")` : undefined;
  const cornerNames = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const;
  const originCorners = Object.fromEntries(cornerNames.map((name, index) => {
    const [x, y] = geometry.corners[index]!;
    return [name, `${x}px ${y}px`];
  }));
  const collapsedCorners = Object.fromEntries(cornerNames.map((name, index) => {
    const [x, y] = geometry.corners[index]!;
    return [name, `${x * panelWidth / geometry.width}px ${y * panelHeight / geometry.height}px`];
  }));
  const expandedCorners = Object.fromEntries(cornerNames.map((name) => [name, '22px 22px']));

  return (
    <div
      {...props}
      ref={containerRef}
      onKeyDown={(event) => { onKeyDown?.(event); handleKeyDown(event); }}
      onBlur={event => { if (!contains(event.relatedTarget)) setOpen(false); }}
      data-easyui="gooey-menu"
      className={cn('easyui-gooey-menu relative inline-flex min-w-0 max-w-full flex-col items-center select-none', className)}
      style={{ width: hasCustomTrigger ? 'fit-content' : width, zIndex: open || settling ? 60 : undefined, ...style }}
    >
      {/* SVG Gooey Metamorphic Matrix Filter */}
      <svg width="0" height="0" className="absolute" aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation={Math.min(10, Math.min(geometry.width, geometry.height) / 5)} result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 22 -14"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <div className="relative max-w-full" style={hasCustomTrigger ? undefined : { width, height: PILL_H }}>
        {/* Gooey Surface Layer - Pure Solid Blobs for fast 60fps GPU rasterization */}
        {renderLayer(<div
          aria-hidden="true"
          className={cn('pointer-events-none fixed', portal ? 'z-[60]' : 'z-10')}
          style={{
            left: placement.left + surfaceLeft,
            top: placement.top + surfaceTop,
            width: surfaceWidth,
            height: surfaceHeight,
            clipPath: surfaceClip,
            visibility: active && !disabled && (open || settling) ? 'visible' : 'hidden',
            filter: reducedMotion ? 'none' : `url(#${filterId})`,
            transform: 'translateZ(0)',
            isolation: 'isolate',
          }}
        >
          {/* Top Pill Solid Shape */}
          <div
            className="absolute bg-[var(--t-gooey-bg)]"
            style={{ top: -surfaceTop, left: -surfaceLeft, width: geometry.width, height: geometry.height, ...originCorners }}
          />

          {/* Morphing Dropping Panel Solid Shape */}
          <motion.div
            data-testid="gooey-menu-surface"
            className="absolute bg-[var(--t-gooey-bg)]"
            style={{
              top: -surfaceTop,
              left: -surfaceLeft,
              width: panelWidth,
              height: panelHeight,
              transformOrigin: '0% 0%',
              willChange: 'transform',
            }}
            initial={false}
            animate={
              open
                ? { x: panelX, y: panelY, scaleX: 1, scaleY: 1, ...expandedCorners }
                : { x: 0, y: 0, scaleX: geometry.width / panelWidth, scaleY: geometry.height / panelHeight, ...collapsedCorners }
            }
            onAnimationComplete={() => { if (!open) setSettling(false); }}
            transition={
              reducedMotion ? { duration: 0 } : open
                ? { ...DROP_SPRING, scaleX: { ...GROW_SPRING, delay: 0.05 }, scaleY: { ...GROW_SPRING, delay: 0.05 } }
                : SNAP_SPRING
            }
          />
        </div>)}

        {/* Trigger Header Button */}
        <Button unstyled
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={triggerLabel ?? (hasCustomTrigger ? 'Toggle menu' : undefined)}
          disabled={disabled}
          data-testid="gooey-menu-trigger"
          onClick={() => {
            if (!open) {
              const selectedIndex = options.indexOf(value ?? selected);
              setActiveIndex(enabledIndices.includes(selectedIndex) ? selectedIndex : enabledIndices[0] ?? -1);
              typeahead.current = { text: '', at: 0 };
            }
            setOpen(!open);
          }}
          className={cn('relative z-20 flex cursor-pointer items-center justify-between bg-[var(--t-gooey-bg)] text-[var(--t-gooey-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50',
            !hasCustomTrigger && 'px-[22px]', triggerClassName)}
          style={{ ...(hasCustomTrigger ? {} : { width, height: PILL_H, borderRadius: PILL_H / 2 }), ...triggerStyle }}
        >
          {hasCustomTrigger ? trigger : <>
          <span className="min-w-0 truncate text-[15.5px] font-medium tracking-[0.1px]">
            {getOptionLabel(selected, options.indexOf(selected))}
          </span>
          <motion.svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--t-gooey-muted)"
            aria-hidden="true"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={{ rotate: open ? 180 : 0 }}
            transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 20 }}
          >
            <path d="m6 9 6 6 6-6" />
          </motion.svg>
          </>}
        </Button>

        {/* List of Options */}
            {renderLayer(<motion.ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label={menuLabel ?? triggerLabel ?? 'Menu options'}
              aria-hidden={!open}
              inert={!open}
              aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
              data-testid="gooey-menu-options"
              className={cn('hover-scrollbar fixed m-0 list-none overflow-y-auto overscroll-contain p-0 outline-none', roomy && 'space-y-1', portal ? 'z-[61]' : 'z-20')}
              style={{ left: placement.left + panelX, top: placement.top + panelY, width: panelWidth, maxHeight: panelHeight,
                visibility: active && !disabled && (open || settling) ? 'visible' : 'hidden',
                paddingTop: PANEL_PAD, paddingBottom: PANEL_PAD, pointerEvents: open ? 'auto' : 'none', borderRadius: 22 }}
              initial="closed"
              animate={open ? 'open' : 'closed'}
              variants={{
                open: { transition: { staggerChildren: reducedMotion ? 0 : 0.035, delayChildren: reducedMotion ? 0 : 0.12 } },
                closed: { transition: { staggerChildren: reducedMotion ? 0 : 0.015, staggerDirection: -1 } },
              }}
            >
              {options.map((opt, i) => {
                const isActive = i === activeIndex;
                const isCurrentSelected = opt === selected;
                const optionDisabled = isOptionDisabled(opt, i);
                const optionId = `${listId}-opt-${i}`;
                const label = getOptionLabel(opt, i);
                const { description, icon } = getOptionDetails?.(opt, i) ?? {};
                const roomyRow = roomy && Boolean(description);
                return (
                  <motion.li
                    key={`${i}-${opt}`}
                    id={optionId}
                    role="option"
                    aria-label={label}
                    aria-describedby={description ? `${optionId}-description` : undefined}
                    aria-selected={isCurrentSelected}
                    aria-disabled={optionDisabled || undefined}
                    onMouseEnter={() => { if (!optionDisabled) setActiveIndex(i); }}
                    onClick={() => choose(i)}
                    variants={{
                      open: { opacity: 1, y: 0, transition: reducedMotion ? { duration: 0 } : ROW_SPRING },
                      closed: { opacity: 0, y: reducedMotion ? 0 : -10, transition: reducedMotion ? { duration: 0 } : SNAP_SPRING },
                    }}
                    className={cn(
                      'mx-[10px] flex shrink-0 cursor-pointer items-center justify-between gap-3 rounded-[14px] px-[12px] text-[15.5px] transition-colors duration-150 ease-out select-none motion-reduce:transition-none',
                      roomyRow && 'py-2',
                      isActive
                        ? 'bg-[var(--t-gooey-active)] text-[var(--t-gooey-fg)]'
                        : 'text-[var(--t-gooey-muted)] hover:text-[var(--t-gooey-fg)] bg-transparent',
                      optionDisabled && 'cursor-not-allowed opacity-40',
                      typeof optionClassName === 'function' ? optionClassName(opt, i) : optionClassName
                    )}
                    style={description ? { minHeight: roomyRow ? DETAILED_ROW_H : ROW_H } : { height: ROW_H }}
                  >
                    {roomyRow ? (
                      // 说明折行的选项：标题一行、说明至多两行。圆点留在标题行末尾并始终占位，
                      // 选中与否都不改变说明的折行，也不随内容在行内的居中偏移。
                      <span className="flex min-w-0 flex-1 items-start gap-2">
                        {icon && <span aria-hidden="true" className="mt-0.5 shrink-0">{icon}</span>}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-3">
                            <span className="block min-w-0 truncate leading-tight" title={label}>{label}</span>
                            <span aria-hidden="true" className="grid w-1.5 shrink-0 place-items-center">
                              {isCurrentSelected && <span className="size-1.5 rounded-full bg-[var(--t-gooey-indicator]]" />}
                            </span>
                          </span>
                          <span id={`${optionId}-description`} className="mt-1 line-clamp-2 text-xs leading-4 text-balance" title={description}>{description}</span>
                        </span>
                      </span>
                    ) : <>
                    {description || icon ? <span className="flex min-w-0 items-center gap-2">
                      {icon && <span aria-hidden="true" className="shrink-0">{icon}</span>}
                      <span className="min-w-0">
                        <span className="block truncate leading-tight" title={label}>{label}</span>
                        {description && <span id={`${optionId}-description`} className="line-clamp-2 text-xs leading-tight" title={description}>{description}</span>}
                      </span>
                    </span> : <span className="min-w-0 truncate" title={label}>{label}</span>}
                    {isCurrentSelected && (
                      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--t-gooey-indicator)]" />
                    )}
                    </>}
                  </motion.li>
                );
              })}
            </motion.ul>)}
      </div>
    </div>
  );
};

export default GooeyMenu;


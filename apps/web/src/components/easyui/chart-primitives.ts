/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/lib/chart-primitives.tsx
 * Adaptations are recorded in ./upstream.json.
 */
"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { observeElementSize } from "../../utils/observeElementSize";

/* -------------------------------------------------------------------------- */
/*  Shared chart primitives                                                    */
/*                                                                             */
/*  Used by BarChart, DonutChart and ActivityHeatmap. Kept in src/lib so the   */
/*  registry generator ships it as a shared `registry:lib` dependency.         */
/* -------------------------------------------------------------------------- */

export const CHART_COLORS = ["#6d7cff", "#34d1bf", "#ffb44c", "#ff6b8b", "#a78bfa", "#5ac8fa"];

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const SPRING = { type: "spring", duration: 0.5, bounce: 0 } as const;

export const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const fullFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export const defaultFormat = (n: number) => fullFmt.format(n);
export const defaultTick = (n: number) => compactFmt.format(n);

export const ring = "border border-panel-line";
export const muted = "text-fg-subtle";
export const focus =
  "outline-none focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";

// "Nice" step so that step × 4 covers `raw × 4`
export function niceStep(raw: number) {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

/** Container width via ResizeObserver (initial value keeps SSR output sensible) */
export function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth) || initial);
    update();
    return observeElementSize([el], update);
  }, [initial]);
  return [ref, width] as const;
}

/** Clear a hover/tap selection when the user taps outside the chart (touch) */
export function useDismissOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [ref, open, close]);
}


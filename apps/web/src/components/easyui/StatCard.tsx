/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/StatCard.tsx
 * Adaptations are recorded in ./upstream.json.
 */
"use client";

import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import {
  CHART_COLORS,
  EASE_OUT,
  clamp,
  cx,
  defaultFormat,
  focus,
  muted,
  ring,
  useDismissOutside,
  useElementWidth,
} from "./chart-primitives";
import { monotonePath, pctText } from "./dashboard-chart-utils";

/* -------------------------------------------------------------------------- */
/*  StatCard / StatGrid                                                       */
/*                                                                            */
/*  KPI tiles with a count-up value, a delta pill, and a scrubable sparkline. */
/*  Hand-written SVG · light and dark · measures its own container.            */
/* -------------------------------------------------------------------------- */

export interface StatCardSeries {
  label: string;
  values: readonly number[];
  color: string;
}

export interface StatCardProps {
  label: string;
  /** The headline number (usually the latest point of `trend`) */
  value: number;
  /** Points for the sparkline, oldest → newest */
  trend: number[];
  /** Names for each trend point, shown while scrubbing (e.g. "Oct 12") */
  trendLabels?: string[];
  /** Previous-period value → the delta is computed from it */
  previous?: number;
  /** …or give the delta in percent directly */
  delta?: number;
  /** Which direction is good news. Use "down" for churn, latency, costs */
  goodWhen?: "up" | "down";
  /** Text under the number, e.g. "vs last 30 days" */
  period?: string;
  format?: (n: number) => string;
  color?: string;
  animated?: boolean;
  className?: string;
  valueClassName?: string | ((value: number) => string);
  showDelta?: boolean;
  /** Explicit timestamps preserve irregular sampling intervals. */
  trendTimes?: number[];
  labelId?: string;
  /** Directional IO series share the same sample indices and time axis. */
  series?: readonly StatCardSeries[];
  renderDetails?: (activeIndex: number | null) => ReactNode;
}

export function StatCard({
  label,
  value,
  trend,
  trendLabels,
  previous,
  delta,
  goodWhen = "up",
  period = "vs previous period",
  format = defaultFormat,
  color = CHART_COLORS[0],
  animated = true,
  className = "",
  valueClassName = "text-fg",
  showDelta = true,
  trendTimes,
  labelId,
  series,
  renderDetails,
}: StatCardProps) {
  const reduce = useReducedMotion();
  const anim = animated && !reduce;
  const uid = useId().replace(/:/g, "");
  const [boxRef, width] = useElementWidth<HTMLDivElement>(220);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  useDismissOutside(cardRef, active !== null, useCallback(() => setActive(null), []));

  const n = trend.length;
  const H = 52, padX = 0, padT = 8, padB = 6;
  const plotSeries = series?.length ? series : [{ label, values: trend, color }];
  const values = plotSeries.flatMap(item => [...item.values]);
  const min = values.length ? Math.min(...values) : 0;
  const span = (values.length ? Math.max(...values) : 1) - min || 1;
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0;
  const startTime = trendTimes?.[0];
  const duration = startTime !== undefined ? (trendTimes?.[n - 1] ?? startTime) - startTime : 0;
  const plots = plotSeries.map(item => {
    const pts = item.values.map((v, i) => [padX + (duration > 0 ? ((trendTimes?.[i] ?? startTime!) - startTime!) / duration * (width - padX * 2) : i * stepX), padT + (1 - (v - min) / span) * (H - padT - padB)] as [number, number]);
    const line = monotonePath(pts);
    const last = pts.at(-1);
    const area = pts.length > 1 ? `${line}L${last![0].toFixed(2)} ${H}L${pts[0]![0].toFixed(2)} ${H}Z` : "";
    return { ...item, pts, line, area };
  });
  const pts = plots[0]?.pts ?? [];

  const pct =
    delta ??
    (previous !== undefined && previous !== 0
      ? ((value - previous) / Math.abs(previous)) * 100
      : n > 1 && trend[0]! !== 0
        ? ((trend[n - 1]! - trend[0]!) / Math.abs(trend[0]!)) * 100
        : 0);
  const rounded = Math.round(pct * 10) / 10;
  const good = rounded === 0 ? null : goodWhen === "up" ? rounded > 0 : rounded < 0;

  /* number: counts up on mount, follows the scrubber afterwards */
  const fmt = useRef(format);
  fmt.current = format;
  const shown = useMotionValue(anim ? 0 : value);
  const text = useTransform(shown, (v) => fmt.current(v));
  const mounted = useRef(false);
  useEffect(() => {
    const target = active === null ? value : (trend[active] ?? value);
    const intro = !mounted.current;
    mounted.current = true;
    const c = animate(shown, target, { duration: !anim ? 0 : intro ? 1.1 : 0.22, ease: EASE_OUT });
    return () => c.stop();
  }, [active, value, trend, shown, anim]);

  /* scrub cursor */
  const curX = useSpring(0, { stiffness: 600, damping: 44, mass: 0.5 });
  const curY = useSpring(0, { stiffness: 600, damping: 44, mass: 0.5 });
  const seen = useRef(false);
  useEffect(() => {
    if (active === null || !pts[active]) {
      seen.current = false;
      return;
    }
    const [px, py] = pts[active]!;
    if (!seen.current || reduce) {
      curX.jump(px);
      curY.jump(py);
      seen.current = true;
    } else {
      curX.set(px);
      curY.set(py);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, width, curX, curY, reduce]);

  const move = (e: React.PointerEvent) => {
    if (n < 2 || !svgRef.current) return;
    const box = svgRef.current.getBoundingClientRect();
    const x = clamp((e.clientX - box.left) / (box.width || 1) * width, 0, width);
    let nearest = 0;
    for (let index = 1; index < n; index++) if (Math.abs(pts[index]![0] - x) < Math.abs(pts[nearest]![0] - x)) nearest = index;
    setActive(nearest);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === "ArrowRight") setActive((a) => clamp((a ?? n - 2) + 1, 0, n - 1));
    else if (e.key === "ArrowLeft") setActive((a) => clamp((a ?? n - 1) - 1, 0, n - 1));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const sub = active === null ? period : `历史采样 · ${trendLabels?.[active] ?? `第 ${active + 1} 个采样`}`;
  const displayValue = active === null ? value : (trend[active] ?? value);
  const displayClass = typeof valueClassName === 'function' ? valueClassName(displayValue) : valueClassName;

  return (
    <div
      data-easyui="stat-card"
      ref={cardRef}
      tabIndex={0}
      role="group"
      aria-label={`${label}历史采样，使用左右方向键查看，Escape 返回当前值`}
      onPointerMove={move}
      onPointerDown={move}
      onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      className={`group relative flex h-full min-w-0 flex-col select-none overflow-hidden rounded-2xl bg-surface pt-4 text-fg ${ring} ${focus} ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-4">
        <h2 id={labelId} className="truncate text-sm font-medium text-fg-muted">{label}</h2>
        {showDelta && <span
          className={cx(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium tabular-nums",
            good === null && "bg-surface-raised text-fg-muted",
            good === true && "bg-success/10 text-success",
            good === false && "bg-danger/10 text-danger",
          )}
        >
          {rounded !== 0 && (
            <svg viewBox="0 0 10 10" className={cx("h-2 w-2", rounded < 0 && "rotate-180")} fill="currentColor" aria-hidden>
              <path d="M5 1.5 9 7.5H1Z" />
            </svg>
          )}
          {pctText(Math.abs(rounded))}
        </span>}
      </div>

      <p className={`mt-2 px-4 text-[28px] font-semibold leading-none tracking-[-0.035em] tabular-nums sm:text-[30px] ${displayClass}`}>
        <motion.span className={displayClass}>{anim ? text : format(displayValue)}</motion.span>
      </p>
      <p title={sub} className={`mt-1.5 truncate px-4 text-[12px] ${muted}`}>{sub}</p>
      {renderDetails?.(active)}

      <div ref={boxRef} className="mt-auto pt-3" style={{ height: H + 12 }}>
        {n > 1 && (
          <svg
            ref={svgRef}
            width={width}
            height={H}
            role="img"
            aria-label={series?.length ? `${label}趋势：${series.map(item => item.label).join('、')}` : `${label}趋势，从 ${format(trend[0]!)} 到 ${format(trend[n - 1]!)}`}
            className="block overflow-visible"
          >
            {plots.map((plot, index) => (
              <g key={plot.label}>
                <defs>
                  <linearGradient id={`${uid}-g-${index}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={plot.color} stopOpacity={plots.length > 1 ? '0.12' : '0.28'} />
                    <stop offset="1" stopColor={plot.color} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <motion.path key={`area-${plot.pts.length}`} initial={false} animate={{ d: plot.area }} transition={{ duration: reduce ? 0 : 0.28 }} fill={`url(#${uid}-g-${index})`} />
                <motion.path key={`line-${plot.pts.length}`} initial={false} animate={{ d: plot.line }} transition={{ duration: reduce ? 0 : 0.28 }} fill="none" stroke={plot.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ))}
            {/* latest point */}
            <g style={{ opacity: active === null ? 1 : 0, transition: reduce ? 'none' : 'opacity .15s' }}>
              {plots.map(plot => <circle key={plot.label} cx={plot.pts[n - 1]![0]} cy={plot.pts[n - 1]![1]} r={3.5} fill={plot.color} />)}
            </g>
            {/* scrubber */}
            <motion.g initial={false} animate={{ opacity: active === null ? 0 : 1 }} transition={{ duration: reduce ? 0 : 0.12 }}>
              <motion.line y1={0} y2={H} x1={curX} x2={curX} className="stroke-control-line" strokeDasharray="2 3" />
              {plots.map((plot, index) => <motion.circle key={plot.label} cx={curX} cy={index === 0 ? curY : (active === null ? 0 : plot.pts[active]?.[1] ?? 0)} r={4.5} fill={plot.color} className="stroke-surface" strokeWidth={2} />)}
            </motion.g>
          </svg>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {active !== null ? `${trendLabels?.[active] ?? `第 ${active + 1} 个采样`}: ${format(trend[active] ?? value)}${series?.map(item => `，${item.label} ${format(item.values[active] ?? 0)}`).join('') ?? ''}` : ""}
      </p>
    </div>
  );
}

export function StatGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid gap-3 sm:gap-4 ${className}`}
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))" }}
    >
      {children}
    </div>
  );
}

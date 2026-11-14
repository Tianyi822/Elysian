/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/lib/dashboard-chart-utils.ts
 * Adaptations are recorded in ./upstream.json.
 */
/**
 * Shared math for the EasyUI dashboard charts.
 *
 * Kept in `src/lib` so the registry generator ships it as a `registry:lib`
 * dependency for StatCard, FunnelChart and LiveLineChart.
 */

export const pctText = (x: number) => `${Math.abs(x) >= 10 ? Math.round(x) : x.toFixed(1)}%`;

/** A value sampled at a timestamp (UTC ms) */
export interface TimestampedPoint {
  t: number;
  v: number;
}

/** Smooth monotone cubic through points (never overshoots the data) */
export function monotonePath(p: [number, number][]): string {
  const n = p.length;
  if (n === 0) return "";
  if (n === 1) return `M${p[0]![0].toFixed(2)} ${p[0]![1].toFixed(2)}`;
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1]![0] - p[i]![0];
    m[i] = (p[i + 1]![1] - p[i]![1]) / (dx[i]! || 1e-9);
  }
  const t: number[] = new Array(n);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * m[i]!;
        t[i + 1] = k * b * m[i]!;
      }
    }
  }
  let d = `M${p[0]![0].toFixed(2)} ${p[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(p[i]![0] + h).toFixed(2)} ${(p[i]![1] + t[i]! * h).toFixed(2)} ${(p[i + 1]![0] - h).toFixed(2)} ${(p[i + 1]![1] - t[i + 1]! * h).toFixed(2)} ${p[i + 1]![0].toFixed(2)} ${p[i + 1]![1].toFixed(2)}`;
  }
  return d;
}


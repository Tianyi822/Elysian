/** Timestamp-based geometry for the StatCard's live window. Domain rows stay untouched. */
export type TrendPoint = { time: number; x: number; y: number };
export type TrendPlot = { label: string; color: string; points: TrendPoint[] };
export type TrendFrame = {
  width: number;
  start: number;
  end: number;
  windowMs?: number;
  plots: TrendPlot[];
};

function yAt(points: readonly TrendPoint[], time: number): number {
  const first = points[0]!;
  const last = points.at(-1)!;
  if (time <= first.time) return first.y;
  if (time >= last.time) return last.y;
  const right = points.findIndex(point => point.time >= time);
  const a = points[right - 1]!;
  const b = points[right]!;
  return a.y + (b.y - a.y) * (time - a.time) / (b.time - a.time);
}

function xAt(frame: TrendFrame, time: number): number {
  return frame.end > frame.start ? (time - frame.start) / (frame.end - frame.start) * frame.width : frame.width;
}

/** Pair samples by timestamp, never by array position or SVG command count.
 * Expiring points move beyond the left clip; arriving points enter from the right.
 * Range/size changes and disconnected histories install their complete geometry.
 */
export function trendTransition(from: TrendFrame, to: TrendFrame): ((progress: number) => TrendFrame) | null {
  if (from.width !== to.width || from.windowMs !== to.windowMs || from.plots.length !== to.plots.length ||
    to.end < from.end || to.end - from.end >= to.end - to.start) return null;
  const paired = to.plots.map((plot, index) => {
    const old = from.plots[index]!;
    if (old.label !== plot.label || !old.points.length || !plot.points.length ||
      !old.points.some(point => plot.points.some(next => next.time === point.time))) return null;
    const times = [...new Set([...old.points, ...plot.points].map(point => point.time))].sort((a, b) => a - b);
    return { ...plot, pairs: times.map(time => ({
      time, x0: xAt(from, time), x1: xAt(to, time), y0: yAt(old.points, time), y1: yAt(plot.points, time),
    })) };
  });
  if (paired.some(plot => !plot)) return null;
  return progress => ({
    ...to,
    start: from.start + (to.start - from.start) * progress,
    end: from.end + (to.end - from.end) * progress,
    plots: paired.map(plot => ({ label: plot!.label, color: plot!.color, points: plot!.pairs.map(point => ({
      time: point.time, x: point.x0 + (point.x1 - point.x0) * progress, y: point.y0 + (point.y1 - point.y0) * progress,
    })) })),
  });
}

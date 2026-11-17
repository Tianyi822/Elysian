import { useLayoutEffect, useRef, useState } from 'react';
import { animate } from 'framer-motion';
import { trendTransition, type TrendFrame } from './trend-transition';

/** Numeric coordinates avoid incompatible SVG path-string interpolation on append/eviction. */
export function useTrendAnimation(target: TrendFrame, reduced: boolean | null) {
  const [frame, setFrame] = useState(target);
  const shown = useRef(target);
  useLayoutEffect(() => {
    const install = (next: TrendFrame) => { shown.current = next; setFrame(next); };
    const interpolate = !reduced && shown.current !== target && trendTransition(shown.current, target);
    if (!interpolate) { install(target); return; }
    const controls = animate(0, 1, {
      duration: 0.28, ease: 'linear',
      onUpdate: progress => install(interpolate(progress)),
      onComplete: () => install(target),
    });
    return () => controls.stop();
  }, [target, reduced]);
  return frame;
}

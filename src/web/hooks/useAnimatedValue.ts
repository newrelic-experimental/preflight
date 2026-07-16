import { useState, useEffect, useRef } from 'react';

interface AnimatedValueOptions {
  readonly duration?: number;
  readonly decimals?: number;
  readonly enabled?: boolean;
  /**
   * Custom formatter for the (possibly mid-animation) numeric value. When set,
   * it fully owns the output string — `decimals` is ignored and the caller must
   * NOT also apply a prefix/suffix. Use this so an animated value renders
   * through the same formatter as its static counterpart (e.g. `formatUsd`);
   * otherwise the count-up shows a different precision than the settled value
   * — the exact 2dp-vs-4dp split this guards against for cost KPIs.
   */
  readonly format?: (n: number) => string;
}

function supportsAnimation(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useAnimatedValue(target: number, options: AnimatedValueOptions = {}): string {
  const { duration = 800, decimals = 0, enabled = true, format } = options;
  const shouldAnimate = enabled && supportsAnimation();

  const [current, setCurrent] = useState<number>(() => (shouldAnimate ? 0 : target));
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!shouldAnimate) {
      setCurrent(target);
      return;
    }

    const start = performance.now();

    function tick(now: number): void {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setCurrent(eased * target);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, shouldAnimate]);

  return format ? format(current) : current.toFixed(decimals);
}

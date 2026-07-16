/**
 * @jest-environment jsdom
 */
// jest-environment-jsdom is available via vitest's jsdom dep in node_modules.
// The web test suite is primarily run via `npx vitest run` (see vitest.config.ts),
// but this also passes under Jest when jest-environment-jsdom is available.

import { act, renderHook } from '@testing-library/react';
import { useAnimatedValue } from './useAnimatedValue';

// jsdom does not implement matchMedia, so supportsAnimation() returns false
// and the hook always returns the final value immediately.

describe('useAnimatedValue', () => {
  it('returns formatted target immediately in jsdom (no matchMedia)', () => {
    const { result } = renderHook(() => useAnimatedValue(42));
    expect(result.current).toBe('42');
  });

  it('respects decimals option', () => {
    const { result } = renderHook(() => useAnimatedValue(3.14159, { decimals: 2 }));
    expect(result.current).toBe('3.14');
  });

  it('applies a custom format function and ignores decimals', () => {
    // Guards the cost-KPI fix: the animated value must render through the same
    // formatter as the settled `value`, not a bare toFixed(2), so the count-up
    // and the final string never disagree on precision.
    const fmt = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
    const { result } = renderHook(() => useAnimatedValue(0.42, { decimals: 2, format: fmt }));
    expect(result.current).toBe('$0.4200');
  });

  it('returns target when enabled is false', () => {
    const { result } = renderHook(() => useAnimatedValue(100, { enabled: false }));
    expect(result.current).toBe('100');
  });

  it('updates when target changes', () => {
    const { result, rerender } = renderHook(({ target }) => useAnimatedValue(target), {
      initialProps: { target: 10 },
    });
    expect(result.current).toBe('10');

    rerender({ target: 20 });
    expect(result.current).toBe('20');
  });

  it('re-triggers animation on each target change (hasAnimated must reset)', () => {
    // Enable animation by providing a matchMedia that reports no reduced-motion preference.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query !== '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;

    // rAF: capture callbacks so we can invoke them manually
    const rafCallbacks: Array<(t: number) => void> = [];
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;

    try {
      const { result, rerender } = renderHook(({ target }) => useAnimatedValue(target), {
        initialProps: { target: 100 },
      });

      // First animation: fire one rAF frame at t=0 (start, value = 0)
      expect(rafCallbacks.length).toBeGreaterThan(0);
      const firstFrameCount = rafCallbacks.length;

      // Rerender with new target — with the bug, no new rAF is scheduled
      rerender({ target: 200 });

      // Fix: a new rAF must have been scheduled for the second animation
      expect(rafCallbacks.length).toBeGreaterThan(firstFrameCount);

      // Snap to final value by running the last callback at t >> duration
      const lastCb = rafCallbacks[rafCallbacks.length - 1]!;
      act(() => {
        lastCb(performance.now() + 100_000);
      });
      expect(result.current).toBe('200');
    } finally {
      window.matchMedia = originalMatchMedia;
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  });
});

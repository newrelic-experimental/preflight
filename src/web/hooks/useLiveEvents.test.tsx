import { renderHook, act } from '@testing-library/react';
import { useLiveEvents } from './useLiveEvents';
import { useLiveStore } from '../store/liveStore';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: { data: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((f) => f !== fn),
    );
  }
  emit(type: string, payload: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(payload) });
  }
  close(): void {
    this.closed = true;
  }
}

describe('useLiveEvents', () => {
  let originalES: typeof globalThis.EventSource;
  beforeEach(() => {
    originalES = globalThis.EventSource;
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource;
    FakeEventSource.instances = [];
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
  });
  afterEach(() => {
    globalThis.EventSource = originalES;
  });

  it('opens an EventSource on mount and closes on unmount', () => {
    const { unmount } = renderHook(() => useLiveEvents());
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0].url).toBe('/sse');
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('flips connected=true on onopen', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].onopen?.();
    });
    expect(useLiveStore.getState().connected).toBe(true);
  });

  it('flips connected=false on onerror', () => {
    renderHook(() => useLiveEvents());
    useLiveStore.setState({ connected: true });
    act(() => {
      FakeEventSource.instances[0].onerror?.();
    });
    expect(useLiveStore.getState().connected).toBe(false);
  });

  it('routes tool-call events to pushToolCall', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('tool-call', {
        id: 'x',
        tool: 'Read',
        durationMs: 10,
        costUsd: 0,
        ts: 1,
      });
    });
    expect(useLiveStore.getState().recentToolCalls).toHaveLength(1);
    expect(useLiveStore.getState().recentToolCalls[0].id).toBe('x');
  });

  it('routes cost-update to setCost', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('cost-update', {
        sessionTotalUsd: 1,
        todayTotalUsd: 2,
        forecastEodUsd: 3,
      });
    });
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(1);
  });

  it('routes anti-pattern to pushAntiPattern', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('anti-pattern', {
        type: 'thrashing',
        target: 'auth.ts',
        count: 4,
      });
    });
    expect(useLiveStore.getState().antiPatterns).toHaveLength(1);
  });

  describe('REST hydration of anti-patterns', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('maps the real AntiPattern shape into the store, not the SSE shape', async () => {
      globalThis.fetch = vi.fn((url: string, _init?: RequestInit) => {
        if (url === '/api/anti-patterns') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                { type: 're_reading', file: 'auth.ts', readCount: 4, suggestion: 'x' },
              ]),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }) as typeof globalThis.fetch;

      renderHook(() => useLiveEvents());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const patterns = useLiveStore.getState().antiPatterns;
      expect(patterns).toHaveLength(1);
      expect(patterns[0].type).toBe('re_reading');
      expect(patterns[0].target).toBe('auth.ts');
      expect(patterns[0].count).toBe(4);
    });
  });

  describe('staleness watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('flips connected=false when no event arrives within the staleness window', () => {
      renderHook(() => useLiveEvents());
      act(() => {
        FakeEventSource.instances[0].onopen?.();
      });
      expect(useLiveStore.getState().connected).toBe(true);

      // Advance past the 75s staleness window. Watchdog ticks every 10s
      // and should detect the stall on its next tick.
      act(() => {
        vi.advanceTimersByTime(80_000);
      });
      expect(useLiveStore.getState().connected).toBe(false);
    });

    it('keeps connected=true while heartbeats keep arriving', () => {
      renderHook(() => useLiveEvents());
      act(() => {
        FakeEventSource.instances[0].onopen?.();
      });

      // Heartbeat every 30s for 2 minutes — should never go stale.
      for (let i = 0; i < 4; i++) {
        act(() => {
          vi.advanceTimersByTime(30_000);
          FakeEventSource.instances[0].emit('heartbeat', { ts: Date.now() });
        });
      }
      expect(useLiveStore.getState().connected).toBe(true);
    });

    it('data events do NOT reset the staleness clock — heartbeat is the contract', () => {
      // Regression guard: a busy session (lots of tool-call events) where
      // heartbeats stop arriving must still be flagged as stale. Liveness
      // is proven by the heartbeat protocol, not by data flow.
      renderHook(() => useLiveEvents());
      act(() => {
        FakeEventSource.instances[0].onopen?.();
      });

      // Stream a tool-call every 10s for 80s — plenty of data, no heartbeat.
      for (let i = 0; i < 8; i++) {
        act(() => {
          vi.advanceTimersByTime(10_000);
          FakeEventSource.instances[0].emit('tool-call', {
            id: `t${i}`,
            tool: 'Read',
            durationMs: 1,
            costUsd: 0,
            ts: i,
          });
        });
      }
      expect(useLiveStore.getState().connected).toBe(false);
    });

    it('a heartbeat after a stale period restores connected=true', () => {
      // A reconnect (without onopen firing) is the realistic recovery path
      // for transient proxy hiccups. The first heartbeat after the gap
      // proves liveness has resumed.
      renderHook(() => useLiveEvents());
      act(() => {
        FakeEventSource.instances[0].onopen?.();
      });
      act(() => {
        vi.advanceTimersByTime(80_000);
      });
      expect(useLiveStore.getState().connected).toBe(false);

      act(() => {
        FakeEventSource.instances[0].emit('heartbeat', { ts: Date.now() });
      });
      expect(useLiveStore.getState().connected).toBe(true);
    });

    it('clears the watchdog interval on unmount', () => {
      const { unmount } = renderHook(() => useLiveEvents());
      act(() => {
        FakeEventSource.instances[0].onopen?.();
      });
      unmount();
      // After unmount, advancing time must not flip connection state —
      // a leaked interval would mutate the store post-cleanup.
      useLiveStore.setState({ connected: true });
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(useLiveStore.getState().connected).toBe(true);
    });
  });
});

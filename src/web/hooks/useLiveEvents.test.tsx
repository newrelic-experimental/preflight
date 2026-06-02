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
});

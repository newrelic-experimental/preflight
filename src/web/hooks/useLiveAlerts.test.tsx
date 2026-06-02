import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveAlerts } from './useLiveAlerts';
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

function resetStore(): void {
  useLiveStore.setState({
    connected: false,
    recentToolCalls: [],
    cost: null,
    antiPatterns: [],
    firingAlerts: new Map(),
    dismissedAlerts: new Set(),
  });
}

describe('useLiveAlerts', () => {
  let originalES: typeof globalThis.EventSource;
  beforeEach(() => {
    originalES = globalThis.EventSource;
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource;
    FakeEventSource.instances = [];
    resetStore();
  });
  afterEach(() => {
    globalThis.EventSource = originalES;
  });

  it('returns an empty list when no alerts are firing', () => {
    const { result } = renderHook(() => useLiveAlerts());
    expect(result.current.alerts).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.maxSeverity).toBeNull();
  });

  it('reflects firing alerts from the store', () => {
    const { result } = renderHook(() => useLiveAlerts());
    act(() => {
      useLiveStore.getState().addOrUpdateAlert({
        id: 'r1',
        state: 'firing',
        severity: 'critical',
        title: 'Critical rule',
        description: 'spike',
        value: 10,
        threshold: 5,
        firedAt: 1000,
      });
    });
    expect(result.current.count).toBe(1);
    expect(result.current.alerts[0].id).toBe('r1');
    expect(result.current.maxSeverity).toBe('critical');
  });

  it('exposes a dismiss action that hides the alert', () => {
    const { result } = renderHook(() => useLiveAlerts());
    act(() => {
      useLiveStore.getState().addOrUpdateAlert({
        id: 'r1',
        state: 'firing',
        severity: 'warning',
        title: 'Warn',
        description: '',
        value: 1,
        threshold: 0,
        firedAt: 1,
      });
    });
    expect(result.current.count).toBe(1);
    act(() => {
      result.current.dismiss('r1');
    });
    expect(result.current.count).toBe(0);
    // Underlying alert is still firing, just hidden.
    expect(useLiveStore.getState().firingAlerts.size).toBe(1);
  });
});

describe('useLiveEvents — alert event routing', () => {
  let originalES: typeof globalThis.EventSource;
  beforeEach(() => {
    originalES = globalThis.EventSource;
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource;
    FakeEventSource.instances = [];
    resetStore();
  });
  afterEach(() => {
    globalThis.EventSource = originalES;
  });

  it('routes firing alert events into firingAlerts', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('alert', {
        id: 'rule-1',
        state: 'firing',
        severity: 'critical',
        title: 'High cost',
        description: 'spike',
        value: 10,
        threshold: 5,
        firedAt: 1234,
      });
    });
    const s = useLiveStore.getState();
    expect(s.firingAlerts.size).toBe(1);
    expect(s.firingAlerts.get('rule-1')?.title).toBe('High cost');
  });

  it('routes cleared alert events to remove from firingAlerts', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('alert', {
        id: 'rule-1',
        state: 'firing',
        severity: 'warning',
        title: 't',
        description: '',
        value: 1,
        threshold: 0,
        firedAt: 1,
      });
    });
    expect(useLiveStore.getState().firingAlerts.size).toBe(1);
    act(() => {
      FakeEventSource.instances[0].emit('alert', {
        id: 'rule-1',
        state: 'cleared',
        severity: 'warning',
        title: 't',
        description: '',
        value: 0,
        threshold: 0,
        firedAt: 1,
      });
    });
    expect(useLiveStore.getState().firingAlerts.size).toBe(0);
  });

  it('ignores malformed alert payloads silently', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      const inst = FakeEventSource.instances[0];
      // Pass an unparseable string payload directly.
      for (const fn of inst.listeners.get('alert') ?? []) {
        fn({ data: 'not-json' });
      }
    });
    // No throw, no firing alert added.
    expect(useLiveStore.getState().firingAlerts.size).toBe(0);
  });
});

import { useEffect } from 'react';
import { useLiveStore } from '../store/liveStore';

// Liveness contract: the SSE handler emits an `event: heartbeat` frame
// every 30s (sse-handler.ts: HEARTBEAT_MS) regardless of activity. That
// frame — not data — is the signal we use to prove the stream is alive.
// Tying liveness to data would falsely report "disconnected" on idle
// sessions where the daemon is healthy but no tool calls are happening.
//
// EventSource.onerror catches most disconnects, but not all: a proxy or
// NAT can keep the TCP socket OPEN after the upstream daemon dies, so
// readyState lies. The heartbeat watchdog is the safety net for that
// half-open case. Threshold is 2.5x the heartbeat interval to absorb
// jitter and one missed frame.
const STALE_AFTER_MS = 75_000;
const WATCHDOG_TICK_MS = 10_000;

interface SessionCurrentResponse {
  readonly sessionId?: string;
  readonly toolCallCount?: number;
  readonly toolCallTimeline?: ReadonlyArray<{
    readonly timestamp: number;
    readonly toolName: string;
    readonly durationMs: number | null;
    readonly success: boolean;
  }>;
}

function hydrateFromApi(signal: AbortSignal): void {
  const store = useLiveStore.getState();

  fetch('/api/session/current', { signal })
    .then((r) => (r.ok ? (r.json() as Promise<SessionCurrentResponse>) : null))
    .then((data) => {
      if (!data?.toolCallTimeline) return;
      for (const tc of data.toolCallTimeline) {
        store.pushToolCall({
          id: `${tc.timestamp}-${tc.toolName}`,
          tool: tc.toolName,
          durationMs: tc.durationMs ?? 0,
          costUsd: 0,
          ts: tc.timestamp,
          sessionId: data.sessionId,
        });
      }
    })
    .catch(() => {});

  // Cost hydration intentionally skipped — the /api/cost endpoint returns
  // session-scoped values that don't reflect the daily aggregate. Setting them
  // in the store would race with SSE (which emits daily-aware totals) and cause
  // the forecast to appear less than the daily spend. The Today view's React
  // Query fallback (persistedTodaySpend + session cost) handles the pre-SSE
  // window correctly.

  fetch('/api/anti-patterns', { signal })
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((data) => {
      if (!Array.isArray(data)) return;
      for (const ap of data) {
        if (ap && typeof ap === 'object' && 'type' in ap) {
          store.pushAntiPattern(ap as { type: string; target: string; count: number });
        }
      }
    })
    .catch(() => {});
}

export function useLiveEvents(url: string = '/sse'): void {
  useEffect(() => {
    const controller = new AbortController();
    hydrateFromApi(controller.signal);

    // Heartbeat-only liveness clock. Data events deliberately do NOT reset
    // it — an idle session is still alive, and a busy session that happens
    // to lose heartbeats should still be flagged. Heartbeat is the contract.
    let lastHeartbeatAt = Date.now();

    // Defer EventSource open until after window.load. Persistent connections
    // opened during initial render keep the browser's loading indicator
    // spinning until the user manually stops the page, even though the app
    // has fully rendered. By waiting for the load event we let the page
    // reach `complete` readyState first, then attach the live stream — UX
    // feels normal and we don't lose any events (the bus replays from
    // Last-Event-ID on reconnect anyway).
    let es: EventSource | null = null;

    const startStream = (): void => {
      if (es || controller.signal.aborted) return;
      es = new EventSource(url);

      es.onopen = (): void => {
        lastHeartbeatAt = Date.now();
        useLiveStore.getState().setConnected(true);
      };
      es.onerror = (): void => useLiveStore.getState().setConnected(false);

      es.addEventListener('tool-call', onToolCall as EventListener);
      es.addEventListener('cost-update', onCost as EventListener);
      es.addEventListener('anti-pattern', onAnti as EventListener);
      es.addEventListener('alert', onAlert as EventListener);
      es.addEventListener('context-update', onContext as EventListener);
      es.addEventListener('heartbeat', onHeartbeat as EventListener);
    };

    // read live state inside each callback rather than capturing
    // a one-time snapshot at effect-run time. Zustand action references
    // are stable today, but a future memoization or selector wrapper
    // would silently break the captured-snapshot pattern.
    const onToolCall = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushToolCall(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onCost = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().setCost(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAnti = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushAntiPattern(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAlert = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().addOrUpdateAlert(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onContext = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().setContext(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    // The heartbeat carries no app payload — it exists solely as the
    // liveness signal. We also use it to recover from the case where
    // EventSource silently reconnected without firing onopen (rare but
    // observed when a proxy retries the upstream connection mid-stream).
    const onHeartbeat = (): void => {
      lastHeartbeatAt = Date.now();
      const store = useLiveStore.getState();
      if (!store.connected) store.setConnected(true);
    };

    // Conditionally start the stream now or after window.load.
    if (typeof document !== 'undefined' && document.readyState === 'complete') {
      startStream();
    } else if (typeof window !== 'undefined') {
      window.addEventListener('load', startStream, { once: true });
    } else {
      // Non-browser environment (SSR/test): open immediately.
      startStream();
    }

    const watchdog = setInterval(() => {
      if (Date.now() - lastHeartbeatAt > STALE_AFTER_MS) {
        const store = useLiveStore.getState();
        if (store.connected) store.setConnected(false);
      }
    }, WATCHDOG_TICK_MS);

    return (): void => {
      controller.abort();
      clearInterval(watchdog);
      if (typeof window !== 'undefined') {
        window.removeEventListener('load', startStream);
      }
      if (es) {
        es.removeEventListener('tool-call', onToolCall as EventListener);
        es.removeEventListener('cost-update', onCost as EventListener);
        es.removeEventListener('anti-pattern', onAnti as EventListener);
        es.removeEventListener('alert', onAlert as EventListener);
        es.removeEventListener('context-update', onContext as EventListener);
        es.removeEventListener('heartbeat', onHeartbeat as EventListener);
        es.close();
      }
    };
  }, [url]);
}

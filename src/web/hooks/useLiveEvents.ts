import { useEffect } from 'react';
import { useLiveStore } from '../store/liveStore';

export function useLiveEvents(url: string = '/sse'): void {
  useEffect(() => {
    const es = new EventSource(url);
    const store = useLiveStore.getState();

    es.onopen = (): void => useLiveStore.getState().setConnected(true);
    es.onerror = (): void => useLiveStore.getState().setConnected(false);

    const onToolCall = (e: MessageEvent): void => {
      try {
        store.pushToolCall(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onCost = (e: MessageEvent): void => {
      try {
        store.setCost(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAnti = (e: MessageEvent): void => {
      try {
        store.pushAntiPattern(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAlert = (e: MessageEvent): void => {
      try {
        store.addOrUpdateAlert(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };

    es.addEventListener('tool-call', onToolCall as EventListener);
    es.addEventListener('cost-update', onCost as EventListener);
    es.addEventListener('anti-pattern', onAnti as EventListener);
    es.addEventListener('alert', onAlert as EventListener);

    return (): void => {
      es.removeEventListener('tool-call', onToolCall as EventListener);
      es.removeEventListener('cost-update', onCost as EventListener);
      es.removeEventListener('anti-pattern', onAnti as EventListener);
      es.removeEventListener('alert', onAlert as EventListener);
      es.close();
    };
  }, [url]);
}

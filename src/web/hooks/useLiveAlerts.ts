import { useShallow } from 'zustand/react/shallow';
import {
  useLiveStore,
  selectVisibleFiringAlerts,
  selectMaxSeverity,
  type AlertEvent,
} from '../store/liveStore';

export interface UseLiveAlertsResult {
  readonly alerts: readonly AlertEvent[];
  readonly maxSeverity: AlertEvent['severity'] | null;
  readonly count: number;
  dismiss(id: string): void;
}

/**
 * Convenience selector hook for the alert slice of the live store. Components
 * that only need the firing-alert list and dismiss action should use this in
 * preference to subscribing to the whole store.
 */
export function useLiveAlerts(): UseLiveAlertsResult {
  // zustand v5 uses Object.is for selector equality. selectVisibleFiringAlerts
  // returns a fresh array each call — without useShallow, every store change
  // triggers a re-render even when the alert set is unchanged.
  const alerts = useLiveStore(useShallow(selectVisibleFiringAlerts));
  const maxSeverity = useLiveStore(selectMaxSeverity);
  const dismiss = useLiveStore((s) => s.dismissAlert);
  return { alerts, maxSeverity, count: alerts.length, dismiss };
}

import { create } from 'zustand';

export interface ToolCallEvent {
  readonly id: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

// Mirror of the AlertEvent shape from src/dashboard/live-event-bus.ts. Kept
// local to the SPA to keep the web bundle decoupled from the server tree —
// see CLAUDE.md "Type imports" guidance.
export interface AlertEvent {
  readonly id: string;
  readonly state: 'firing' | 'cleared';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly threshold: number;
  readonly firedAt: number;
}

interface LiveState {
  readonly connected: boolean;
  readonly recentToolCalls: ToolCallEvent[];
  readonly cost: CostUpdateEvent | null;
  readonly antiPatterns: AntiPatternEvent[];
  readonly firingAlerts: Map<string, AlertEvent>;
  readonly dismissedAlerts: Set<string>;
  setConnected(v: boolean): void;
  pushToolCall(e: ToolCallEvent): void;
  setCost(c: CostUpdateEvent): void;
  pushAntiPattern(e: AntiPatternEvent): void;
  addOrUpdateAlert(e: AlertEvent): void;
  clearAlert(id: string): void;
  dismissAlert(id: string): void;
}

const RECENT_CAP = 20;
const ANTI_CAP = 10;

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  recentToolCalls: [],
  cost: null,
  antiPatterns: [],
  firingAlerts: new Map(),
  dismissedAlerts: new Set(),

  setConnected: (v) => set({ connected: v }),

  pushToolCall: (e) =>
    set((s) => {
      const next = [...s.recentToolCalls, e];
      return {
        recentToolCalls: next.length > RECENT_CAP ? next.slice(next.length - RECENT_CAP) : next,
      };
    }),

  setCost: (c) => set({ cost: c }),

  pushAntiPattern: (e) =>
    set((s) => {
      const next = [...s.antiPatterns, e];
      return { antiPatterns: next.length > ANTI_CAP ? next.slice(next.length - ANTI_CAP) : next };
    }),

  addOrUpdateAlert: (e) =>
    set((s) => {
      const next = new Map(s.firingAlerts);
      if (e.state === 'firing') {
        next.set(e.id, e);
      } else {
        // 'cleared' — drop from firing set. Also unstick any prior
        // dismissal so the rule can fire fresh next time without being
        // silently filtered out.
        next.delete(e.id);
        if (s.dismissedAlerts.has(e.id)) {
          const dismissed = new Set(s.dismissedAlerts);
          dismissed.delete(e.id);
          return { firingAlerts: next, dismissedAlerts: dismissed };
        }
      }
      return { firingAlerts: next };
    }),

  clearAlert: (id) =>
    set((s) => {
      if (!s.firingAlerts.has(id)) return s;
      const next = new Map(s.firingAlerts);
      next.delete(id);
      return { firingAlerts: next };
    }),

  dismissAlert: (id) =>
    set((s) => {
      if (s.dismissedAlerts.has(id)) return s;
      const dismissed = new Set(s.dismissedAlerts);
      dismissed.add(id);
      return { dismissedAlerts: dismissed };
    }),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<AlertEvent['severity'], number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/** Currently-firing alerts that the user has not dismissed this session. */
export function selectVisibleFiringAlerts(state: LiveState): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const alert of state.firingAlerts.values()) {
    if (!state.dismissedAlerts.has(alert.id)) out.push(alert);
  }
  // Stable order: critical first, then warning, then info; ties broken by
  // firedAt so older alerts surface above newer ones at the same severity.
  out.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.firedAt - b.firedAt;
  });
  return out;
}

/** Highest severity present in the (non-dismissed) firing alert set, else null. */
export function selectMaxSeverity(state: LiveState): AlertEvent['severity'] | null {
  let best: AlertEvent['severity'] | null = null;
  for (const alert of state.firingAlerts.values()) {
    if (state.dismissedAlerts.has(alert.id)) continue;
    if (best === null || SEVERITY_RANK[alert.severity] > SEVERITY_RANK[best]) {
      best = alert.severity;
    }
  }
  return best;
}

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

// Events that originate from a specific Claude Code session carry `sessionId`
// so the Today view can filter by `activeId`. Optional on the client side
// because (a) the SSE feed may be subscribed without a sessionId filter
// (aggregate view), and (b) older / synthetic events from hydrateFromApi flows
// may not have it set yet — we treat missing sessionId as "always visible" to
// avoid surprise empty UIs during the rollout window.
export interface ToolCallEvent {
  readonly id: string;
  readonly sessionId?: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionId?: string;
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly sessionId?: string;
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

// Mirror of the AlertEvent shape from src/dashboard/live-event-bus.ts, minus
// its optional `sessionId` — alerts aren't session-scoped client-side (every
// firing alert is shown regardless of which session triggered it). Kept
// local to the SPA to keep the web bundle decoupled from the server tree.
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

export interface ContextUpdateEvent {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly totalTokens: number;
  readonly fillPercent: number;
  /**
   * Per-model context window cap (tokens). Mirrors the server-side
   * ContextUpdateEvent so the SSE feed is the single source of truth for
   * the "X / Y" denominator — avoiding the X-from-SSE / Y-from-API cap
   * mismatch on the first Opus turn.
   */
  readonly contextWindow: number;
  readonly breakdown: {
    readonly system: number;
    readonly tools: number;
    readonly user: number;
    readonly assistant: number;
  };
  readonly growth: {
    readonly startTokens: number;
    readonly currentTokens: number;
    readonly delta: number;
  };
  readonly topTools: ReadonlyArray<{ readonly tool: string; readonly estimatedTokens: number }>;
}

export interface WorkflowRunLiveState {
  readonly workflowRunId: string;
  readonly runSource: 'agent_tool' | 'script';
  readonly workflowName: string;
  readonly status: string;
  readonly agentCount: number;
  readonly totalTokens: number;
  readonly ts: number;
}

export interface ObservabilityHealthState {
  readonly filesWatched: number;
  readonly parseErrors: number;
  readonly watcherDisabledByLock: boolean;
  readonly ts: number;
}

interface LiveState {
  readonly connected: boolean;
  readonly recentToolCalls: ToolCallEvent[];
  readonly cost: CostUpdateEvent | null;
  readonly antiPatterns: AntiPatternEvent[];
  readonly contextBySession: Map<string, ContextUpdateEvent>;
  readonly firingAlerts: Map<string, AlertEvent>;
  readonly dismissedAlerts: Set<string>;
  // The user-selected session in the Today selector list. When this changes,
  // the per-session caches (recentToolCalls, antiPatterns, cost) re-key so
  // the previous session's events don't pollute the new selection. `null` =
  // no session selected (e.g. nothing live yet); events with a sessionId
  // still flow into the store but views that filter on activeSessionId render
  // empty until a selection is made.
  readonly activeSessionId: string | null;
  readonly todaySubagentUsd: number;
  readonly todaySubagentTurnCount: number;
  readonly recentWorkflowRuns: WorkflowRunLiveState[];
  readonly observabilityHealth: ObservabilityHealthState | null;
  setConnected(v: boolean): void;
  pushToolCall(e: ToolCallEvent): void;
  setCost(c: CostUpdateEvent): void;
  pushAntiPattern(e: AntiPatternEvent): void;
  setContext(c: ContextUpdateEvent): void;
  addOrUpdateAlert(e: AlertEvent): void;
  clearAlert(id: string): void;
  dismissAlert(id: string): void;
  setActiveSession(id: string | null): void;
  addSubagentTurn(usdEstimate: number | null): void;
  upsertWorkflowRun(run: WorkflowRunLiveState): void;
  setObservabilityHealth(health: ObservabilityHealthState): void;
}

const RECENT_CAP = 20;
const ANTI_CAP = 10;

const WORKFLOW_CAP = 50;

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  recentToolCalls: [],
  cost: null,
  antiPatterns: [],
  contextBySession: new Map(),
  firingAlerts: new Map(),
  dismissedAlerts: new Set(),
  activeSessionId: null,
  todaySubagentUsd: 0,
  todaySubagentTurnCount: 0,
  recentWorkflowRuns: [],
  observabilityHealth: null,

  setConnected: (v) => set({ connected: v }),

  // Switching the active session must not leave the previous session's tool
  // calls and anti-patterns in view. We re-key the per-session caches by
  // dropping entries whose sessionId doesn't match the new id. Events without
  // a sessionId (legacy fixtures, hydrateFromApi prior to the server-side
  // change) are dropped on switch — keeping them would create ambiguous
  // "is this mine?" rendering. Cost is treated similarly: the SSE feed will
  // replace it on the next cost-update from the new session, so clearing it
  // here avoids showing an old session's last-known total.
  setActiveSession: (id) =>
    set((s) => {
      if (s.activeSessionId === id) return {};
      const matchOrUnknown = (sid: string | undefined): boolean =>
        id === null ? sid === undefined : sid === id;
      return {
        activeSessionId: id,
        recentToolCalls: s.recentToolCalls.filter((t) => matchOrUnknown(t.sessionId)),
        antiPatterns: s.antiPatterns.filter((a) => matchOrUnknown(a.sessionId)),
        cost: s.cost && matchOrUnknown(s.cost.sessionId) ? s.cost : null,
      };
    }),

  pushToolCall: (e) =>
    set((s) => {
      // Deduplicate by id — but only within a single path. hydrateFromApi()
      // builds id as `${timestamp}-${toolName}` (no server id available on
      // that response shape), while the SSE path forwards the server's real
      // randomUUID()-based id, so a hydrate-then-SSE double-emit of the same
      // underlying tool call is NOT caught here — only same-path repeats
      // (e.g. an SSE reconnect replaying an already-seen event) are.
      if (s.recentToolCalls.some((t) => t.id === e.id)) return {};
      const next = [...s.recentToolCalls, e];
      return {
        recentToolCalls: next.length > RECENT_CAP ? next.slice(next.length - RECENT_CAP) : next,
      };
    }),

  setCost: (c) => set({ cost: c }),

  setContext: (c) =>
    set((s) => {
      const next = new Map(s.contextBySession);
      next.set(c.sessionId, c);
      return { contextBySession: next };
    }),

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

  addSubagentTurn: (usdEstimate) =>
    set((s) => ({
      todaySubagentTurnCount: s.todaySubagentTurnCount + 1,
      todaySubagentUsd: usdEstimate != null ? s.todaySubagentUsd + usdEstimate : s.todaySubagentUsd,
    })),

  upsertWorkflowRun: (run) =>
    set((s) => {
      const filtered = s.recentWorkflowRuns.filter((r) => r.workflowRunId !== run.workflowRunId);
      const next = [...filtered, run];
      return {
        recentWorkflowRuns:
          next.length > WORKFLOW_CAP ? next.slice(next.length - WORKFLOW_CAP) : next,
      };
    }),

  setObservabilityHealth: (health) => set({ observabilityHealth: health }),
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

// This selector returns a fresh `{ usd, turns }` object on every call. In
// zustand v5 (built on React's useSyncExternalStore) a selector that allocates
// a new object/array each render makes the snapshot compare unequal every time,
// which drives an infinite re-render loop (React error #185). Wrapping with
// `useShallow` makes zustand shallow-compare the projected fields, so the hook
// only triggers a re-render when `usd` or `turns` actually changes — while
// keeping the `{ usd, turns }` call-site API intact.
export const useSubagentStats = (): { usd: number; turns: number } =>
  useLiveStore(useShallow((s) => ({ usd: s.todaySubagentUsd, turns: s.todaySubagentTurnCount })));
export const useRecentWorkflows = (): WorkflowRunLiveState[] =>
  useLiveStore((s) => s.recentWorkflowRuns);
export const useObservabilityHealth = (): ObservabilityHealthState | null =>
  useLiveStore((s) => s.observabilityHealth);

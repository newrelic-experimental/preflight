// Distinct error class for 404 responses so callers can treat
// "feature unavailable" differently from a real server error. Used by the
// recent-alerts panel: in cloud mode the alert engine is not constructed,
// so /api/alerts/recent returns 404 — the UI must render an empty state,
// not a permanent red error banner.
export class NotFoundError extends Error {
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = 'NotFoundError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 404) throw new NotFoundError(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return (await res.json()) as T;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly uptime: number;
  readonly version: string;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
}

export const fetchHealth = (): Promise<HealthResponse> => getJson<HealthResponse>('/api/health');

export const fetchSessionCurrent = (): Promise<unknown> => getJson<unknown>('/api/session/current');
export const fetchSessionToday = (): Promise<unknown> => getJson<unknown>('/api/session/today');
export const fetchSessionsList = (limit = 50): Promise<unknown> =>
  getJson<unknown>(`/api/sessions?limit=${limit}`);
// Cross-session aggregate KPIs for the Today view.
export const fetchTodayAggregate = (): Promise<unknown> =>
  getJson<unknown>('/api/sessions/today/aggregate');
// Currently-live session list (for the Today selector to default to the
// most-recently-active session).
export const fetchLiveSessions = (): Promise<unknown> => getJson<unknown>('/api/sessions/live');
export const fetchSessionDetail = (id: string): Promise<unknown> =>
  getJson<unknown>(`/api/sessions/${encodeURIComponent(id)}`);
export const fetchCost = (): Promise<unknown> => getJson<unknown>('/api/cost');
export const fetchAntiPatterns = (): Promise<unknown> => getJson<unknown>('/api/anti-patterns');
export const fetchAuditLog = (): Promise<unknown> => getJson<unknown>('/api/audit');
export const fetchWeekly = (): Promise<unknown> => getJson<unknown>('/api/weekly');
export const fetchBudget = (): Promise<unknown> => getJson<unknown>('/api/budget');
export const fetchLatency = (): Promise<unknown> => getJson<unknown>('/api/latency');
export const fetchCostPerOutcome = (days = 30): Promise<unknown> =>
  getJson<unknown>(`/api/cost-per-outcome?days=${days}`);
export const fetchPersonalCoach = (): Promise<unknown> => getJson<unknown>('/api/personal-coach');
export const fetchRecentAlerts = (): Promise<unknown> => getJson<unknown>('/api/alerts/recent');
export const fetchSessionReplay = (id: string): Promise<unknown> =>
  getJson<unknown>(`/api/sessions/${encodeURIComponent(id)}/replay`);
export const fetchQualityProxy = (): Promise<unknown> => getJson<unknown>('/api/quality-proxy');
export const fetchToolSelectionScore = (): Promise<unknown> =>
  getJson<unknown>('/api/tool-selection-score');
export const fetchGitEfficiency = (): Promise<unknown> => getJson<unknown>('/api/git-efficiency');
export const fetchGitEfficiencyRepos = (): Promise<unknown> =>
  getJson<unknown>('/api/git-efficiency/repos');
export const fetchConcurrency = (): Promise<unknown> => getJson<unknown>('/api/concurrency');
export const fetchConcurrencyHistory = (days = 30): Promise<unknown> =>
  getJson<unknown>(`/api/concurrency?view=history&days=${days}`);
export const fetchActivityHeatmap = (view: string, weeks?: number): Promise<unknown> =>
  getJson<unknown>(
    `/api/activity-heatmap?view=${encodeURIComponent(view)}${weeks ? `&weeks=${weeks}` : ''}`,
  );
export const fetchContext = (sessionId?: string): Promise<unknown> =>
  getJson<unknown>(
    sessionId ? `/api/context?sessionId=${encodeURIComponent(sessionId)}` : '/api/context',
  );

export interface SettingsPatch {
  developer?: string;
  teamId?: string | null;
  sessionBudgetUsd?: number | null;
  dailyBudgetUsd?: number | null;
  weeklyBudgetUsd?: number | null;
  retainSessionsDays?: number | null;
  digestWebhookUrl?: string | null;
  digestSchedule?: string;
  alerts?: {
    personal?: {
      dailyCostUsd?: number;
      sessionCostUsd?: number;
      efficiencyScoreMin?: number;
      stuckLoopCountMax?: number;
      antiPatternCountMax?: number;
    };
  };
}

export const fetchModelUsage = (): Promise<unknown> => getJson<unknown>('/api/model-usage');

export const fetchSettings = (): Promise<unknown> => getJson<unknown>('/api/settings');

export const patchSettings = (body: SettingsPatch): Promise<unknown> =>
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as unknown;
  });

export const postDigestSend = (): Promise<unknown> =>
  fetch('/api/digest/send', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as unknown;
  });

export const qk = {
  sessionCurrent: ['session', 'current'] as const,
  sessionToday: ['session', 'today'] as const,
  sessionsList: (limit: number) => ['sessions', 'list', limit] as const,
  sessionDetail: (id: string) => ['session', id] as const,
  cost: ['cost'] as const,
  antiPatterns: ['anti-patterns'] as const,
  audit: ['audit'] as const,
  weekly: ['weekly'] as const,
  budget: ['budget'] as const,
  latency: ['latency'] as const,
  costPerOutcome: (days: number) => ['cost-per-outcome', days] as const,
  personalCoach: ['personal-coach'] as const,
  alertsRecent: ['alerts', 'recent'] as const,
  sessionReplay: (id: string) => ['session', id, 'replay'] as const,
  qualityProxy: ['quality-proxy'] as const,
  toolSelectionScore: ['tool-selection-score'] as const,
  gitEfficiency: ['git-efficiency'] as const,
  gitEfficiencyRepos: ['git-efficiency-repos'] as const,
  concurrency: ['concurrency'] as const,
  concurrencyHistory: (days: number) => ['concurrency', 'history', days] as const,
  activityHeatmap: (view: string) => ['activity-heatmap', view] as const,
  context: ['context'] as const,
  modelUsage: ['model-usage'] as const,
  settings: ['settings'] as const,
  // Query keys for live session and today aggregate endpoints
  sessionsLive: ['sessions', 'live'] as const,
  sessionsTodayAggregate: ['sessions', 'today', 'aggregate'] as const,
};

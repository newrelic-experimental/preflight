// Distinct error class for 404 responses so callers can treat
// "feature unavailable" differently from a real server error. Used by the
// recent-alerts panel: in cloud mode the alert engine is not constructed,
// so /api/alerts/recent returns 404 — the UI must render an empty state,
// not a permanent red error banner. See F-007 in docs/CODE_REVIEW.md.
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

export const fetchSessionCurrent = (): Promise<unknown> => getJson<unknown>('/api/session/current');
export const fetchSessionToday = (): Promise<unknown> => getJson<unknown>('/api/session/today');
export const fetchSessionsList = (limit = 50): Promise<unknown> =>
  getJson<unknown>(`/api/sessions?limit=${limit}`);
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
};

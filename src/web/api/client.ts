async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
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
};

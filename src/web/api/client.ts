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

export interface AntiPattern {
  readonly type: 'thrashing' | 're_reading' | 'stuck_loop' | 'blind_editing' | 'over_delegation';
  readonly file?: string;
  readonly command?: string;
  readonly bashCategory?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
  readonly suggestion: string;
}

// Real server type also has `sessionId`/`sessionName`/`liveSessions`/many more
// counters (see SessionTracker.getMetrics() + efficiencyScore/liveSessions
// added by the route). Declared fully so every current and future consumer
// gets full field access without re-casting.
export interface SessionCurrentResponse {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly sessionStartTime: number;
  readonly sessionDurationMs: number;
  readonly toolCallCount: number;
  readonly toolCallCountByTool: Record<string, number>;
  readonly toolDurationMsByTool: Record<
    string,
    { count: number; sum: number; min: number; max: number; p95: number }
  >;
  readonly toolSuccessRate: number | null;
  readonly toolSuccessRateByTool: Record<string, number>;
  readonly toolErrorCount: number;
  readonly toolErrorsByType: Record<string, number>;
  readonly uniqueFilesRead: number;
  readonly uniqueFilesWritten: number;
  readonly bashCommandsRun: number;
  readonly bashExitCodes: Record<string, number>;
  readonly bashCallsByCategory: Record<string, number>;
  readonly searchQueries: number;
  readonly toolCallTimeline: ReadonlyArray<{
    timestamp: number;
    toolName: string;
    durationMs: number | null;
    success: boolean;
  }>;
  readonly timelineTruncated: boolean;
  readonly timelineEntryCount: number;
  readonly efficiencyScore: number | null;
  readonly liveSessions: string[];
}

export interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface LatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles | null>>;
  readonly slowestCalls: ReadonlyArray<{
    readonly toolName: string;
    readonly durationMs: number;
    readonly timestamp: number;
    readonly filePath?: string;
  }>;
}

export interface ReplayTimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
  readonly isTestCommand?: boolean;
  readonly isBuildCommand?: boolean;
  readonly isLintCommand?: boolean;
  readonly errorType?: string;
}

export interface AntiPatternSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly iterations: number;
  readonly target: string;
  readonly severity: 'warning' | 'critical';
}

export interface SessionReplayResponse {
  readonly sessionId: string;
  readonly timeline: ReplayTimelineEntry[];
  readonly segments: AntiPatternSegment[];
  readonly worstSegment: AntiPatternSegment | null;
}

export interface TodayAggregateResponse {
  readonly toolCallCount: number;
  readonly totalCostUsd: number;
  readonly antiPatternCount: number;
  readonly avgDurationMs: number;
  readonly sessionCount: number;
  readonly sparkline: {
    readonly startTimestamp: number;
    readonly bucketSizeMs: number;
    readonly points: readonly number[];
  };
}

// /api/sessions returns a heterogeneous mix of full persisted session
// summaries and small live-session stub objects (see the route handler at
// api-handler.ts:641) — only sessionId is guaranteed present on every item.
export interface SessionListEntry {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly antiPatterns?: Array<{ type: string; count: number }>;
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
  readonly efficiencyScore?: number | null;
}

export interface LiveSessionEntry {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly startTime: number;
  readonly lastActivity: number;
}

export interface CostBreakdown {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly thinkingUsd: number;
  readonly cacheReadUsd: number;
  readonly cacheCreationUsd: number;
  readonly totalUsd: number;
  readonly savingsFromCacheUsd: number;
}

export interface CostMetrics {
  readonly sessionTotalCostUsd: number | null;
  readonly costByTask: null;
  readonly costByModel: Record<string, number>;
  readonly costPerLineOfCode: number | null;
  readonly costPerFileModified: number | null;
  readonly model: string | null;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalThinkingTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly cacheHitRate: number | null;
  readonly totalCacheSavingsUsd: number;
  readonly reportCount: number;
  readonly estimationCount: number;
  readonly latestCostBreakdown: CostBreakdown | null;
}

export interface CostForecast {
  readonly elapsedMs: number;
  readonly spentUsd: number;
  readonly rateUsdPerMs: number;
  readonly forecastEndOfDayUsd: number | null;
  readonly forecastEndOfWeekUsd: number | null;
  readonly forecastSessionEndUsd: number | null;
  readonly confidenceNote: string;
}

export interface CostResponse {
  readonly cost: CostMetrics;
  readonly forecast: CostForecast | null;
  readonly sessionTodayUsd: number | null;
}

export const fetchSessionCurrent = (): Promise<SessionCurrentResponse> =>
  getJson<SessionCurrentResponse>('/api/session/current');
export const fetchSessionToday = (): Promise<unknown> => getJson<unknown>('/api/session/today');
export const fetchSessionsList = (limit = 50): Promise<SessionListEntry[]> =>
  getJson<SessionListEntry[]>(`/api/sessions?limit=${limit}`);
// Cross-session aggregate KPIs for the Today view.
export const fetchTodayAggregate = (): Promise<TodayAggregateResponse> =>
  getJson<TodayAggregateResponse>('/api/sessions/today/aggregate');
// Currently-live session list (for the Today selector to default to the
// most-recently-active session).
export const fetchLiveSessions = (): Promise<LiveSessionEntry[]> =>
  getJson<LiveSessionEntry[]>('/api/sessions/live');
export const fetchSessionDetail = (id: string): Promise<unknown> =>
  getJson<unknown>(`/api/sessions/${encodeURIComponent(id)}`);
export const fetchCost = (): Promise<CostResponse> => getJson<CostResponse>('/api/cost');
export const fetchAntiPatterns = (): Promise<AntiPattern[]> =>
  getJson<AntiPattern[]>('/api/anti-patterns');
export interface QualityEvent {
  readonly signal:
    | 'diff_applied_clean'
    | 'diff_failed'
    | 'test_pass'
    | 'test_fail'
    | 'backtrack'
    | 'self_correction';
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly toolName: string;
}

export interface TurnQualityBucket {
  readonly turnRange: string;
  readonly totalSignals: number;
  readonly positiveSignals: number;
  readonly negativeSignals: number;
  readonly qualityRatio: number | null;
}

export interface QualityProxyMetrics {
  readonly totalSignals: number;
  readonly diffApplyRate: number | null;
  readonly testPassRate: number | null;
  readonly backtrackCount: number;
  readonly selfCorrectionCount: number;
  readonly qualityByTurnBucket: readonly TurnQualityBucket[];
  readonly degradationDetected: boolean;
  readonly events: readonly QualityEvent[];
}

export interface ToolSelectionPenalty {
  readonly callId: string;
  readonly toolName: string;
  readonly reason: 'redundant_read' | 'repeated_failure' | 'unused_output';
  readonly penaltyScore: number;
  readonly detail: string;
}

export interface ToolSelectionMetrics {
  readonly score: number;
  readonly totalCalls: number;
  readonly penalizedCalls: number;
  readonly penalties: readonly ToolSelectionPenalty[];
  readonly worstOffenders: readonly ToolSelectionPenalty[];
  readonly redundantReadCount: number;
  readonly repeatedFailureCount: number;
  readonly unusedOutputCount: number;
}

export const fetchAuditLog = (): Promise<unknown> => getJson<unknown>('/api/audit');
export const fetchWeekly = (): Promise<unknown> => getJson<unknown>('/api/weekly');
export const fetchBudget = (): Promise<unknown> => getJson<unknown>('/api/budget');
export const fetchLatency = (): Promise<LatencyMetrics> => getJson<LatencyMetrics>('/api/latency');
export const fetchCostPerOutcome = (days = 30): Promise<unknown> =>
  getJson<unknown>(`/api/cost-per-outcome?days=${days}`);
export const fetchPersonalCoach = (): Promise<unknown> => getJson<unknown>('/api/personal-coach');
export const fetchRecentAlerts = (): Promise<AlertEvent[]> =>
  getJson<AlertEvent[]>('/api/alerts/recent');
export const fetchSessionReplay = (id: string): Promise<SessionReplayResponse> =>
  getJson<SessionReplayResponse>(`/api/sessions/${encodeURIComponent(id)}/replay`);
export const fetchQualityProxy = (): Promise<QualityProxyMetrics> =>
  getJson<QualityProxyMetrics>('/api/quality-proxy');
export const fetchToolSelectionScore = (): Promise<ToolSelectionMetrics> =>
  getJson<ToolSelectionMetrics>('/api/tool-selection-score');
export const fetchGitEfficiency = (): Promise<unknown> => getJson<unknown>('/api/git-efficiency');
export const fetchGitEfficiencyRepos = (): Promise<unknown> =>
  getJson<unknown>('/api/git-efficiency/repos');

export interface ModelStats {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  readonly avgOutputTokensPerRequest: number | null;
}

export interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null;
  readonly totalModelsUsed: number;
}

export interface CacheHealthResponse {
  readonly status: 'no_cache_activity' | 'needs_attention' | 'can_improve' | 'excellent';
  readonly cache_hit_rate_pct: number | null;
  readonly total_cache_read_tokens: number;
  readonly total_cache_creation_tokens: number;
  readonly total_savings_usd: number;
  readonly week_over_week_delta_pts: number | null;
}

export interface AlertEvent {
  readonly id: string;
  readonly sessionId?: string;
  readonly state: 'firing' | 'cleared';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly threshold: number;
  readonly firedAt: number;
}

export interface ConcurrencyResponse {
  readonly current: number;
  readonly peak: number;
  readonly allTimePeak: number;
  readonly bucketSizeMs: number;
  readonly startTimestamp: number;
  readonly buckets: ReadonlyArray<{ readonly timestamp: number; readonly count: number }>;
}

export interface ActivityHeatmapTodayResponse {
  readonly buckets: number[];
  readonly bucketSizeMs: number;
  readonly startTimestamp: number;
  readonly maxCount: number;
}

export interface ActivityHeatmapHistoryResponse {
  readonly days: ReadonlyArray<{ readonly date: string; readonly count: number }>;
  readonly maxCount: number;
}

export const fetchConcurrency = (): Promise<ConcurrencyResponse> =>
  getJson<ConcurrencyResponse>('/api/concurrency');
export const fetchConcurrencyHistory = (days = 30): Promise<unknown> =>
  getJson<unknown>(`/api/concurrency?view=history&days=${days}`);
export function fetchActivityHeatmap(view: 'today'): Promise<ActivityHeatmapTodayResponse>;
export function fetchActivityHeatmap(
  view: 'history',
  weeks?: number,
): Promise<ActivityHeatmapHistoryResponse>;
export function fetchActivityHeatmap(
  view: string,
  weeks?: number,
): Promise<ActivityHeatmapTodayResponse | ActivityHeatmapHistoryResponse> {
  return getJson<ActivityHeatmapTodayResponse | ActivityHeatmapHistoryResponse>(
    `/api/activity-heatmap?view=${encodeURIComponent(view)}${weeks ? `&weeks=${weeks}` : ''}`,
  );
}
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

export const fetchModelUsage = (): Promise<ModelUsageMetrics> =>
  getJson<ModelUsageMetrics>('/api/model-usage');
export const fetchCacheHealth = (): Promise<CacheHealthResponse> =>
  getJson<CacheHealthResponse>('/api/cache-health');

export const fetchSettings = (): Promise<unknown> => getJson<unknown>('/api/settings');
export const fetchDiagnostics = (): Promise<unknown> => getJson<unknown>('/api/diagnostics');

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
  cacheHealth: ['cache-health'] as const,
  settings: ['settings'] as const,
  // Query keys for live session and today aggregate endpoints
  sessionsLive: ['sessions', 'live'] as const,
  sessionsTodayAggregate: ['sessions', 'today', 'aggregate'] as const,
  diagnostics: ['diagnostics'] as const,
};

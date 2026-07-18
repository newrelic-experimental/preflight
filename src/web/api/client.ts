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
  // Subagent spend rollup, served by the aggregate
  // endpoint. These are the source of truth for the "subagent spend" KPI:
  // the liveStore equivalents (useSubagentStats) are only populated by SSE
  // frames that aren't emitted server-side yet, so they stay 0.
  readonly subagentUsd?: number;
  readonly subagentTurnCount?: number;
  readonly workflowRunCount?: number;
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
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
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
  readonly costPerMillionTokens: number | null;
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
export const fetchSessionsList = (limit = 50): Promise<SessionListEntry[]> =>
  getJson<SessionListEntry[]>(`/api/sessions?limit=${limit}`);
// Cross-session aggregate KPIs for the Today view.
export const fetchTodayAggregate = (): Promise<TodayAggregateResponse> =>
  getJson<TodayAggregateResponse>('/api/sessions/today/aggregate');
// Currently-live session list (for the Today selector to default to the
// most-recently-active session).
export const fetchLiveSessions = (): Promise<LiveSessionEntry[]> =>
  getJson<LiveSessionEntry[]>('/api/sessions/live');
// /api/sessions/:id returns one of three shapes depending on session state:
// a persisted session record, a live session owned by this dashboard's own
// SessionTracker, or a live session tracked by LiveSessionRegistry but owned
// by a different concurrent server (see api-handler.ts's dynamic route
// matcher). All fields below are optional except sessionId, which is the
// only field guaranteed present across all three shapes.
export interface SessionDetail {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly toolCallCount?: number;
  readonly durationMs?: number;
  readonly estimatedCostUsd?: number | null;
  readonly model?: string | null;
  readonly outcome?: string;
  readonly toolBreakdown?: Record<string, number>;
  readonly filesRead?: string[];
  readonly filesModified?: string[];
  readonly antiPatterns?: Array<{ type: string; count: number }>;
  readonly timeline?: ReadonlyArray<ReplayTimelineEntry>;
  readonly qualityProxy?: {
    readonly diffApplyRate: number | null;
    readonly testPassRate: number | null;
    readonly backtrackCount: number;
    readonly selfCorrectionCount: number;
  };
  readonly toolSelectionScore?: {
    readonly score: number;
    readonly redundantReadCount: number;
    readonly repeatedFailureCount: number;
    readonly unusedOutputCount: number;
  };
}

export const fetchSessionDetail = (id: string): Promise<SessionDetail> =>
  getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
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

// Mirrors AuditEntryDto in src/dashboard/routes/api-handler.ts (not importable —
// tsconfig.web.json excludes server source). sessionId is `string | null` at
// runtime (never `undefined`) — the real handler's toAuditEntry() always sets it,
// falling back to null when the underlying audit record has none.
export interface AuditEntry {
  readonly ts: number;
  readonly sessionId: string | null;
  readonly tool: string;
  readonly target: string;
  readonly classification: string;
  readonly severity?: string;
}

export const fetchAuditLog = (): Promise<AuditEntry[]> => getJson<AuditEntry[]>('/api/audit');

// Mirrors WeeklySummary in src/storage/weekly-summary.ts (not importable —
// tsconfig.web.json excludes server source). Only the fields the History
// view actually reads: the real field is `week`, not `weekStart`, and
// `avgEfficiencyScore`, not `efficiencyScore` — neither phantom name exists
// on the real backend response.
export interface WeeklyRow {
  readonly week: string;
  readonly avgEfficiencyScore: number | null;
  readonly totalCostUsd: number;
  readonly antiPatternCounts: Record<string, number>;
}

export const fetchWeekly = (): Promise<WeeklyRow[]> => getJson<WeeklyRow[]>('/api/weekly');

// Mirrors BudgetStatus in src/metrics/budget-tracker.ts (not importable —
// tsconfig.web.json excludes server source). Alerts.tsx never reads
// `remainingUsd`, so it's omitted here to match the one real consumer exactly.
export interface BudgetPeriod {
  readonly budgetUsd: number | null;
  readonly spentUsd: number;
  readonly pctUsed: number | null;
  readonly exceeded: boolean;
}

export interface BudgetAlert {
  readonly period: string;
  readonly thresholdPct: number;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly timestamp: number;
}

export interface BudgetStatus {
  readonly session: BudgetPeriod;
  readonly daily: BudgetPeriod;
  readonly weekly: BudgetPeriod;
  readonly alerts: readonly BudgetAlert[];
}

export const fetchBudget = (): Promise<BudgetStatus> => getJson<BudgetStatus>('/api/budget');
export const fetchLatency = (): Promise<LatencyMetrics> => getJson<LatencyMetrics>('/api/latency');

// Mirrors CostAttribution in src/metrics/cost-per-outcome.ts (not importable).
export interface CostPerOutcomeResponse {
  readonly outcomeDistribution: Record<
    string,
    { readonly count: number; readonly totalCost: number; readonly avgCost: number }
  >;
  readonly wasteRatio: number;
  readonly totalCost: number;
  readonly totalTasks: number;
}

export const fetchCostPerOutcome = (days = 30): Promise<CostPerOutcomeResponse> =>
  getJson<CostPerOutcomeResponse>(`/api/cost-per-outcome?days=${days}`);

// Mirrors the 'ok'/'insufficient_data' union returned by PersonalCoach.generate()
// in src/metrics/personal-coach.ts (not importable).
export interface PersonalCoachReport {
  readonly status: 'ok';
  readonly highlights: readonly string[];
  readonly regressions: readonly string[];
  readonly streaks: readonly string[];
  readonly topRecommendation: string;
}

export interface PersonalCoachInsufficientData {
  readonly status: 'insufficient_data';
  readonly message: string;
}

export type PersonalCoachResult = PersonalCoachReport | PersonalCoachInsufficientData;

export const fetchPersonalCoach = (): Promise<PersonalCoachResult> =>
  getJson<PersonalCoachResult>('/api/personal-coach');
export const fetchRecentAlerts = (): Promise<AlertEvent[]> =>
  getJson<AlertEvent[]>('/api/alerts/recent');
export const fetchSessionReplay = (id: string): Promise<SessionReplayResponse> =>
  getJson<SessionReplayResponse>(`/api/sessions/${encodeURIComponent(id)}/replay`);
// Mirrors GET /api/sessions/:sessionId/subagents `agents[]`. Readonly to
// match the dashboard's immutable-data-shape convention.
export interface AgentSpan {
  readonly agentId: string;
  readonly workflowRunId: string | null;
  readonly workflowName: string | null;
  readonly label: string;
  readonly model: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly usd: number | null;
}

export interface SessionSubagentsResponse {
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly agents: ReadonlyArray<AgentSpan>;
}

// Subagent fan-out timeline for a session, sorted by startMs ASC. Consumed
// by the Sessions detail pane's AgentSwimlanes chart and by SessionTrace.
export const fetchSessionSubagents = (id: string): Promise<SessionSubagentsResponse> =>
  getJson<SessionSubagentsResponse>(`/api/sessions/${encodeURIComponent(id)}/subagents`);

// GET /api/sessions/:id/agents/:agentId/calls → { calls: [...] }. No
// file/command detail in this wire shape (kept lean for the per-agent
// fetch); GanttTimeline tolerates the missing optional fields.
export interface AgentCall {
  readonly toolName: string;
  readonly timestamp: number;
  readonly durationMs: number | null;
  readonly success: boolean;
}

export interface AgentCallsResponse {
  readonly calls: ReadonlyArray<AgentCall>;
}

// ONE subagent's individual tool calls for the attributed session-trace
// view, sorted by timestamp ASC. Lazily fetched when a swimlane row expands.
export const fetchAgentCalls = (sessionId: string, agentId: string): Promise<AgentCallsResponse> =>
  getJson<AgentCallsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/calls`,
  );
export const fetchQualityProxy = (): Promise<QualityProxyMetrics> =>
  getJson<QualityProxyMetrics>('/api/quality-proxy');
export const fetchToolSelectionScore = (): Promise<ToolSelectionMetrics> =>
  getJson<ToolSelectionMetrics>('/api/tool-selection-score');
export interface GitSuggestion {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly category: string;
  readonly message: string;
  readonly evidence: string;
}

export interface MergeConflictRecord {
  readonly timestamp: number;
  readonly resolution: 'resolved' | 'aborted' | 'pending';
  readonly resolutionTimeMs: number | null;
  readonly command: string;
}

export interface GitEvent {
  readonly timestamp: number;
  readonly type: string;
  readonly command?: string;
  readonly success: boolean;
  readonly durationMs: number | null;
}

export interface BestPractice {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'warn' | 'unknown';
  readonly detail: string;
}

export interface RiskIndicators {
  readonly syncedBeforeEditing: boolean | null;
  readonly timeSinceLastSyncMs: number | null;
  readonly commitsSinceLastSync: number;
  readonly pushRejections: number;
  readonly forceAfterReject: number;
  readonly hotFiles: readonly string[];
  readonly usesWorktrees: boolean;
  readonly usesForceWithLease: boolean;
  readonly avgCommitsBetweenSyncs: number | null;
  readonly commitsAheadOfMain: number | null;
  readonly commitsBehindMain: number | null;
  readonly sessionDurationMs: number | null;
  readonly quickConflictResolutions: number;
}

export interface RepoContext {
  readonly repoName: string | null;
  readonly branch: string | null;
  readonly remoteName: string | null;
  readonly defaultBranch: string | null;
}

export interface PrEvent {
  readonly timestamp: number;
  readonly action: 'create' | 'merge' | 'view' | 'edit' | 'ready' | 'checks';
  readonly prNumber: string | null;
}

export interface PullRequestMetrics {
  readonly created: number;
  readonly merged: number;
  readonly checksViewed: number;
  readonly prsUpdated: number;
  readonly prActivity: readonly PrEvent[];
  readonly avgTimeToCreateMs: number | null;
}

export interface VelocityMetrics {
  readonly avgTimeBetweenCommitsMs: number | null;
  readonly commitBurstCount: number;
  readonly longestGapMs: number | null;
  readonly worktreeCount: number;
  readonly buildBeforePush: boolean | null;
  readonly testBeforePush: boolean | null;
}

export interface ConflictResolutionStrategy {
  readonly oursCount: number;
  readonly theirsCount: number;
  readonly manualMergeCount: number;
  readonly cherryPickCount: number;
  readonly totalResolutions: number;
}

// Mirrors GitEfficiencyTracker.getMetrics()'s return shape in
// src/metrics/git-efficiency-tracker.ts (not importable).
export interface GitEfficiencyData {
  readonly totalGitCommands: number;
  readonly mergeConflicts: number;
  readonly rebaseConflicts: number;
  readonly abortedOperations: number;
  readonly forcePushes: number;
  readonly resetHards: number;
  readonly discardedChanges: number;
  readonly pullCount: number;
  readonly pushCount: number;
  readonly commitCount: number;
  readonly branchOperations: number;
  readonly conflictResolutionRate: number | null;
  readonly avgConflictResolutionMs: number | null;
  readonly staleBranchPulls: number;
  readonly gitCommandTimeline: readonly GitEvent[];
  readonly conflictHistory: readonly MergeConflictRecord[];
  readonly suggestions: readonly GitSuggestion[];
  readonly bestPractices: readonly BestPractice[];
  readonly preventionScore: number | null;
  readonly efficiencyScore: number | null;
  readonly riskIndicators: RiskIndicators;
  readonly velocityMetrics: VelocityMetrics;
  readonly conflictResolutionStrategy: ConflictResolutionStrategy;
  readonly prMetrics: PullRequestMetrics;
  readonly repoContext: RepoContext;
}

export const fetchGitEfficiency = (): Promise<GitEfficiencyData> =>
  getJson<GitEfficiencyData>('/api/git-efficiency');

export interface GitEfficiencyReposResponse {
  readonly repos: string[];
  readonly currentRepo: string | null;
}

export const fetchGitEfficiencyRepos = (): Promise<GitEfficiencyReposResponse> =>
  getJson<GitEfficiencyReposResponse>('/api/git-efficiency/repos');

export interface ModelStats {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  readonly costPerMillionTokens: number | null;
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
export interface ConcurrencyHistoryResponse {
  readonly dailyPeaks: ReadonlyArray<{ readonly date: string; readonly peak: number }>;
}

export const fetchConcurrencyHistory = (days = 30): Promise<ConcurrencyHistoryResponse> =>
  getJson<ConcurrencyHistoryResponse>(`/api/concurrency?view=history&days=${days}`);
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
// Mirrors ContextTrackerMetrics in src/metrics/context-tracker.ts (not
// importable — tsconfig.web.json excludes server source). Includes `history`
// for full accuracy even though no current consumer reads it.
export interface ContextBreakdown {
  readonly system: number;
  readonly tools: number;
  readonly user: number;
  readonly assistant: number;
}

export interface ContextGrowthSummary {
  readonly startTokens: number;
  readonly currentTokens: number;
  readonly deltaTokens: number;
}

export interface ToolContextContribution {
  readonly tool: string;
  readonly totalBytes: number;
  readonly estimatedTokens: number;
  readonly percentOfToolOutput: number;
}

export interface ContextTurnSnapshot {
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly fillPercent: number;
  readonly breakdown: ContextBreakdown;
}

export interface ContextResponse {
  readonly turnCount: number;
  readonly growth: ContextGrowthSummary;
  readonly currentBreakdown: ContextBreakdown;
  readonly fillPercent: number;
  /**
   * Per-model context window cap (tokens). Resolved from the model in the
   * Anthropic usage metadata — claude-opus-4-7 → 1_000_000, claude-haiku-4-5 →
   * 200_000, etc. UI formats this as "X / Y" so a 250K Opus session reads as
   * "250K / 1M (25%)" instead of "250K (125%)".
   */
  readonly contextWindow: number;
  readonly toolContributions: readonly ToolContextContribution[];
  readonly history: readonly ContextTurnSnapshot[];
}

export const fetchContext = (sessionId?: string): Promise<ContextResponse> =>
  getJson<ContextResponse>(
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

// Mirrors the real GET /api/settings handler response in
// src/dashboard/routes/api-handler.ts (not importable — tsconfig.web.json
// excludes server source). This is the full superset shape; Settings.tsx and
// Alerts.tsx each keep their own narrower local `SettingsData` interface
// covering only the fields they use — both are structurally assignable from
// this type without a cast, since neither declares a field this type lacks.
export interface SettingsResponse {
  readonly developer: string;
  readonly teamId: string | null;
  readonly accountId: string | null;
  readonly appName: string;
  readonly mode: string;
  readonly storagePath: string;
  readonly highSecurity: boolean;
  readonly licenseKey: string | null;
  readonly sessionBudgetUsd: number | null;
  readonly dailyBudgetUsd: number | null;
  readonly weeklyBudgetUsd: number | null;
  readonly retainSessionsDays: number | null;
  readonly digestWebhookUrl: string | null;
  readonly digestSchedule: string;
  readonly alerts: {
    readonly personal: {
      readonly dailyCostUsd: number;
      readonly sessionCostUsd: number;
      readonly efficiencyScoreMin: number;
      readonly stuckLoopCountMax: number;
      readonly antiPatternCountMax: number;
    };
  };
}

export const fetchSettings = (): Promise<SettingsResponse> =>
  getJson<SettingsResponse>('/api/settings');

// Mirrors the real exported DiagnosticCheck in src/install/diagnostics.ts
// (not importable — tsconfig.web.json excludes server source).
export interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
}

export const fetchDiagnostics = (): Promise<DiagnosticCheck[]> =>
  getJson<DiagnosticCheck[]>('/api/diagnostics');

export interface PatchSettingsResponse {
  readonly ok: boolean;
  readonly restartRequired: boolean;
}

export const patchSettings = (body: SettingsPatch): Promise<PatchSettingsResponse> =>
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as PatchSettingsResponse;
  });

export interface DigestSendResponse {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
}

export const postDigestSend = (): Promise<DigestSendResponse> =>
  fetch('/api/digest/send', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as DigestSendResponse;
  });

export interface ObservabilityHealthResponse {
  readonly watcherActive?: boolean;
  readonly watcherDisabledByLock?: boolean;
  readonly filesWatched?: number;
  readonly parseErrors?: number;
}

export const fetchObservabilityHealth = (): Promise<ObservabilityHealthResponse> =>
  getJson<ObservabilityHealthResponse>('/api/observability-health');
type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

// Mirrors WorkflowRunDto serialized by both GET /api/workflows (list, one
// entry per run) and GET /api/workflows/:runId (detail, as the `run` field).
export interface WorkflowRunInfo {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly taskId: string | null;
  readonly workflowName: string;
  readonly status: WorkflowRunStatus;
  readonly defaultModel: string;
  readonly startedAt?: number | null;
  readonly durationMs?: number | null;
  readonly agentCount?: number | null;
  readonly totalTokens?: number | null;
  readonly totalUsd?: number | null;
  readonly declaredPhases?: number | null;
  readonly observedPhases?: number | null;
  readonly declaredParallelWidths?: ReadonlyArray<number | 'dynamic'> | null;
  readonly tokenReconciliationDelta?: number | null;
  readonly incomplete?: boolean;
  readonly errorReason?: string | null;
  readonly runSource?: string | null;
  readonly scriptPath?: string | null;
  readonly workflowJsonPath?: string | null;
}

// Declared topology parsed from the workflow script (counts only — no
// per-phase timeline exists in the rollup).
export interface WorkflowTopology {
  readonly workflowName?: string | null;
  readonly declaredPhases?: number | null;
  readonly declaredPhaseCalls?: number | null;
  readonly declaredAgents?: number | null;
  readonly declaredParallelWidths?: ReadonlyArray<number | 'dynamic'> | null;
}

// Mirrors WorkflowAgentDto serialized by the /api/workflows/:runId route
// (src/dashboard/routes/api-handler.ts). The on-disk wf_*.json rollup only
// carries an aggregate `tokens` count and `toolCalls` per agent — there is NO
// input/output/cache token split and no per-agent usd.
export interface AgentRow {
  readonly agentId: string;
  readonly label: string;
  readonly phaseIndex: number;
  readonly phaseTitle: string;
  readonly model: string;
  readonly state: string;
  readonly attempt: number;
  readonly durationMs: number | null;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly startedAt: number | null;
}

// Wire shape returned by the detail route: { run, agents, topology }.
export interface WorkflowRunDetailResponse {
  readonly run: WorkflowRunInfo;
  readonly agents: ReadonlyArray<AgentRow>;
  readonly topology: WorkflowTopology | null;
}

// Bare array (not { runs }) — feeds straight into Array.isArray() at call
// sites; a wrapper object would render an empty list.
export const fetchWorkflows = (): Promise<ReadonlyArray<WorkflowRunInfo>> =>
  getJson<ReadonlyArray<WorkflowRunInfo>>('/api/workflows');
export const fetchWorkflowDetail = (runId: string): Promise<WorkflowRunDetailResponse> =>
  getJson<WorkflowRunDetailResponse>(`/api/workflows/${encodeURIComponent(runId)}`);

export const qk = {
  sessionCurrent: ['session', 'current'] as const,
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
  sessionSubagents: (id: string) => ['session', id, 'subagents'] as const,
  agentCalls: (sessionId: string, agentId: string) =>
    ['session', sessionId, 'subagent', agentId, 'calls'] as const,
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
  workflows: ['workflows'] as const,
  workflowDetail: (runId: string) => ['workflow', runId] as const,
  diagnostics: ['diagnostics'] as const,
};

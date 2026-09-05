import { readFileSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServerConfig } from '../../config.js';
import { normalizeDeveloperName, redactSensitive } from '../../config.js';
import {
  isSyntheticSessionId,
  isUnscopedAggregatorSessionId,
  type SessionNameSource,
} from '../../hooks/session-resolver.js';
import {
  localDateKey,
  localStartOfDay,
  todayPortionOfSessionCost,
  todayPortionRatio,
} from '../../lib/date.js';
import type { AntiPattern } from '../../metrics/anti-patterns.js';
import { AntiPatternDetector } from '../../metrics/anti-patterns.js';
import type { ApiFailureMetrics } from '../../metrics/api-failure-tracker.js';
import type { BudgetStatus } from '../../metrics/budget-tracker.js';
import type { ContextCompositionMetrics } from '../../metrics/context-composition-tracker.js';
import type { ContextReplayEvent, ContextTrackerMetrics } from '../../metrics/context-tracker.js';
import { computeContextMetricsFromEvents } from '../../metrics/context-tracker.js';
import type { ContextWindowMetrics } from '../../metrics/context-window-tracker.js';
import type { CostForecast } from '../../metrics/cost-forecast.js';
import { buildCostForecastFromInputs } from '../../metrics/cost-forecast.js';
import {
  attributeSessionCosts,
  type SessionLikeForCostOutcome,
} from '../../metrics/cost-per-outcome.js';
import type { DecisionTreeMetrics } from '../../metrics/decision-tracker.js';
import type { GitEfficiencyMetrics } from '../../metrics/git-efficiency-tracker.js';
import type { InstructionDriftMetrics } from '../../metrics/instruction-drift-tracker.js';
import type { LatencyMetrics } from '../../metrics/latency-tracker.js';
import { DEFAULT_STALE_THRESHOLD_MS } from '../../metrics/live-session-registry.js';
import type { ModelBreakdownEntry, ModelUsageMetrics } from '../../metrics/model-usage-tracker.js';
import type { PersonalInsightsResult } from '../../metrics/personal-coach.js';
import type {
  QualityEvent,
  QualityProxyMetrics,
  QualityProxyRawCounts,
} from '../../metrics/quality-proxy-tracker.js';
import {
  combineQualityProxyRawCounts,
  QualityProxyTracker,
  ZERO_QUALITY_PROXY_COUNTS,
} from '../../metrics/quality-proxy-tracker.js';
import type { Recommendation } from '../../metrics/recommendation-engine.js';
import type { RetryDetectorMetrics, RetrySessionBreakdown } from '../../metrics/retry-detector.js';
import type {
  ToolSelectionMetrics,
  ToolSelectionSummary,
} from '../../metrics/tool-selection-scorer.js';
import { toToolSelectionSummary } from '../../metrics/tool-selection-scorer.js';
import type { CostAttributionMetrics } from '../../metrics/turn-cost-attributor.js';
import type { AuditRecord } from '../../security/audit-trail.js';
import type {
  FullSessionSummary,
  PersistedAntiPattern,
  SessionFileInfo,
} from '../../storage/session-store.js';
import { toPersistedAntiPatterns } from '../../storage/session-store.js';
import type { HookEvent, ReplayTimelineEntry, ToolCallRecord } from '../../storage/types.js';
import type { WeeklySummaryGenerator } from '../../storage/weekly-summary.js';
import { getIsoWeekId } from '../../storage/weekly-summary.js';
import { handleSendDigest } from '../../tools/cross-session-tools.js';
import type { AlertEvent } from '../live-event-bus.js';
import type {
  AgentCall,
  LiveWorkflowRunDetail,
  SubagentTimeline,
} from '../subagent-timeline-store.js';
import type { WorkflowAgentRow, WorkflowRunRow } from '../workflow-store.js';
import type { AggregateCacheHealth, CacheHealthTotals } from './cache-health-aggregate.js';
import { computeCacheHealth } from './cache-health-aggregate.js';
import type { AggregateLatencyMetrics, LatencySample } from './latency-percentiles.js';
import { computeLatencyPercentiles } from './latency-percentiles.js';
import type { AntiPatternSegment } from './replay-analyzer.js';
import { analyzeReplayTimeline } from './replay-analyzer.js';
import { pairToolCallsFromBufferEvents } from './tool-selection-aggregate.js';
interface RawAuditRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly sessionId: string | null;
  readonly action: string;
  readonly tool: string;
  readonly detail: string;
  readonly developer: string;
  readonly filePath?: string;
  readonly command?: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly securityAlert?: { readonly severity: string; readonly alertType: string } | undefined;
}

// Shape consumed by the SPA Audit view. Distinct from RawAuditRecord so that
// (1) field names match the React component (ts/target/classification, not
// timestamp/detail/action), (2) we don't leak filePath/command/developer to
// the browser by accident, and (3) classification surfaces the security
// alertType chip (sensitive_file/destructive_command/external_network)
// directly so the SPA's filter chips work without a second mapping.
interface AuditEntryDto {
  readonly id: string;
  readonly ts: number;
  readonly sessionId: string | null;
  readonly tool: string;
  readonly target: string;
  readonly classification: string;
  readonly severity?: string;
  readonly agentId?: string;
  readonly agentType?: string;
}

function toAuditEntry(entry: unknown): AuditEntryDto {
  const r = (entry ?? {}) as RawAuditRecord;
  const target = typeof r.detail === 'string' ? redactSensitive(r.detail) : '';
  // Prefer the explicit security classification when present; fall back to
  // 'other' for routine tool calls so the "All" filter still shows them
  // while specific filters (sensitive_file/destructive_command/external_network)
  // surface only flagged entries.
  const classification = r.securityAlert?.alertType ?? 'other';
  return {
    id: r.id,
    ts: r.timestamp,
    sessionId: r.sessionId ?? null,
    tool: r.tool,
    target,
    classification,
    severity: r.securityAlert?.severity,
    agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
    agentType: typeof r.agentType === 'string' ? r.agentType : undefined,
  };
}

// Wire shapes consumed by the SPA workflow views. WorkflowStore emits
// snake_case rows (matching the AiWorkflowRun NR event shape); the React
// views (Workflows.tsx, WorkflowRunDetail.tsx, AgentTable.tsx) read camelCase.
// We serialize at the route boundary — same pattern as toAuditEntry above —
// so the views never see snake_case.
interface WorkflowRunDto {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly taskId: string | null;
  readonly workflowName: string;
  readonly status: string;
  readonly errorReason: string | null;
  readonly defaultModel: string;
  readonly startedAt: number;
  /** `null` for an unfinished/killed run — see `WorkflowRunRow.duration_ms`'s docstring. */
  readonly durationMs: number | null;
  readonly agentCount: number;
  readonly totalTokens: number;
  readonly totalUsd: number | null;
  /** Partial mitigation — see `WorkflowRunRow.cost_unknown`'s docstring. */
  readonly costUnknown: boolean;
  readonly declaredPhases: number | null;
  readonly observedPhases: number;
  readonly declaredParallelWidths: ReadonlyArray<number | 'dynamic'>;
  readonly tokenReconciliationDelta: number | null;
  readonly incomplete: boolean;
  readonly runSource: 'script' | 'agent_tool';
  readonly scriptPath: string | null;
  readonly workflowJsonPath: string;
}

// Per-agent rows only carry an aggregate `tokens` count and `toolCalls` in the
// on-disk wf_*.json rollup — there is NO input/output/cache split and no
// per-agent usd. The view renders only what exists rather than padding the
// missing dimensions with misleading zeros.
interface WorkflowAgentDto {
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

function toWorkflowRunDto(row: unknown): WorkflowRunDto {
  const r = (row ?? {}) as WorkflowRunRow;
  return {
    runId: r.workflow_run_id,
    parentSessionId: r.parent_session_id,
    taskId: r.task_id ?? null,
    workflowName: r.workflow_name,
    status: r.status,
    errorReason: r.error_reason ?? null,
    defaultModel: r.default_model,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    agentCount: r.agent_count,
    totalTokens: r.total_tokens,
    totalUsd: r.total_usd ?? null,
    costUnknown: r.cost_unknown ?? false,
    declaredPhases: r.declared_phases ?? null,
    observedPhases: r.observed_phases,
    declaredParallelWidths: r.declared_parallel_widths ?? [],
    tokenReconciliationDelta: r.token_reconciliation_delta,
    incomplete: r.incomplete,
    runSource: r.run_source,
    scriptPath: r.script_path ?? null,
    workflowJsonPath: r.workflow_json_path,
  };
}

function toWorkflowAgentDto(agent: unknown): WorkflowAgentDto {
  const a = (agent ?? {}) as WorkflowAgentRow;
  return {
    agentId: a.agent_id,
    label: a.label,
    phaseIndex: a.phase_index,
    phaseTitle: a.phase_title,
    model: a.model,
    state: a.state,
    attempt: a.attempt,
    durationMs: a.duration_ms ?? null,
    tokens: a.tokens,
    toolCalls: a.tool_calls,
    startedAt: a.started_at ?? null,
  };
}

// Serialize a still-running workflow (assembled from live subagent transcripts,
// no on-disk rollup) into the SAME `{ run, agents, topology }` wire shape the
// completed path emits, so WorkflowRunDetail.tsx renders it unchanged. Fields
// that only exist post-rollup are filled with running-run defaults: status
// 'running', incomplete true, no error/task/reconciliation, and per-agent
// phase/state placeholders (phaseIndex -1, phaseTitle '', state 'running').
function toLiveWorkflowDetail(live: LiveWorkflowRunDetail): {
  run: WorkflowRunDto;
  agents: WorkflowAgentDto[];
  topology: LiveWorkflowRunDetail['topology'];
} {
  const run: WorkflowRunDto = {
    runId: live.runId,
    parentSessionId: live.parentSessionId,
    taskId: null,
    // Fall back to the runId when the script (and thus meta.name) can't be read.
    workflowName: live.workflowName ?? live.runId,
    status: 'running',
    errorReason: null,
    defaultModel: live.defaultModel,
    startedAt: live.startedAt,
    durationMs: live.durationMs,
    agentCount: live.agentCount,
    totalTokens: live.totalTokens,
    totalUsd: live.totalUsd,
    // A still-running workflow's cost comes straight from this process's own
    // live SubagentWatcher state, not a cross-process/restart-vulnerable
    // on-disk rollup — so it's never ambiguous the way a completed run's
    // WorkflowStore-read cost can be.
    costUnknown: false,
    declaredPhases: live.topology?.declaredPhases ?? null,
    // No phase-title telemetry exists mid-run (that comes from the rollup's
    // workflowProgress), so observed phases are unknown → 0.
    observedPhases: 0,
    declaredParallelWidths: live.topology?.declaredParallelWidths ?? [],
    tokenReconciliationDelta: 0,
    incomplete: true,
    // wf_<hex> runIds are script/Workflow-tool orchestrations (agent_tool runs
    // key off toolu_* ids), so this is always a 'script' run.
    runSource: 'script',
    scriptPath: live.scriptPath,
    workflowJsonPath: '',
  };
  const agents: WorkflowAgentDto[] = live.agents.map((a) => ({
    agentId: a.agentId,
    label: a.label,
    phaseIndex: -1,
    phaseTitle: '',
    model: a.model,
    state: 'running',
    attempt: 1,
    durationMs: a.durationMs,
    tokens: a.tokens,
    toolCalls: a.toolCalls,
    startedAt: a.startedAt,
  }));
  return { run, agents, topology: live.topology ?? null };
}

/**
 * Persisted-summary fields that must never reach the dashboard HTTP surface.
 * `sessionIntent` (the first user prompt) is SENSITIVE content — it is captured
 * only under recordContent, redacted, and persisted for the MCP tools + the
 * 0o600 on-disk summary, but the HTTP surface is strictly broader than that
 * file, so every route that returns a persisted summary must drop it. Keep this
 * the single place the exclusion is declared.
 */
const DASHBOARD_OMITTED_SUMMARY_FIELDS: ReadonlySet<string> = new Set(['sessionIntent']);

/**
 * Shallow-copy a persisted session summary for an HTTP response, dropping every
 * field in `DASHBOARD_OMITTED_SUMMARY_FIELDS`. Route all summary-returning
 * dashboard endpoints through this so a content field can never leak by being
 * spread verbatim.
 */
function toDashboardSummary(summary: FullSessionSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(summary)) {
    if (!DASHBOARD_OMITTED_SUMMARY_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

interface LiveSessionMetrics {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly sessionNameSource: SessionNameSource | null;
  readonly sessionStartTime: number;
  readonly sessionDurationMs: number;
  readonly toolCallCount: number;
  readonly toolCallCountByTool: Record<string, number>;
  readonly uniqueFilesRead: number;
  readonly uniqueFilesWritten: number;
  readonly toolCallTimeline: ReadonlyArray<{
    readonly timestamp: number;
    readonly toolName: string;
    readonly durationMs: number | null;
    readonly success: boolean;
  }>;
}

export interface ObservabilityHealthSnapshot {
  readonly watcherActive: boolean;
  readonly filesWatched: number;
  readonly parseErrors: number;
  readonly watcherDisabledByLock: boolean;
  readonly costSelfCheckDeltaPct: number | null;
  /**
   * Why `watcherActive` is false; null when it's true. `activeSubagentWatcher`
   * (src/index.ts) is only non-null when BOTH `subagentWatcherEnabled` (the
   * `NR_AI_ENABLE_SUBAGENT_WATCHER` flag) AND `watcherShouldRun` (this
   * process's mode matches `NR_AI_WATCHER_MODE`, default 'stdio') hold — two
   * unrelated conditions collapsed into one boolean. `'mode_mismatch'` is the
   * common, by-design case for a `--local` dashboard daemon; `'env_var'` is
   * the explicit opt-out. Distinguishing them matters because the UI's
   * `'env_var'` messaging tells the user to unset a variable — which is
   * actively wrong advice when the real cause is `'mode_mismatch'`.
   */
  readonly watcherDisabledReason: 'env_var' | 'mode_mismatch' | null;
  /**
   * True when the Copilot usage watcher is running but found a VS Code
   * workspaceStorage root with no `debug-logs` directory — i.e. the
   * off-by-default `github.copilot.chat.agentDebugLog.fileLogging.enabled`
   * setting is not enabled, so token-exact Copilot cost is unavailable.
   * Optional/absent for non-Copilot deployments and older snapshot producers.
   */
  readonly copilotDebugLoggingDisabled?: boolean;
  /**
   * True when the active platform is the GitHub Copilot SDK/CLI runtime and
   * its optional token-exact-cost extension isn't at its documented install
   * path (~/.copilot/extensions/preflight/extension.mjs) — the extension was
   * likely never copied. Doesn't catch every failure cause (see
   * copilot-sdk-extension-health.ts's doc comment). Optional/absent for
   * non-copilot-sdk deployments and older snapshot producers.
   */
  readonly copilotSdkExtensionMissing?: boolean;
  /**
   * True when the session-level active platform (see
   * `HookEventProcessor.activePlatform`) resolved to `generic-mcp` — the
   * detector found none of the platform-specific env signals it looks for,
   * so tool calls and session summaries are filing under the generic
   * fallback instead of the real host.
   */
  readonly platformDetectionFellBack: boolean;
}

export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => LiveSessionMetrics };
  readonly sessionStore?: {
    loadTodaySessions: () => FullSessionSummary[];
    // Optional: introduced for the cross-midnight cost fix (sessions that
    // started yesterday and ended today need their today-portion summed).
    // Older fakes/mocks that don't implement it fall through to the legacy
    // path which sees only same-day-started sessions.
    loadSessionsOverlappingToday?: () => FullSessionSummary[];
    listSessions: (opts?: { since?: Date; developer?: string }) => SessionFileInfo[];
    loadSession: (id: string) => FullSessionSummary | null;
    loadAllSessions?: (opts?: {
      since?: Date;
      developer?: string;
    }) => readonly SessionLikeForCostOutcome[];
  };
  readonly costTracker?: {
    getMetrics: () => {
      sessionTotalCostUsd?: number | null;
      model?: string | null;
      cacheHitRate?: number | null;
      totalCacheReadTokens?: number;
      totalCacheCreationTokens?: number;
      totalCacheSavingsUsd?: number;
      totalInputTokens?: number;
    };
    // Optional: per-day cost attribution. Fixes the cross-midnight bug where
    // a session that started yesterday counted its full cost as today's. When
    // present, the aggregate route uses it instead of session-total.
    getCostForDay?: (dayKey: string) => number;
    // Today-scoped subagent spend (matches the day-bucketed "spend today"),
    // distinct from getSubagentMetrics().subagentUsd which is session-cumulative.
    getSubagentCostForDay?: (dayKey: string) => number;
    // Per-day first-activity timestamp — mirrors getCostForDay's per-day
    // bucketing. Used by the aggregate route to anchor the cross-process
    // EoD forecast's burn rate without diluting it across idle overnight
    // hours (see CostForecastInputs.dailyFirstActivityMs's docstring).
    getFirstActivityMsForDay?: (dayKey: string) => number | null;
    // Subagent (workflow-attributed) spend share, used for the Today
    // KPI + reconciliation banner.
    getSubagentMetrics?: () => {
      subagentUsd: number;
      parentUsd: number;
      subagentSharePct: number;
      reconciliationDeltaPct: number | null;
    };
    getCostForWorkflowRun?: (runId: string) => number;
  };
  /**
   * Optional reader for the on-disk workflow rollup JSONs and workflow
   * scripts. The dashboard server constructs one from
   * `~/.claude/projects/<slug>/<sessionId>/workflows/` and passes it in.
   * Returns null when the watcher is not enabled.
   */
  readonly workflowStore?: {
    listRuns: (opts?: { since?: number; runSource?: string; status?: string }) => WorkflowRunRow[];
    getRun: (runId: string) => WorkflowRunRow | null;
  };
  /**
   * Optional reader for per-session subagent timeline spans, backing the
   * "agent fan-out" swimlane chart (GET /api/sessions/:sessionId/subagents).
   * The dashboard server constructs a SubagentTimelineStore and passes it in;
   * absent when the watcher / subagent data is not available, in which case
   * the route 503s via the standard `unavailable` path.
   *
   * `getAgentCalls` backs the attributed session-trace view
   * (GET /api/sessions/:sessionId/subagents/:agentId/calls), returning ONE
   * subagent's individual tool calls. Both methods come off the same
   * SubagentTimelineStore instance so the dashboard tree wiring stays a single
   * dep object.
   */
  readonly subagentTimeline?: {
    getSubagentsForSession: (sessionId: string) => SubagentTimeline;
    getAgentCalls: (sessionId: string, agentId: string) => { calls: readonly AgentCall[] };
    /**
     * Live-run fallback for the workflow-detail route: a still-running workflow
     * has no on-disk rollup, so `workflowStore.getRun` returns null; this
     * assembles the detail from the run's live subagent transcripts instead.
     * Optional so older fakes / mocks without it still type-check.
     */
    getRunLive?: (runId: string) => LiveWorkflowRunDetail | null;
  };
  /**
   * Snapshot of latest watcher health frames so the dashboard can render
   * counters without re-reading NR.
   */
  readonly observabilityHealth?: {
    getSnapshot: () => ObservabilityHealthSnapshot;
  };
  readonly costForecast?: () => CostForecast;
  readonly antiPatternDetector?: {
    getCurrentPatterns: () => readonly AntiPattern[];
    getTotalAntiPatternWaste: () => number;
  };
  readonly retryDetector?: { getMetrics: () => RetryDetectorMetrics };
  readonly apiFailureTracker?: { getMetrics: () => ApiFailureMetrics };
  readonly instructionDriftTracker?: { getMetrics: () => InstructionDriftMetrics };
  readonly decisionTracker?: { getMetrics: (sessionId?: string) => DecisionTreeMetrics };
  readonly turnCostAttributor?: { getMetrics: (sessionId?: string) => CostAttributionMetrics };
  readonly auditTrailManager?: { getAuditLog: (limit?: number) => readonly AuditRecord[] };
  readonly weeklySummaryGenerator?: WeeklySummaryGenerator;
  readonly budgetTracker?: { getStatus: () => BudgetStatus };
  readonly latencyTracker?: { getMetrics: () => LatencyMetrics };
  readonly personalCoach?: { generate: () => PersonalInsightsResult };
  readonly trendAnalyzer?: {
    computeTrends: () => {
      weeklyCacheHitRateTrend: ReadonlyArray<{ readonly week: string; readonly value: number }>;
    };
  };
  readonly recommendationEngine?: {
    generateAllRecommendations: (developer: string) => readonly Recommendation[];
  };
  readonly claudeMdTracker?: {
    getChanges: () => readonly {
      timestamp: number;
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted';
      linesAdded: number;
      linesRemoved: number;
    }[];
    computeImpact: (timestamp: number) => {
      beforeMetrics: {
        avgEfficiencyScore: number | null;
        avgCostUsd: number;
        avgCorrectionRate: number;
        sessionCount: number;
      };
      afterMetrics: {
        avgEfficiencyScore: number | null;
        avgCostUsd: number;
        avgCorrectionRate: number;
        sessionCount: number;
      };
      deltas: {
        efficiencyScore: { value: number; percentChange: number | null; improved: boolean } | null;
        cost: { value: number; percentChange: number | null; improved: boolean };
        correctionRate: { value: number; percentChange: number | null; improved: boolean };
      };
      contextTokensForClaudeMd: number | null;
      verdict: string;
    };
  };
  readonly collaborationProfiler?: {
    computeProfile: (developer: string) => {
      classification: string;
      dimensions: {
        specificity: number;
        autonomy: number;
        correctionRate: number;
        taskComplexity: number;
      };
      sessionCount: number;
    };
    compareToTeam: (developer: string) => {
      deltas: {
        specificity: number;
        autonomy: number;
        correctionRate: number;
        taskComplexity: number;
      };
    };
    computeTeamBaseline: () => { developerCount: number };
  };
  readonly alertLog?: { readRecent: (limit: number) => Promise<AlertEvent[]> };
  readonly taskDetector?: {
    getCompletedTasks: () => readonly { toolCalls: readonly ToolCallRecord[] }[];
    getCurrentTask: () => { toolCalls: readonly ToolCallRecord[] } | null;
  };
  // Minimal interface — we only need the rolling session-average score for the
  // Today KPI; richer per-task breakdowns ship via the existing MCP tool path.
  readonly efficiencyScorer?: { getSessionAverage: () => { score: number } | null };
  readonly gitEfficiencyTracker?: { getMetrics: () => GitEfficiencyMetrics };
  readonly qualityProxyTracker?: {
    getMetrics: () => QualityProxyMetrics;
    getRawCounts: () => QualityProxyRawCounts;
  };
  readonly toolSelectionScorer?: {
    scoreSession: (calls: readonly ToolCallRecord[]) => ToolSelectionMetrics;
    combineSummaries: (summaries: readonly ToolSelectionSummary[]) => ToolSelectionMetrics;
  };
  readonly modelUsageTracker?: {
    getMetrics: () => ModelUsageMetrics;
    getRawBreakdown: () => Readonly<Record<string, ModelBreakdownEntry>>;
    combineBreakdowns: (
      breakdowns: ReadonlyArray<Readonly<Record<string, ModelBreakdownEntry>>>,
    ) => ModelUsageMetrics;
  };
  readonly toolCallBuffer?: { getRecords: () => readonly ToolCallRecord[] };
  readonly liveSessionRegistry?: {
    getLiveSessions: () => string[];
    getSessionName: (sessionId: string) => string | null;
    // Optional: introduced for /api/sessions/live so the Today selector can
    // default to the most-recently-active session. Older fakes / mocks that
    // don't implement it still work — `?.` falls back to undefined.
    getLastActivity?: (sessionId: string) => number | null;
    // Optional for the same reason: lets the session-list/detail surfaces
    // report which source produced the name (see SessionNameSource). Callers
    // use `getSessionNameSource?.(id) ?? null` so partial mocks fall back safely.
    getSessionNameSource?: (sessionId: string) => SessionNameSource | null;
  };
  readonly concurrencyTracker?: {
    getConcurrentCount: () => number;
    getPeakConcurrent: () => number;
    getConcurrencyTimeSeries: () => readonly { timestamp: number; count: number }[];
  };
  readonly contextTracker?: { getMetrics: (sessionId?: string) => ContextTrackerMetrics };
  readonly contextCompositionTracker?: { getMetrics: () => ContextCompositionMetrics };
  readonly contextEfficiencyTracker?: { getMetrics: () => ContextWindowMetrics };
  readonly config?: McpServerConfig;
  readonly configFilePath?: string;
  // Resolved lazily (not captured as a plain value) because the platform
  // adapter isn't assigned until after this deps object is constructed —
  // see index.ts's eventProcessor initialization order.
  readonly getActivePlatform?: () => string | undefined;
  // The dashboard owner reads every per-session buffer file in read-only
  // mode for the cross-session aggregate endpoint.
  // `peekAllBuffers()` does NOT drain — only the owning MCP's own
  // `drainBuffer()` consumes events for ingestion.
  readonly localStore?: { peekAllBuffers: () => readonly { readonly [key: string]: unknown }[] };
}

type RouteFn = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function jsonOk(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function unavailable(res: ServerResponse, what: string): void {
  const payload = JSON.stringify({ error: 'unavailable', what });
  res.writeHead(503, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

// Formats RetryDetector's pre-aggregated by-session breakdown (a --local
// dashboard process's single RetryDetector drains every session's buffer,
// see ThrashingAlert's sessionId doc in retry-detector.ts) for the JSON API
// shape this route has always returned. RetryDetector itself owns grouping
// and the 'unknown' sentinel for sessionless alerts now — this is a thin
// shape adapter, not a groupBy.
function retryAlertsBySession(
  bySession: Readonly<Record<string, RetrySessionBreakdown>> | undefined,
): Array<{ session_id: string; tokens_wasted: number; alert_count: number }> {
  return Object.entries(bySession ?? {})
    .map(([session_id, v]) => ({
      session_id,
      tokens_wasted: v.tokensWasted,
      alert_count: v.alertCount,
    }))
    .sort((a, b) => b.tokens_wasted - a.tokens_wasted);
}

const MAX_BODY_BYTES = 64 * 1024; // 64 KB — generous for any settings payload

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const ACTIVITY_WINDOW_MS = 180_000; // 3 minutes — matches LiveSessionRegistry staleness

function mergeActivityWindows(
  timeline: readonly { timestamp: number }[],
): Array<{ start: number; end: number }> {
  const sorted = [...timeline].sort((a, b) => a.timestamp - b.timestamp);
  const windows: Array<{ start: number; end: number }> = [];
  for (const entry of sorted) {
    const start = entry.timestamp;
    const end = start + ACTIVITY_WINDOW_MS;
    if (windows.length > 0 && start <= windows[windows.length - 1]!.end) {
      windows[windows.length - 1]!.end = Math.max(windows[windows.length - 1]!.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

// 96 × 15-minute buckets covering today (00:00 → 24:00 local). Each bucket
// holds the peak concurrent session count observed within its window — see
// computeTodayConcurrencyBuckets() below.
const CONCURRENCY_BUCKET_SIZE_MS = 15 * 60 * 1000;
const CONCURRENCY_BUCKET_COUNT = 96;

interface ConcurrencyBucket {
  readonly timestamp: number;
  readonly count: number;
}

interface SessionInterval {
  readonly startTime: number;
  readonly endTime: number;
}

interface SessionActivityLike {
  readonly timeline?: readonly { readonly timestamp: number }[];
}

interface SessionIdentityLike {
  readonly sessionId?: string;
  readonly toolCallCount?: number;
}

interface ReplaySessionResponse {
  readonly sessionId: string;
  readonly timeline: readonly ReplayTimelineEntry[];
  readonly segments: readonly AntiPatternSegment[];
  readonly worstSegment: AntiPatternSegment | null;
}

interface TodayAggregatePayload {
  readonly toolCallCount: number;
  readonly totalCostUsd: number;
  readonly antiPatternCount: number;
  readonly avgDurationMs: number;
  readonly sessionCount: number;
  readonly sparkline: {
    readonly startTimestamp: number;
    readonly bucketSizeMs: number;
    readonly points: number[];
  };
  readonly subagentUsd: number;
  readonly subagentTurnCount: number;
  readonly workflowRunCount: number;
  readonly latency: AggregateLatencyMetrics;
  readonly cacheHealth: AggregateCacheHealth;
  readonly forecastEndOfDayUsd: number | null;
}

// Build activity windows for every session with activity today, using the SAME
// 3-minute activity-window model as computeTodayPeakConcurrency() (the source of
// the headline `peak`). Each session contributes one or more windows: contiguous
// tool-call activity merges into a single window, while an idle gap longer than
// ACTIVITY_WINDOW_MS splits a session into separate windows.
//
// This is what keeps the chart's tallest column equal to the headline peak. The
// earlier version used whole-session [startTime, endTime] spans (extending live
// sessions to `now`), which counted a long-idle-but-not-yet-ended session as
// continuously concurrent and inflated recent buckets well above the peak — the
// chart could read 7 while the headline read 4.
//
// Activity timestamps per session are unioned from BOTH the persisted timeline
// and the in-memory tool-call buffer (for live sessions whose latest activity
// hasn't been flushed to disk), then merged once per session id so a single
// session can never overlap itself.
function collectTodayActivityWindows(
  todaySessions: readonly FullSessionSummary[],
  liveSessionIds: readonly string[],
  bufferRecords: readonly ToolCallRecord[],
): SessionInterval[] {
  const timestampsById = new Map<string, number[]>();
  const addTimestamps = (id: string, times: readonly number[]): void => {
    const existing = timestampsById.get(id);
    if (existing) existing.push(...times);
    else timestampsById.set(id, [...times]);
  };

  for (const s of todaySessions) {
    if (!s.timeline || s.timeline.length === 0) continue;
    const times = s.timeline.map((t) => t.timestamp);
    // `sessionId` is a required field on FullSessionSummary; the synthetic-key
    // fallback only guards against malformed on-disk JSON (these records are
    // read from disk, not schema-validated).
    const id =
      typeof s.sessionId === 'string' && s.sessionId.length > 0
        ? s.sessionId
        : `__anon_${timestampsById.size}`;
    addTimestamps(id, times);
  }

  // Fold in live sessions' buffered (not-yet-persisted) activity, keyed by the
  // same session id so it merges with the persisted timeline rather than
  // double-counting a session that appears in both.
  if (liveSessionIds.length > 0) {
    const liveSet = new Set(liveSessionIds);
    for (const r of bufferRecords) {
      const sid = (r as { sessionId?: string | null }).sessionId;
      if (!sid || !liveSet.has(sid)) continue;
      const ts = (r as { timestamp?: number }).timestamp ?? 0;
      if (!ts) continue;
      addTimestamps(sid, [ts]);
    }
  }

  const windows: SessionInterval[] = [];
  for (const times of timestampsById.values()) {
    for (const w of mergeActivityWindows(times.map((t) => ({ timestamp: t })))) {
      windows.push({ startTime: w.start, endTime: w.end });
    }
  }

  return windows;
}

function computeTodayConcurrencyBuckets(
  windows: readonly SessionInterval[],
  startTimestamp: number,
): ConcurrencyBucket[] {
  // Single pass O(N log N) — build delta events from every activity window,
  // clamped to today's window, then sort once and sweep across the 96
  // buckets in lockstep with the event cursor. Buckets containing no
  // events still need a count: the value carried over from the previous
  // bucket's tail (a window that spans many buckets without a delta in
  // between must propagate as count=1+ in those buckets).
  const dayEnd = startTimestamp + CONCURRENCY_BUCKET_COUNT * CONCURRENCY_BUCKET_SIZE_MS;
  const events: Array<{ ts: number; delta: number }> = [];
  for (const window of windows) {
    const start = Math.max(window.startTime, startTimestamp);
    const end = Math.min(window.endTime, dayEnd);
    if (start < end) {
      events.push({ ts: start, delta: 1 }, { ts: end, delta: -1 });
    }
  }
  // Sort by ts ascending; at ties, +1 deltas precede -1 (open-before-close)
  // so that exact-touch session boundaries (one ends as another starts)
  // count as overlap for one instant. Matches computeTodayPeakConcurrency's
  // sort and the headline `peak` semantics — without this, a bucket peak
  // can fall 1 below the day peak at boundary conditions.
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);

  const buckets: ConcurrencyBucket[] = new Array(CONCURRENCY_BUCKET_COUNT);
  let current = 0;
  let cursor = 0;
  for (let b = 0; b < CONCURRENCY_BUCKET_COUNT; b++) {
    const bucketStart = startTimestamp + b * CONCURRENCY_BUCKET_SIZE_MS;
    const bucketEnd = bucketStart + CONCURRENCY_BUCKET_SIZE_MS;
    // Peak defaults to the carried-over level so a session spanning many
    // buckets with no events exactly at this boundary propagates as
    // count=N+ here. But if one or more events DO land exactly on
    // bucketStart, that default must be discarded rather than treated as a
    // peak candidate — it reflects state from strictly BEFORE this bucket's
    // range, not a value actually attained within it. (A session closing
    // at exactly t=bucketStart is no longer active as of bucketStart; using
    // the pre-close `current` as this bucket's floor would wrongly count it
    // as still open here.) Once a boundary event fires, peak is instead
    // sampled fresh after each one — same as the mid-bucket sweep below and
    // as computeTodayPeakConcurrency's continuous sweep — so an exact-touch
    // pair (one session's close coinciding with another's open, both at
    // bucketStart) still registers the momentary overlap via the
    // open-before-close tiebreaker, without resurrecting an already-closed
    // session that has no such coincident open.
    let peak = current;
    let flushedAny = false;
    while (cursor < events.length && events[cursor]!.ts <= bucketStart) {
      current += events[cursor]!.delta;
      peak = flushedAny ? Math.max(peak, current) : current;
      flushedAny = true;
      cursor++;
    }
    while (cursor < events.length && events[cursor]!.ts < bucketEnd) {
      current += events[cursor]!.delta;
      if (current > peak) peak = current;
      cursor++;
    }
    buckets[b] = { timestamp: bucketStart, count: peak };
  }
  return buckets;
}

function computeTodayPeakConcurrency(sessions: readonly SessionActivityLike[]): number {
  const events: Array<{ ts: number; delta: number }> = [];
  for (const session of sessions) {
    if (!session.timeline || session.timeline.length === 0) continue;

    const windows = mergeActivityWindows(session.timeline);

    for (const w of windows) {
      events.push({ ts: w.start, delta: 1 }, { ts: w.end, delta: -1 });
    }
  }
  if (events.length === 0) return 0;
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);
  let current = 0;
  let peak = 0;
  for (const e of events) {
    current += e.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

// Mirrors QualityProxyTracker's own getRawCounts()/countBySignal() math, but
// over a caller-filtered event slice — needed so GET /api/quality-proxy can
// day-filter this process's own live contribution (see the startMs pattern
// in GET /api/tool-selection-score) without adding a day-bucketed accessor
// to the tracker itself.
function rawQualityCountsFromEvents(events: readonly QualityEvent[]): QualityProxyRawCounts {
  const count = (signal: QualityEvent['signal']): number =>
    events.filter((e) => e.signal === signal).length;
  return {
    totalSignals: events.length,
    diffApplyCleanCount: count('diff_applied_clean'),
    diffFailCount: count('diff_failed'),
    testPassCount: count('test_pass'),
    testFailCount: count('test_fail'),
    backtrackCount: count('backtrack'),
    selfCorrectionCount: count('self_correction'),
  };
}

function computeDailyPeakConcurrency(
  sessions: readonly SessionActivityLike[],
  days: number,
): Array<{ date: string; peak: number }> {
  // Local (not UTC) day boundaries — see localStartOfDay's doc comment. A
  // developer's evening session commonly straddles UTC midnight, which would
  // otherwise land that activity on the wrong calendar day for anyone not in
  // UTC, and disagree with this same file's local-day `aggregateDailyCost`
  // equivalent on the client (History.tsx).
  const todayStart = localStartOfDay();
  const result: Array<{ date: string; peak: number }> = [];

  for (let d = days - 1; d >= 0; d--) {
    const dayStart = new Date(todayStart);
    dayStart.setDate(dayStart.getDate() - d);
    const dayStartMs = dayStart.getTime();
    // `dayEnd` must be derived via the same local-date arithmetic as
    // `dayStart`, not `dayStartMs + 86_400_000` — a local calendar day is
    // 23h or 25h long on the ~2 DST-transition days/year, so the fixed-ms
    // offset lands an hour into (or short of) the next/previous local day,
    // misattributing entries near the boundary on those days.
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const dayEndMs = dayEnd.getTime();
    const dateKey = localDateKey(dayStartMs);

    // Find sessions that overlap with this day and have timeline data
    const events: Array<{ ts: number; delta: number }> = [];
    for (const session of sessions) {
      if (!session.timeline || session.timeline.length === 0) continue;

      // Only include tool calls within this day
      const dayEntries = session.timeline.filter(
        (e) => e.timestamp >= dayStartMs && e.timestamp < dayEndMs,
      );
      if (dayEntries.length === 0) continue;

      const windows = mergeActivityWindows(dayEntries);

      for (const w of windows) {
        events.push({ ts: w.start, delta: 1 }, { ts: w.end, delta: -1 });
      }
    }

    if (events.length === 0) {
      result.push({ date: dateKey, peak: 0 });
      continue;
    }

    events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);
    let concurrent = 0;
    let peak = 0;
    for (const e of events) {
      concurrent += e.delta;
      if (concurrent > peak) peak = concurrent;
    }
    result.push({ date: dateKey, peak });
  }

  return result;
}

function toolCallToTimelineEntry(tc: ToolCallRecord): ReplayTimelineEntry {
  return {
    timestamp: tc.timestamp,
    toolName: tc.toolName,
    durationMs: tc.durationMs,
    success: tc.success,
    filePath: tc.filePath ? redactSensitive(String(tc.filePath)) : undefined,
    command: tc.command ? redactSensitive(String(tc.command)) : undefined,
    isTestCommand: (tc.isTestCommand as boolean | undefined) || undefined,
    isBuildCommand: (tc.isBuildCommand as boolean | undefined) || undefined,
    isLintCommand: (tc.isLintCommand as boolean | undefined) || undefined,
    errorType: tc.errorType || undefined,
  };
}

function buildReplayResponse(
  sessionId: string,
  deps: ApiHandlerDeps,
): ReplaySessionResponse | null {
  // Try persisted session first
  if (deps.sessionStore) {
    const session = deps.sessionStore.loadSession(sessionId);
    if (session && Array.isArray(session.timeline)) {
      // Redact sensitive fields before sending to the browser
      const timeline = session.timeline.map((e) => ({
        ...e,
        filePath: e.filePath ? redactSensitive(String(e.filePath)) : undefined,
        command: e.command ? redactSensitive(String(e.command)) : undefined,
      }));
      // Persisted timelines are built append-only (session-store.ts iterates
      // tasks and tool calls in array order, not sorted order) — nothing
      // upstream guarantees chronological order. The two fallback branches
      // below already sort before analysis; this main path (every
      // completed/historical session) didn't, so every anti-pattern/segment
      // detector inside analyzeReplayTimeline() silently trusted input order.
      timeline.sort((a, b) => a.timestamp - b.timestamp);
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  // Try live session from TaskDetector — filter to the requested sessionId
  if (deps.taskDetector) {
    const completed = deps.taskDetector.getCompletedTasks();
    const current = deps.taskDetector.getCurrentTask();
    const allCalls: ToolCallRecord[] = [];
    for (const task of completed) {
      allCalls.push(...(task.toolCalls as ToolCallRecord[]));
    }
    if (current) {
      allCalls.push(...(current.toolCalls as ToolCallRecord[]));
    }
    const sessionCalls = allCalls.filter((c) => c.sessionId === sessionId);
    if (sessionCalls.length > 0) {
      sessionCalls.sort((a, b) => a.timestamp - b.timestamp);
      const timeline = sessionCalls.map(toolCallToTimelineEntry);
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  // Final fallback: scan the in-memory tool call buffer for events matching
  // sessionId. TaskDetector only emits records once they're attributed to a
  // task; tool calls that fire before a task starts (or for sessions other
  // than the dashboard owner's) live in the buffer but not in TaskDetector.
  // Today's live tail reads via SSE so it sees these immediately; without
  // this fallback the Sessions detail view shows "No tool calls" for a
  // newly-live session that hasn't yet completed a task.
  if (deps.toolCallBuffer) {
    const records = deps.toolCallBuffer.getRecords();
    const sessionCalls = records.filter(
      (c) => (c as { sessionId?: string | null }).sessionId === sessionId,
    ) as ToolCallRecord[];
    if (sessionCalls.length > 0) {
      sessionCalls.sort((a, b) => a.timestamp - b.timestamp);
      const timeline = sessionCalls.map(toolCallToTimelineEntry);
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  return null;
}

// Unions this process's own LiveSessionRegistry with session IDs seen recently in any
// process's undrained buffer (peekAllBuffers() is read-only and covers every --stdio
// process, not just this one). A session actively running in a different process never
// touches this process's LiveSessionRegistry, so without this union it never shows up as
// "live" to a dashboard served by a different process. "Recently" uses the registry's own
// staleness window so both sources agree on what counts as live.
export function computeCrossProcessLiveSessionIds(deps: ApiHandlerDeps): string[] {
  const ids = new Set<string>(deps.liveSessionRegistry?.getLiveSessions() ?? []);
  const now = Date.now();
  const peeked = deps.localStore?.peekAllBuffers() ?? [];
  for (const ev of peeked) {
    const sid = (ev as { sessionId?: unknown }).sessionId;
    if (typeof sid !== 'string' || sid.length === 0) continue;
    if (isSyntheticSessionId(sid)) continue;
    const ts = (ev as { timestamp?: unknown }).timestamp;
    if (typeof ts !== 'number') continue;
    if (now - ts <= DEFAULT_STALE_THRESHOLD_MS) ids.add(sid);
  }
  return Array.from(ids);
}

// Narrows this MCP's own peekAllBuffers() rows (raw buffer-file lines from
// EVERY --stdio process, read-only) into the two event kinds
// computeContextMetricsFromEvents() understands, scoped to one session.
// Mirrors the mode-based narrowing computeCrossProcessLiveSessionIds() above
// already does — 'post' is a completed tool call, 'token' is a cost/context
// event with no tool-call semantics, 'pre' has neither and is ignored.
export function buildContextReplayEvents(
  peeked: readonly { readonly [key: string]: unknown }[],
  sessionId: string,
): ContextReplayEvent[] {
  const events: ContextReplayEvent[] = [];
  for (const ev of peeked) {
    if (ev.sessionId !== sessionId) continue;
    const timestamp = typeof ev.timestamp === 'number' ? ev.timestamp : null;
    if (timestamp === null) continue;
    if (ev.mode === 'post' && typeof ev.tool === 'string') {
      events.push({
        kind: 'tool',
        timestamp,
        toolName: ev.tool,
        outputSizeBytes: typeof ev.outputSize === 'number' ? ev.outputSize : undefined,
      });
    } else if (ev.mode === 'token') {
      events.push({
        kind: 'token',
        timestamp,
        inputTokens: typeof ev.inputTokens === 'number' ? ev.inputTokens : 0,
        outputTokens: typeof ev.outputTokens === 'number' ? ev.outputTokens : 0,
        cacheReadTokens: typeof ev.cacheReadTokens === 'number' ? ev.cacheReadTokens : 0,
        cacheCreationTokens:
          typeof ev.cacheCreationTokens === 'number' ? ev.cacheCreationTokens : 0,
        model: typeof ev.model === 'string' ? ev.model : 'unknown',
      });
    }
  }
  return events;
}

export function createApiHandler(
  deps: ApiHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    // surface the rolling efficiency score as a sibling field so the
    // SPA Today KPI can render it without a second round-trip. `null` when
    // no tasks have been scored yet (or when the scorer wasn't wired in).
    const efficiencyScore = deps.efficiencyScorer?.getSessionAverage()?.score ?? null;
    const liveSessions = computeCrossProcessLiveSessionIds(deps);
    // getMetrics() returns the full SessionMetrics at runtime (LiveSessionMetrics
    // is a curated subset type). session_intent (the first prompt) is SENSITIVE
    // content and is deliberately NOT exposed on the dashboard HTTP surface — it
    // lives only on the MCP tool responses and persisted summaries (both
    // redacted). Strip it from the shallow copy before spreading it into the
    // response rather than emitting the whole metrics object verbatim.
    const { sessionIntent, ...metricsForResponse } =
      deps.sessionTracker.getMetrics() as LiveSessionMetrics & { sessionIntent?: unknown };
    void sessionIntent;
    jsonOk(res, { ...metricsForResponse, efficiencyScore, liveSessions });
  });

  routes.set('GET /api/session/today', (_req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    jsonOk(res, deps.sessionStore.loadTodaySessions().map(toDashboardSummary));
  });

  routes.set('GET /api/sessions', (req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitStr = url.searchParams.get('limit') ?? '';
    let limit = 50;
    const parsed = parseInt(limitStr, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.min(Math.max(parsed, 1), 500);
    }
    const allSessions = deps.sessionStore.loadAllSessions
      ? deps.sessionStore.loadAllSessions()
      : deps.sessionStore.listSessions();
    // `allSessions` comes from SessionStore.loadAllSessions(), which already
    // excludes synthetic IDs (`local-<ts>`, `proxy-<ts>`, `pending-<ts>`) —
    // MCP-internal bookkeeping from --local / proxy modes that would
    // otherwise appear as confusing "duplicate" rows next to real Claude
    // Code sessions.
    const withActivity = (allSessions as readonly SessionIdentityLike[]).filter((s) => {
      const calls = s.toolCallCount ?? 0;
      return calls > 0;
    });
    const sliced = withActivity.slice(-limit);

    // Append the current live session so it appears in the list before
    // shutdown. Unlike `allSessions` above, `live.sessionId` comes straight
    // from this process's own SessionTracker, not SessionStore or
    // LiveSessionRegistry — there's no shared producer boundary to push this
    // check into, since --local / proxy mode's own session ID is synthetic
    // for its entire lifetime and SessionTracker must keep reporting it
    // unfiltered (persistSession() in src/index.ts depends on the real,
    // unfiltered ID to decide whether to skip persisting). So this filter
    // stays here.
    if (deps.sessionTracker) {
      const live = deps.sessionTracker.getMetrics();
      const alreadyPersisted = sliced.some(
        (s) => (s as { sessionId?: string }).sessionId === live.sessionId,
      );
      if (!alreadyPersisted && live.toolCallCount > 0 && !isSyntheticSessionId(live.sessionId)) {
        sliced.push({
          sessionId: live.sessionId,
          sessionName: live.sessionName ?? null,
          sessionNameSource: live.sessionNameSource ?? null,
          startTime: live.sessionStartTime,
          durationMs: live.sessionDurationMs,
          toolCallCount: live.toolCallCount,
          estimatedCostUsd: deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null,
          // costTracker.getMetrics() also exposes the model this live
          // session is actually using; without it, aggregateModelPerformance
          // (History.tsx) buckets this session's real-time cost/count under
          // "unknown" until the session is persisted and rebuilt with a
          // real `model` field.
          model: deps.costTracker?.getMetrics().model ?? null,
        } as SessionIdentityLike);
      }
    }

    // Inject stub entries for live sessions not yet persisted to disk.
    // Derive toolCallCount and startTime from the in-memory tool call buffer
    // so concurrent sessions show real activity counts on the badges.
    if (deps.liveSessionRegistry) {
      const knownIds = new Set(sliced.map((s) => (s as { sessionId?: string }).sessionId));
      const records = deps.toolCallBuffer?.getRecords() ?? [];
      const perSession = new Map<string, { count: number; firstTs: number; lastTs: number }>();
      for (const r of records) {
        const sid = (r as { sessionId?: string | null }).sessionId;
        if (!sid) continue;
        const ts = (r as { timestamp?: number }).timestamp ?? 0;
        const entry = perSession.get(sid);
        if (entry) {
          entry.count++;
          if (ts && ts < entry.firstTs) entry.firstTs = ts;
          if (ts && ts > entry.lastTs) entry.lastTs = ts;
        } else {
          perSession.set(sid, { count: 1, firstTs: ts || Date.now(), lastTs: ts || Date.now() });
        }
      }
      for (const id of computeCrossProcessLiveSessionIds(deps)) {
        if (!knownIds.has(id)) {
          const stats = perSession.get(id);
          // getLastActivity is registry-maintained and survives buffer drains,
          // so use it as the stable upper bound for durationMs. Without this,
          // durationMs collapses to 0 every 5s when the harvest scheduler drains
          // the buffer and perSession rebuilds from an empty set of records.
          const lastActivityTs = deps.liveSessionRegistry.getLastActivity?.(id) ?? stats?.lastTs;
          const sessionStart = stats?.firstTs ?? lastActivityTs ?? Date.now();
          sliced.push({
            sessionId: id,
            sessionName: deps.liveSessionRegistry.getSessionName(id),
            sessionNameSource: deps.liveSessionRegistry.getSessionNameSource?.(id) ?? null,
            startTime: sessionStart,
            durationMs: lastActivityTs != null ? Math.max(0, lastActivityTs - sessionStart) : 0,
            toolCallCount: stats?.count ?? 0,
            estimatedCostUsd: null,
          } as SessionIdentityLike);
        }
      }
    }

    // Strip heavy per-session fields the list view doesn't render. Without
    // this, /api/sessions returns ~90KB per session × N sessions; first
    // paint blocks on parsing 200KB+ of JSON the list never reads.
    // The detail endpoint /api/sessions/:id returns the full session.
    const HEAVY_FIELDS = new Set(['timeline', 'filesRead', 'filesModified']);
    const slimmed = sliced.map((s) => {
      const o = s as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) {
        // Drop heavy fields the list view never renders AND sensitive content
        // fields (session_intent) that must not reach the HTTP surface.
        if (!HEAVY_FIELDS.has(k) && !DASHBOARD_OMITTED_SUMMARY_FIELDS.has(k)) out[k] = o[k];
      }
      return out;
    });
    jsonOk(res, slimmed.length > limit ? slimmed.slice(-limit) : slimmed);
  });

  // Currently-live session list with metadata. Sourced from LiveSessionRegistry
  // (touch-based liveness within a 3-minute window) so the Today selector can
  // default to the most-recently-active session even when nothing has been
  // persisted to disk yet. The dashboard owner sees every live session — the
  // registry is in-memory and shared via this MCP, so the data is one
  // authoritative read.
  //
  // Falls back to the in-memory tool call buffer for `startTime` (oldest
  // observed timestamp for that session) since the registry only tracks
  // last-activity. When a session's first event hasn't reached the buffer
  // yet, startTime defaults to lastActivity (or now() if both are missing).
  routes.set('GET /api/sessions/live', (_req, res) => {
    if (!deps.liveSessionRegistry) return unavailable(res, 'liveSessionRegistry');
    // computeCrossProcessLiveSessionIds() unions the registry and buffer-derived
    // session IDs, filtering out synthetic session identities (`local-<ts>`,
    // `proxy-<ts>`, `pending-<ts>`) — MCP-internal bookkeeping IDs, not real
    // Claude Code sessions, so they shouldn't appear as clickable rows in the
    // dashboard's live-sessions selector.
    const ids = computeCrossProcessLiveSessionIds(deps);
    const records = deps.toolCallBuffer?.getRecords() ?? [];
    const perSession = new Map<string, { firstTs: number; lastTs: number }>();
    for (const r of records) {
      const sid = (r as { sessionId?: string | null }).sessionId;
      if (!sid) continue;
      const ts = (r as { timestamp?: number }).timestamp ?? 0;
      if (!ts) continue;
      const entry = perSession.get(sid);
      if (entry) {
        if (ts < entry.firstTs) entry.firstTs = ts;
        if (ts > entry.lastTs) entry.lastTs = ts;
      } else {
        perSession.set(sid, { firstTs: ts, lastTs: ts });
      }
    }
    const sessions = ids.map((id) => {
      const stats = perSession.get(id);
      const lastActivity =
        deps.liveSessionRegistry?.getLastActivity?.(id) ?? stats?.lastTs ?? Date.now();
      return {
        sessionId: id,
        sessionName: deps.liveSessionRegistry?.getSessionName(id) ?? null,
        sessionNameSource: deps.liveSessionRegistry?.getSessionNameSource?.(id) ?? null,
        startTime: stats?.firstTs ?? lastActivity,
        lastActivity,
      };
    });
    // Most-recently-active first so the Today selector can default to
    // sessions[0] without re-sorting on the client.
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    jsonOk(res, sessions);
  });

  // Cross-session aggregate KPIs for the Today view. Reads:
  //   1. every per-session buffer-*.jsonl in read-only mode (each MCP only
  //      drains its own; the dashboard owner needs the union)
  //   2. completed session JSONs at ~/.newrelic-preflight/sessions/ (loaded via
  //      sessionStore.loadTodaySessions())
  //   3. the in-memory tool call buffer (events from this MCP that have
  //      already been processed but not yet persisted)
  //
  // The minute-bucketed sparkline starts at 00:00 local and runs through
  // the current minute. Aggregate `avgDurationMs` is the simple mean over
  // every observed durationMs across all three sources.
  //
  // Caching: dashboards poll this endpoint every 5–10s; both reads (peek
  // every buffer-*.jsonl + load every today-session JSON) hit disk and
  // walk the full result. Cache the response in a 5-second bucket so a
  // single tab burst plus a couple of mirror tabs collapses to one
  // computation per bucket. TTL is short enough that the live-feel KPI
  // (sparkline tail, tool-call count) lags by at most ~5s.
  const AGGREGATE_TTL_MS = 5_000;
  // Cap on latency samples collected per aggregate computation — bounds
  // response size and per-request CPU on a very busy day. Matches the
  // MAX_OVERALL_SAMPLES cap LatencyTracker itself already uses per-process.
  const MAX_AGGREGATE_LATENCY_SAMPLES = 5_000;
  let aggregateCache: { bucket: number; payload: TodayAggregatePayload } | null = null;

  // Extracted so GET /api/cache-health can read the same today-scoped
  // cacheHitRatePct this computes, instead of falling back to CostTracker's
  // lifetime cumulative rate — the two would otherwise disagree on scope.
  function computeTodayAggregatePayload(now: number): TodayAggregatePayload {
    const startMs = localStartOfDay(now);
    const minuteBuckets = Math.max(1, Math.ceil((now - startMs) / 60_000));
    const sparkline = new Array<number>(minuteBuckets).fill(0);

    let toolCallCount = 0;
    let totalDurationMs = 0;
    let durationSamples = 0;
    let totalCostUsd = 0;
    // Summed across every today session's PERSISTED subagentCostUsd (see (2b)
    // below), not read from this one process's live CostTracker. A session
    // watched by a different concurrent `--stdio` process never touches this
    // process's in-memory tracker, so reading only the live tracker silently
    // dropped subagent spend from every other concurrently-running session.
    let subagentUsd = 0;
    let antiPatternCount = 0;
    const sessionsSeen = new Set<string>();
    const latencySamples: LatencySample[] = [];
    const pushLatencySample = (sample: LatencySample): void => {
      if (latencySamples.length < MAX_AGGREGATE_LATENCY_SAMPLES) latencySamples.push(sample);
    };
    let cacheReadTokensSum = 0;
    let cacheCreationTokensSum = 0;
    let cacheInputTokensSum = 0;
    let cacheSavingsUsdSum = 0;
    // Earliest today-scoped activity across every process/session, used to
    // anchor the cross-process EoD forecast's burn rate. null means no
    // activity has been observed today from any source below.
    let dailyFirstActivityMs: number | null = null;

    // (1) live, undrained per-session buffer events
    const peeked = deps.localStore?.peekAllBuffers() ?? [];
    // Per-live-session earliest buffer timestamp (today only). Used as a
    // cutoff against the persisted timeline below: persisted timeline
    // entries strictly OLDER than the buffer's earliest event for the same
    // sessionId are pre-resume (drained before persistence and replayed via
    // saved JSON); entries at-or-after that cutoff are live buffer events
    // we already counted in step (1) and must not double-count.
    //
    // In practice the resume-after-shutdown flow doesn't keep the buffer
    // alive across restarts (each MCP starts fresh), so this dedup is a
    // belt-and-suspenders safety net rather than a load-bearing invariant.
    const bufferStartBySession = new Map<string, number>();
    for (const ev of peeked) {
      const ts = typeof ev.timestamp === 'number' ? ev.timestamp : 0;
      if (ts < startMs) continue;
      if (dailyFirstActivityMs === null || ts < dailyFirstActivityMs) dailyFirstActivityMs = ts;
      const sid = ev.sessionId;
      if (typeof sid === 'string' && sid.length > 0) {
        sessionsSeen.add(sid);
        const prev = bufferStartBySession.get(sid);
        if (prev === undefined || ts < prev) bufferStartBySession.set(sid, ts);
      }
      // Hook events come through as either `pre`/`post`/`token`. We only
      // count `post` events as completed tool calls — `pre` is the start
      // marker and `token` is a cost event with no tool-call semantics.
      if (ev.mode === 'post') {
        toolCallCount++;
        const idx = Math.floor((ts - startMs) / 60_000);
        if (idx >= 0 && idx < sparkline.length) sparkline[idx]++;
        const dur = typeof ev.durationMs === 'number' ? ev.durationMs : null;
        if (dur !== null) {
          totalDurationMs += dur;
          durationSamples++;
          pushLatencySample({
            durationMs: dur,
            toolName: typeof ev.tool === 'string' ? ev.tool : 'Unknown',
          });
        }
      } else if (ev.mode === 'token') {
        cacheReadTokensSum += typeof ev.cacheReadTokens === 'number' ? ev.cacheReadTokens : 0;
        cacheCreationTokensSum +=
          typeof ev.cacheCreationTokens === 'number' ? ev.cacheCreationTokens : 0;
        cacheInputTokensSum += typeof ev.inputTokens === 'number' ? ev.inputTokens : 0;
      }
    }

    // Hoist the live-session set out of the inner loop so we don't pay
    // O(timeline × liveSessions) lookups per aggregate request.
    const liveSet = new Set<string>(deps.liveSessionRegistry?.getLiveSessions() ?? []);

    // (2) completed sessions persisted today
    const todaySessions = deps.sessionStore?.loadTodaySessions() ?? [];
    for (const raw of todaySessions) {
      const session = raw as {
        sessionId?: string;
        toolCallCount?: number;
        estimatedCostUsd?: number | null;
        antiPatterns?: ReadonlyArray<unknown>;
        timeline?: ReadonlyArray<{
          timestamp: number;
          durationMs: number | null;
          toolName: string;
        }>;
      };
      if (typeof session.sessionId === 'string') sessionsSeen.add(session.sessionId);
      // Cost is summed in a separate pass below so cross-midnight sessions
      // (loaded via loadSessionsOverlappingToday) contribute their today
      // portion only. See "(2b) cost from sessions overlapping today" below.
      antiPatternCount += session.antiPatterns?.length ?? 0;

      // Walk timeline entries within today. Persisted timelines and the
      // buffer cover disjoint time ranges by construction (persistence
      // runs at shutdown, after all events have been processed; buffer
      // contents are undrained events). Even in the resume-after-shutdown
      // case, the persisted JSON holds pre-shutdown events while the
      // buffer holds post-resume events — disjoint timestamps. Use a
      // per-session timestamp cutoff (earliest buffer event for that
      // sessionId) as a defensive dedup so we never double-count if the
      // ranges ever DO overlap.
      if (session.timeline) {
        const sid = session.sessionId ?? '';
        const bufferCutoff = liveSet.has(sid) ? bufferStartBySession.get(sid) : undefined;
        for (const entry of session.timeline) {
          if (entry.timestamp < startMs) continue;
          if (bufferCutoff !== undefined && entry.timestamp >= bufferCutoff) continue;
          if (dailyFirstActivityMs === null || entry.timestamp < dailyFirstActivityMs) {
            dailyFirstActivityMs = entry.timestamp;
          }
          toolCallCount++;
          const idx = Math.floor((entry.timestamp - startMs) / 60_000);
          if (idx >= 0 && idx < sparkline.length) sparkline[idx]++;
          if (entry.durationMs !== null) {
            totalDurationMs += entry.durationMs;
            durationSamples++;
            pushLatencySample({ durationMs: entry.durationMs, toolName: entry.toolName });
          }
        }
      }
    }

    // (2b) cost from sessions overlapping today (separate pass so cross-
    // midnight sessions started yesterday but ending after midnight contribute
    // their today portion to spend, while NOT inflating tool-call or
    // anti-pattern counts above which are already today-bounded by timeline).
    //
    // Why a separate loader: loadTodaySessions() filters by file-name date
    // (= start date), so it drops sessions that started yesterday and ended
    // today. The cost path needs them; the tool-call path doesn't (its
    // timeline filter would skip pre-midnight entries anyway).
    const liveSid = deps.sessionTracker?.getMetrics().sessionId;
    // Prefer overlapping-today loader (catches yesterday→today sessions).
    // When the store doesn't implement it (older tests/fakes), reuse the
    // already-loaded `todaySessions` rather than re-invoking
    // loadTodaySessions — keeps disk reads at one per request and preserves
    // the cache-hit assertions in api-handler.test.ts.
    const overlappingTodaySessions =
      deps.sessionStore?.loadSessionsOverlappingToday?.() ?? todaySessions;
    // Local-day key for "today", shared by the persisted-session loop below and
    // the live top-up further down. Sessions persisted with per-day cost buckets
    // (costByDayUsd) let us sum a session's REAL today-spend instead of
    // pro-rating its lifetime estimatedCostUsd by a timeline.
    const todayKey = localDateKey(now);
    for (const raw of overlappingTodaySessions) {
      const s = raw as {
        sessionId?: string;
        startTime: number;
        endTime: number;
        estimatedCostUsd: number | null;
        subagentCostUsd?: number;
        costByDayUsd?: Record<string, number>;
        subagentCostByDayUsd?: Record<string, number>;
        toolCallCount?: number;
        tokensInput?: number;
        tokensCacheRead?: number;
        tokensCacheCreation?: number;
        cacheSavingsUsd?: number;
        antiPatterns?: ReadonlyArray<unknown>;
        timeline?: ReadonlyArray<{ timestamp: number }>;
      };
      // Skip the live session here — its today-portion is added below from
      // costTracker.getCostForDay()/getSubagentCostForDay(), which is more
      // accurate (per-token-event) than pro-rating from a periodically-
      // persisted snapshot.
      if (s.sessionId === liveSid) continue;
      // Cross-midnight sessions that started before today aren't covered by
      // the todaySessions timeline walk above (loadTodaySessions() filters
      // by file-date = start date, so a session that started yesterday never
      // appears there). Derive its first-today activity from its OWN
      // timeline, not `s.startTime` — using startTime here would reintroduce
      // the exact dilution bug dailyFirstActivityMs exists to avoid.
      if (s.startTime < startMs && Array.isArray(s.timeline)) {
        for (const entry of s.timeline) {
          if (entry.timestamp < startMs) continue;
          if (dailyFirstActivityMs === null || entry.timestamp < dailyFirstActivityMs) {
            dailyFirstActivityMs = entry.timestamp;
          }
        }
      }
      // Cost attributed to TODAY. Prefer the session's persisted per-day
      // bucket — authoritative, since each token event was bucketed by its real
      // transcript timestamp. For older session files without buckets, fall back to
      // pro-rating the lifetime estimatedCostUsd by the timeline — EXCEPT a
      // session with cost but ZERO attributable activity (no tool calls AND no
      // subagent spend) is an unverifiable re-read artifact: its
      // estimatedCostUsd is a cumulative lifetime total that may include a
      // resumed transcript's month of cache-read tokens re-read in one pass, and
      // todayPortionRatio returns 1.0 for its entirely-today window, dumping the
      // whole total onto today (the observed $248/$863 phantoms, which had
      // toolCallCount 0 and subagentCostUsd 0). Bias toward trust and contribute
      // 0; the real per-day figure is recovered once the session re-persists
      // WITH day buckets. Note: an EMPTY timeline alone is NOT the signal — a
      // legitimate subagent-only session has an empty PARENT timeline (subagent
      // tool calls are not in it) yet real subagentCostUsd, so the guard keys on
      // subagent spend too, never zeroing genuine cross-session subagent work.
      const hasNoAttributableActivity =
        (s.toolCallCount ?? 0) === 0 &&
        (s.subagentCostUsd ?? 0) === 0 &&
        !(Array.isArray(s.timeline) && s.timeline.length > 0);
      const ratio = todayPortionRatio(s, now);
      totalCostUsd +=
        s.costByDayUsd !== undefined
          ? (s.costByDayUsd[todayKey] ?? 0)
          : hasNoAttributableActivity
            ? 0
            : todayPortionOfSessionCost(s, now);
      // (2b) subagent-only portion of the same session. Day-bucket-first, else
      // pro-rate — applying the same phantom guard explicitly rather than
      // relying on hasNoAttributableActivity's subagentCostUsd===0 term to
      // zero this out implicitly (that held today, but shouldn't be a silent
      // invariant across two separate expressions). This is what makes the
      // KPI cross-session: each `--stdio` process persists its own subagent
      // cost, so summing it here (rather than reading only THIS process's
      // live CostTracker) picks up subagent activity from any concurrent
      // session.
      subagentUsd +=
        s.subagentCostByDayUsd !== undefined
          ? (s.subagentCostByDayUsd[todayKey] ?? 0)
          : hasNoAttributableActivity
            ? 0
            : (s.subagentCostUsd ?? 0) * ratio;
      // Cache token/dollar sums below carry the same unguarded overlap
      // characteristic subagentUsd/totalCostUsd already have on this line:
      // a session that's concurrently live in ANOTHER process (so
      // peekAllBuffers() — which spans every process's buffer files, not
      // just this one — sees its undrained 'token' tail in step (1)) AND
      // has a periodic persisted checkpoint picked up here has no
      // timestamp-based cutoff between the two sources, unlike the
      // toolCallCount/latency path above (which has bufferStartBySession
      // for exactly this reason). Adding one here would fix cache alone
      // while leaving the pre-existing cost/subagentUsd sums on this same
      // line unprotected — an inconsistent, ticket-scope-creeping fix — so
      // this intentionally matches the accepted risk already present for
      // cost/subagentUsd rather than introducing a new, metric-specific
      // guard.
      cacheReadTokensSum += (s.tokensCacheRead ?? 0) * ratio;
      cacheCreationTokensSum += (s.tokensCacheCreation ?? 0) * ratio;
      cacheInputTokensSum += (s.tokensInput ?? 0) * ratio;
      cacheSavingsUsdSum += (s.cacheSavingsUsd ?? 0) * ratio;
      // Count anti-patterns and session for cross-midnight sessions not already
      // captured by the todaySessions loop (which filtered by start-date).
      if (typeof s.sessionId === 'string' && !sessionsSeen.has(s.sessionId)) {
        sessionsSeen.add(s.sessionId);
        antiPatternCount += s.antiPatterns?.length ?? 0;
      }
    }

    // (3) include this MCP's live session today-portion. Per-day attribution
    // comes from CostTracker, which buckets each token event by local-day at
    // record time (see CostTracker.accumulateTokens). Falls back to session
    // total if no per-day data is available (older deployments / first event).
    const liveAlreadyPersisted = todaySessions.some(
      (s) => (s as { sessionId?: string }).sessionId === liveSid,
    );

    // An unscoped aggregator (--local/proxy session id) runs its
    // SubagentWatcher unscoped — its own live CostTracker may already hold
    // cost belonging to OTHER, already-separately-persisted sessions (see
    // isUnscopedAggregatorSessionId's docstring). Adding it here on top of
    // the persisted-sessions sum above would double-count that cost, so skip
    // the live top-up entirely for such a process — unlike a genuine
    // `--stdio` session (including one still on a pending-* provisional id),
    // whose live cost really is exclusively its own.
    const liveIsUnscopedAggregator = isUnscopedAggregatorSessionId(liveSid);

    if (!liveAlreadyPersisted && !liveIsUnscopedAggregator) {
      // Reuses `todayKey` from the enclosing scope (declared above the
      // persisted-session loop) so the persisted-loop and this live top-up can
      // never split onto two independently-derived day keys.
      const liveTodayUsd = deps.costTracker?.getCostForDay?.(todayKey) ?? null;
      if (typeof liveTodayUsd === 'number') {
        totalCostUsd += liveTodayUsd;
      } else {
        // Fallback for older deployments without the per-day API. NEVER add the
        // full session total here: a session that began before midnight would
        // inflate "spend today" by its entire multi-day cost (observed up to
        // ~4.3x over-counts). Without per-day buckets we cannot pro-rate, so we
        // only attribute a session that actually started today; a cross-midnight
        // session is omitted (a bounded undercount) rather than over-counted.
        const sessionCost = deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null;
        const startedTs = deps.sessionTracker?.getMetrics().sessionStartTime ?? null;
        const startedToday = typeof startedTs === 'number' && localDateKey(startedTs) === todayKey;
        if (typeof sessionCost === 'number' && startedToday) {
          totalCostUsd += sessionCost;
        }
      }
      // This process's own first-activity-today, covering the gap between
      // "drained from the buffer" and "persisted to a session file" — the
      // same gap liveTodayUsd above already covers for cost.
      const liveFirstActivityMs = deps.costTracker?.getFirstActivityMsForDay?.(todayKey) ?? null;
      if (typeof liveFirstActivityMs === 'number') {
        if (dailyFirstActivityMs === null || liveFirstActivityMs < dailyFirstActivityMs) {
          dailyFirstActivityMs = liveFirstActivityMs;
        }
      }
      // This MCP's own live subagent-for-day figure — the (2b) loop above
      // already summed every OTHER today session's persisted subagentCostUsd;
      // this process's own session isn't in that persisted set yet, so its
      // contribution comes from the live, per-day-bucketed CostTracker value
      // instead (same reasoning as liveTodayUsd above).
      subagentUsd += deps.costTracker?.getSubagentCostForDay?.(todayKey) ?? 0;
      // Cache top-up (dollars AND token counts) for this process's own live,
      // not-yet-persisted session. These are session-cumulative totals with
      // no per-day equivalent (unlike getCostForDay above), so — mirroring
      // the startedToday guard the cost fallback above needs for the exact
      // same reason — only add them when this live session actually started
      // today; a cross-midnight live session's cumulative totals would
      // otherwise leak yesterday's activity in too. Token counts must be
      // topped up alongside the dollar figure: step (1)'s buffer union only
      // sees the last undrained tail since the previous periodic checkpoint,
      // so without this, totalSavingsUsd could reflect a session's full
      // accumulated savings while totalCacheReadTokens/cacheHitRatePct/status
      // reflected almost none of the activity that produced them.
      const liveStartedTs = deps.sessionTracker?.getMetrics().sessionStartTime ?? null;
      if (typeof liveStartedTs === 'number' && localDateKey(liveStartedTs) === todayKey) {
        const liveCostMetrics = deps.costTracker?.getMetrics();
        cacheSavingsUsdSum += liveCostMetrics?.totalCacheSavingsUsd ?? 0;
        cacheReadTokensSum += liveCostMetrics?.totalCacheReadTokens ?? 0;
        cacheCreationTokensSum += liveCostMetrics?.totalCacheCreationTokens ?? 0;
        cacheInputTokensSum += liveCostMetrics?.totalInputTokens ?? 0;
      }
    }

    // Live session anti-patterns (in-memory, not yet persisted).
    // Mirror the alreadyPersisted guard used for cost above: if this MCP's
    // session is already in todaySessions, its anti-patterns were counted in
    // the loop above — don't double-count.
    if (deps.antiPatternDetector && !liveAlreadyPersisted) {
      const live = deps.antiPatternDetector.getCurrentPatterns();
      antiPatternCount += live.length;
    }

    // Efficiency KPI: average `efficiencyScore` across today's persisted sessions, plus
    // this process's own live score when its own session isn't in that persisted set yet
    // (same liveAlreadyPersisted guard already used for cost/anti-patterns above).
    let efficiencyScoreSum = 0;
    let efficiencyScoreCount = 0;
    for (const s of todaySessions) {
      if (typeof s.efficiencyScore === 'number') {
        efficiencyScoreSum += s.efficiencyScore;
        efficiencyScoreCount++;
      }
    }
    if (!liveAlreadyPersisted) {
      const liveScore = deps.efficiencyScorer?.getSessionAverage()?.score ?? null;
      if (typeof liveScore === 'number') {
        efficiencyScoreSum += liveScore;
        efficiencyScoreCount++;
      }
    }
    const avgEfficiencyScore =
      efficiencyScoreCount > 0 ? efficiencyScoreSum / efficiencyScoreCount : null;

    const avgDurationMs = durationSamples > 0 ? totalDurationMs / durationSamples : 0;

    // Subagent breakdown for the Today KPI strip; if the workflow store is
    // wired, also count workflow runs that started today. `subagentUsd` was
    // already accumulated above — summed across every today session's
    // persisted subagentCostUsd, plus this MCP's own live today-portion.
    // IMPORTANT: getCostForDay and persisted estimatedCostUsd are already all-in
    // (parent + subagent), so totalCostUsd ALREADY includes subagent cost. This
    // is the breakdown, NOT an addend — do not add it to totalCostUsd.
    let subagentTurnCount = 0;
    let workflowRunCount = 0;
    if (deps.workflowStore) {
      const todayRuns = deps.workflowStore.listRuns({ since: startMs });
      workflowRunCount = todayRuns.length;
      for (const r of todayRuns) {
        subagentTurnCount += r.agent_count;
      }
    }

    const cacheHealth = computeCacheHealth({
      cacheReadTokens: cacheReadTokensSum,
      cacheCreationTokens: cacheCreationTokensSum,
      inputTokens: cacheInputTokensSum,
      savingsUsd: cacheSavingsUsdSum,
    } satisfies CacheHealthTotals);

    const forecast =
      dailyFirstActivityMs !== null
        ? buildCostForecastFromInputs(
            {
              sessionSpentUsd: totalCostUsd,
              sessionStartMs: dailyFirstActivityMs,
              dailySpentUsd: totalCostUsd,
              dailyFirstActivityMs,
            },
            now,
          )
        : null;

    const payload = {
      toolCallCount,
      totalCostUsd: Math.round(totalCostUsd * 1000) / 1000,
      antiPatternCount,
      avgDurationMs: Math.round(avgDurationMs),
      sessionCount: sessionsSeen.size,
      sparkline: { startTimestamp: startMs, bucketSizeMs: 60_000, points: sparkline },
      subagentUsd: Math.round(subagentUsd * 1000) / 1000,
      subagentTurnCount,
      workflowRunCount,
      avgEfficiencyScore,
      latency: computeLatencyPercentiles(latencySamples),
      cacheHealth,
      forecastEndOfDayUsd:
        forecast?.forecastEndOfDayUsd != null
          ? Math.round(forecast.forecastEndOfDayUsd * 1000) / 1000
          : null,
    };
    return payload;
  }

  function getTodayAggregatePayload(now: number): TodayAggregatePayload {
    const currentBucket = Math.floor(now / AGGREGATE_TTL_MS);
    if (aggregateCache && aggregateCache.bucket === currentBucket) {
      return aggregateCache.payload;
    }
    const payload = computeTodayAggregatePayload(now);
    aggregateCache = { bucket: currentBucket, payload };
    return payload;
  }

  routes.set('GET /api/sessions/today/aggregate', (_req, res) => {
    jsonOk(res, getTodayAggregatePayload(Date.now()));
  });

  // Workflow listing (script-driven runs). Reads the workflow
  // store, which the dashboard server constructs from on-disk wf_*.json
  // files, so dashboards work even when the watcher is disabled.
  routes.set('GET /api/workflows', (req, res) => {
    if (!deps.workflowStore) return unavailable(res, 'workflowStore');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const since = url.searchParams.get('since');
    const runSource = url.searchParams.get('run_source') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    let sinceMs: number | undefined;
    if (since) {
      const parsed = parseInt(since, 10);
      if (Number.isFinite(parsed)) sinceMs = parsed;
    }
    const runs = deps.workflowStore.listRuns({
      since: sinceMs,
      runSource,
      status,
    });
    // Bare array (not { runs }) — the SPA's fetchWorkflows helper feeds this
    // straight into Array.isArray(); a wrapper object renders an empty list.
    jsonOk(res, runs.map(toWorkflowRunDto));
  });

  routes.set('GET /api/observability-health', (_req, res) => {
    if (!deps.observabilityHealth) return unavailable(res, 'observabilityHealth');
    jsonOk(res, deps.observabilityHealth.getSnapshot());
  });

  routes.set('GET /api/cost', (_req, res) => {
    if (!deps.costTracker) return unavailable(res, 'costTracker');
    const cost = deps.costTracker.getMetrics();
    const forecast = deps.costForecast?.() ?? null;
    // sessionTodayUsd lets the client compute the correct EoD forecast fallback:
    //   todayTotal + (forecastEndOfDayUsd − sessionTodayUsd) = todayTotal + projected
    // Without it, the client would add persistedTodaySpend to forecastEndOfDayUsd and
    // risk double-counting the live session when its snapshot is already in persisted data.
    const sessionTodayUsd = deps.costTracker.getCostForDay?.(localDateKey(Date.now())) ?? null;
    // Extend with subagent spend breakdown so the Today view's
    // "Subagent spend" KPI and the Forecast card's hourly-spend chart have
    // data without an extra round-trip.
    const subagentMetrics = deps.costTracker.getSubagentMetrics?.() ?? null;
    const subagentUsd = subagentMetrics?.subagentUsd ?? 0;
    const totalUsd = cost.sessionTotalCostUsd ?? 0;
    const parentUsd = subagentMetrics
      ? subagentMetrics.parentUsd
      : Math.max(0, totalUsd - subagentUsd);
    const subagentSharePct =
      subagentMetrics?.subagentSharePct ?? (totalUsd > 0 ? (subagentUsd / totalUsd) * 100 : 0);
    // Reconciliation delta is computed by the watcher self-check; the dashboard
    // reads the latest health snapshot here when available. A stub of `null`
    // is returned when no self-check has run yet so the banner stays hidden.
    const healthSnapshot = deps.observabilityHealth?.getSnapshot();
    const reconciliationDeltaPct = healthSnapshot?.costSelfCheckDeltaPct ?? null;
    jsonOk(res, {
      cost,
      forecast,
      sessionTodayUsd,
      subagentUsd,
      parentUsd,
      subagentSharePct,
      reconciliationDeltaPct,
    });
  });

  routes.set('GET /api/anti-patterns', (_req, res) => {
    if (!deps.antiPatternDetector) return unavailable(res, 'antiPatternDetector');
    jsonOk(res, deps.antiPatternDetector.getCurrentPatterns());
  });

  routes.set('GET /api/retry-alerts', (_req, res) => {
    if (!deps.retryDetector) return unavailable(res, 'retryDetector');
    // Destructure out the raw bySession map — by_session below is its
    // formatted replacement, so leaving both in the response would just
    // duplicate the same data under two different shapes/cases.
    const { bySession, ...metrics } = deps.retryDetector.getMetrics();
    jsonOk(res, { ...metrics, by_session: retryAlertsBySession(bySession) });
  });

  routes.set('GET /api/api-failures', (_req, res) => {
    if (!deps.apiFailureTracker) return unavailable(res, 'apiFailureTracker');
    jsonOk(res, deps.apiFailureTracker.getMetrics());
  });

  routes.set('GET /api/instruction-drift', (_req, res) => {
    if (!deps.instructionDriftTracker) return unavailable(res, 'instructionDriftTracker');
    jsonOk(res, deps.instructionDriftTracker.getMetrics());
  });

  routes.set('GET /api/decision-tree', (req, res) => {
    if (!deps.decisionTracker) return unavailable(res, 'decisionTracker');
    // Optional ?sessionId= scopes the result to one session — without
    // it, this process-global tracker's data can belong to a different
    // session than the one selected in the dashboard's trace pane (in
    // `--local` mode, several concurrently-live sessions blended together).
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    jsonOk(res, deps.decisionTracker.getMetrics(sessionId));
  });

  routes.set('GET /api/turn-costs', (req, res) => {
    if (!deps.turnCostAttributor) return unavailable(res, 'turnCostAttributor');
    // Same reasoning as /api/decision-tree above.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    jsonOk(res, deps.turnCostAttributor.getMetrics(sessionId));
  });

  routes.set('GET /api/compute-waste', (_req, res) => {
    if (!deps.retryDetector) return unavailable(res, 'retryDetector');
    if (!deps.antiPatternDetector) return unavailable(res, 'antiPatternDetector');

    const retryTokensWasted = deps.retryDetector.getMetrics().totalTokensWasted;
    const antiPatternTokensWasted = deps.antiPatternDetector.getTotalAntiPatternWaste();
    const totalTokensWasted = retryTokensWasted + antiPatternTokensWasted;

    const patterns = deps.antiPatternDetector.getCurrentPatterns();
    const breakdownMap = patterns
      .filter((p) => p.tokensWasted > 0)
      .reduce<Map<string, { tokens_wasted: number; instances: number }>>((acc, p) => {
        const existing = acc.get(p.type) ?? { tokens_wasted: 0, instances: 0 };
        acc.set(p.type, {
          tokens_wasted: existing.tokens_wasted + p.tokensWasted,
          instances: existing.instances + 1,
        });
        return acc;
      }, new Map());

    const breakdown = [...breakdownMap.entries()]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.tokens_wasted - a.tokens_wasted);

    const status =
      totalTokensWasted >= 2000
        ? 'needs_attention'
        : totalTokensWasted >= 500
          ? 'moderate'
          : 'clean';

    jsonOk(res, {
      total_tokens_wasted: totalTokensWasted,
      retry_tokens_wasted: retryTokensWasted,
      anti_pattern_tokens_wasted: antiPatternTokensWasted,
      breakdown,
      // Anti-pattern waste has no per-session breakdown yet — AntiPattern
      // objects don't carry a sessionId (see ThrashingAlert for the retry
      // side, which now does). This only ever attributes the retry portion.
      by_session: retryAlertsBySession(deps.retryDetector.getMetrics().bySession),
      status,
    });
  });

  routes.set('GET /api/audit', (req, res) => {
    if (!deps.auditTrailManager) return unavailable(res, 'auditTrailManager');
    // Cap here too (not just via getAuditLog()'s own default) so a caller
    // can't force an unbounded read by passing an absurdly large `limit` —
    // the audit log is unpruned on disk, so a naive pass-through would let
    // a single request re-read the entire history.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitStr = url.searchParams.get('limit') ?? '';
    let limit = 1000;
    const parsedLimit = parseInt(limitStr, 10);
    if (!Number.isNaN(parsedLimit)) {
      limit = Math.min(Math.max(parsedLimit, 1), 2000);
    }
    const log = deps.auditTrailManager.getAuditLog(limit);
    jsonOk(res, log.map(toAuditEntry));
  });

  routes.set('GET /api/weekly', (req, res) => {
    if (!deps.weeklySummaryGenerator) return unavailable(res, 'weeklySummaryGenerator');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const countStr = url.searchParams.get('count') ?? '';
    let count = 12;
    const parsed = parseInt(countStr, 10);
    if (!Number.isNaN(parsed)) {
      count = Math.min(Math.max(parsed, 1), 52);
    }
    try {
      deps.weeklySummaryGenerator.generate(getIsoWeekId(new Date()));
    } catch (err) {
      // best-effort — failure here means stale weekly data is returned, not a 500
      console.error('Weekly summary generation failed', err);
    }
    jsonOk(res, deps.weeklySummaryGenerator.loadRecentWeeks(count));
  });

  routes.set('GET /api/budget', (_req, res) => {
    if (!deps.budgetTracker) return unavailable(res, 'budgetTracker');
    jsonOk(res, deps.budgetTracker.getStatus());
  });

  routes.set('GET /api/latency', (_req, res) => {
    // Percentiles come from today's rehydrated samples (persisted timelines +
    // live buffers) rather than this process's tracker, which only ever sees
    // the calls made since it started. slowestCalls has no persisted
    // counterpart, so it stays live-only.
    const today = getTodayAggregatePayload(Date.now()).latency;
    const live = deps.latencyTracker?.getMetrics();
    jsonOk(res, {
      overall: today.overall,
      byTool: today.byTool,
      slowestCalls: live?.slowestCalls ?? [],
    });
  });

  routes.set('GET /api/model-usage', (_req, res) => {
    if (!deps.modelUsageTracker) return unavailable(res, 'modelUsageTracker');
    // Same own-live + persisted-today, excluding-own-already-persisted-session
    // pattern as GET /api/tool-selection-score below: this process's live
    // breakdown is always included, and every OTHER today session's persisted
    // breakdown is added on top — never this process's own persisted entry,
    // which would double-count activity already reflected in the live
    // tracker.
    const ownSessionId = deps.sessionTracker?.getMetrics().sessionId;
    const persistedBreakdowns = (deps.sessionStore?.loadTodaySessions() ?? [])
      .filter((s) => s.sessionId !== ownSessionId)
      .map((s) => s.modelBreakdown ?? {});
    const combined = deps.modelUsageTracker.combineBreakdowns([
      deps.modelUsageTracker.getRawBreakdown(),
      ...persistedBreakdowns,
    ]);
    jsonOk(res, combined);
  });

  routes.set('GET /api/cache-health', (_req, res) => {
    if (!deps.costTracker) return unavailable(res, 'costTracker');
    const { cacheHitRate, totalCacheReadTokens, totalCacheCreationTokens, totalCacheSavingsUsd } =
      deps.costTracker.getMetrics();

    type CacheStatus = 'no_cache_activity' | 'needs_attention' | 'can_improve' | 'excellent';
    let status: CacheStatus;
    let cacheHitRatePct: number | null = null;

    if (cacheHitRate === null || cacheHitRate === undefined) {
      status = 'no_cache_activity';
    } else {
      cacheHitRatePct = Math.round(cacheHitRate * 100);
      if (cacheHitRatePct >= 60) status = 'excellent';
      else if (cacheHitRatePct >= 30) status = 'can_improve';
      else status = 'needs_attention';
    }

    const currentWeek = getIsoWeekId(new Date());
    const trendData = (deps.trendAnalyzer?.computeTrends().weeklyCacheHitRateTrend ?? []).filter(
      (e) => e.week !== currentWeek,
    );
    const lastWeekEntry = trendData.length > 0 ? trendData[trendData.length - 1] : null;
    // The headline hit-rate the Cache Health panel renders (aggregate.cacheHealth,
    // from GET /api/sessions/today/aggregate) is today-scoped. Compare against
    // that same today-scoped rate here — not the lifetime cacheHitRatePct
    // derived above — so the week-over-week delta is on the same basis as the
    // number it's displayed alongside.
    const todayCacheHitRatePct = getTodayAggregatePayload(Date.now()).cacheHealth.cacheHitRatePct;
    const weekOverWeekDeltaPts =
      todayCacheHitRatePct !== null && lastWeekEntry !== null
        ? Math.round(todayCacheHitRatePct - lastWeekEntry.value * 100)
        : null;

    // cache_hit_rate_pct/status reflect this process's lifetime cache
    // activity; week_over_week_delta_pts is computed against today's scoped
    // rate to match the headline it's compared against. Mixing scopes here
    // is intentional — see the comment above weekOverWeekDeltaPts.
    jsonOk(res, {
      status,
      cache_hit_rate_pct: cacheHitRatePct,
      total_cache_read_tokens: totalCacheReadTokens ?? 0,
      total_cache_creation_tokens: totalCacheCreationTokens ?? 0,
      total_savings_usd: totalCacheSavingsUsd ?? 0,
      week_over_week_delta_pts: weekOverWeekDeltaPts,
    });
  });

  routes.set('GET /api/cost-per-tool', (req, res) => {
    if (!deps.turnCostAttributor) return unavailable(res, 'turnCostAttributor');
    // Same reasoning as /api/turn-costs above — optional ?sessionId= scopes
    // this process-global tracker's data to one session.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    jsonOk(res, deps.turnCostAttributor.getMetrics(sessionId));
  });

  routes.set('GET /api/cost-per-outcome', (req, res) => {
    if (!deps.sessionStore?.loadAllSessions)
      return unavailable(res, 'sessionStore.loadAllSessions');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const daysStr = url.searchParams.get('days') ?? '';
    let days = 30;
    const parsedDays = parseInt(daysStr, 10);
    if (!Number.isNaN(parsedDays)) {
      days = Math.min(Math.max(parsedDays, 1), 365);
    }
    // Anchor the window to local midnight `days` ago — matching
    // aggregateDailyCost's local-day grouping for the sibling "Daily Spend"
    // chart (History.tsx) — instead of a raw rolling instant, which doesn't
    // align with any calendar boundary and would draw a different
    // "last N days" line than that chart. loadAllSessions()'s own
    // pre-filter still compares against session-store.ts's UTC-derived
    // filename date, so `since` is widened by one extra day to guarantee it
    // never excludes a session that actually falls inside the local window;
    // the startTime check below applies the real, local-day-aligned cutoff.
    const windowStartMs = localStartOfDay() - (days - 1) * 86_400_000;
    const since = new Date(windowStartMs - 86_400_000);
    const sessions = deps.sessionStore.loadAllSessions({ since }).filter((s) => {
      const startTime = (s as { startTime?: number }).startTime;
      return startTime === undefined || startTime >= windowStartMs;
    });
    jsonOk(res, attributeSessionCosts(sessions));
  });

  routes.set('GET /api/personal-coach', (_req, res) => {
    if (!deps.personalCoach) return unavailable(res, 'personalCoach');
    try {
      deps.weeklySummaryGenerator?.generate(getIsoWeekId(new Date()));
    } catch (err) {
      // best-effort — failure here means "this week" reflects a stale cache, not a 500
      console.error('Weekly summary generation failed', err);
    }
    jsonOk(res, deps.personalCoach.generate());
  });

  routes.set('GET /api/recommendations', (_req, res) => {
    if (!deps.recommendationEngine) return unavailable(res, 'recommendationEngine');
    const developer = deps.config?.developer ?? 'unknown';
    const recs = deps.recommendationEngine
      .generateAllRecommendations(developer)
      // The History dashboard already renders 'efficiency' (CoachCard's
      // regressions, vs. a multi-week baseline) and 'claudemd' (InstructionDriftCard,
      // a differently-computed before/after verdict) via their own panels —
      // surfacing them again here would just restate the same signal with
      // different numbers. 'claudemd_impact' is a prompt_engineering
      // sub-category (see PROMPT_RECOMMENDATION_TITLES) that restates the
      // same "instruction-file change hurt metrics" signal as 'claudemd' under a
      // different top-level category, so it's excluded too. All exclusions
      // are for this dashboard route only; the nr_observe_get_recommendations
      // MCP tool still returns every category, since it has no adjacent
      // panels to duplicate.
      .filter(
        (rec) =>
          rec.category !== 'efficiency' &&
          rec.category !== 'claudemd' &&
          rec.subCategory !== 'claudemd_impact',
      );
    jsonOk(res, { recommendations: recs, count: recs.length });
  });

  routes.set('GET /api/claudemd-impact', (_req, res) => {
    if (!deps.claudeMdTracker) return unavailable(res, 'claudeMdTracker');
    const changes = deps.claudeMdTracker.getChanges();
    if (changes.length === 0) {
      jsonOk(res, { message: 'No instruction-file changes detected' });
      return;
    }
    const latest = changes[changes.length - 1]!;
    const impact = deps.claudeMdTracker.computeImpact(latest.timestamp);
    jsonOk(res, {
      change: {
        filePath: latest.filePath,
        changeType: latest.changeType,
        timestamp: latest.timestamp,
        linesAdded: latest.linesAdded,
        linesRemoved: latest.linesRemoved,
      },
      before: impact.beforeMetrics,
      after: impact.afterMetrics,
      deltas: impact.deltas,
      contextTokensForClaudeMd: impact.contextTokensForClaudeMd,
      verdict: impact.verdict,
    });
  });

  routes.set('GET /api/collaboration-profile', (_req, res) => {
    if (!deps.collaborationProfiler) return unavailable(res, 'collaborationProfiler');
    const developer = (deps.config?.developer as string | undefined) ?? 'unknown';
    const profile = deps.collaborationProfiler.computeProfile(developer);
    const comparison = deps.collaborationProfiler.compareToTeam(developer);
    // developerCount lets the dashboard caveat "vs team" when the baseline
    // is really just this one developer.
    const baseline = deps.collaborationProfiler.computeTeamBaseline();
    jsonOk(res, {
      classification: profile.classification,
      dimensions: profile.dimensions,
      sessionCount: profile.sessionCount,
      teamDeltas: comparison.deltas,
      developerCount: baseline.developerCount,
    });
  });

  routes.set('GET /api/alerts/recent', async (_req, res) => {
    // 404 (not 503) when alerts are not configured — the route does not
    // exist as a logical resource in cloud-only mode or when alerts are
    // disabled.
    if (!deps.alertLog) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    // Fixed limit (50) — matches the dashboard panel cap.
    try {
      const entries = await deps.alertLog.readRecent(50);
      jsonOk(res, entries);
    } catch (err) {
      // Log full error details server-side; never echo to the HTTP client.
      // Stringifying the raw Error leaks file paths, env-var names, and
      // potential connection-string fragments via stack frames.
      console.error('alertLog.readRecent failed', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });

  routes.set('GET /api/quality-proxy', (_req, res) => {
    if (!deps.qualityProxyTracker) return unavailable(res, 'qualityProxyTracker');
    // Same own-live + persisted-today, excluding-own-already-persisted-session
    // pattern as GET /api/model-usage: this process's live raw counts are
    // always included, and every OTHER today session's persisted raw counts
    // are summed on top — rates are derived exactly once from the summed
    // totals, never averaged per-session. qualityByTurnBucket/
    // degradationDetected/events are inherently within-session signals with
    // no persisted cross-session equivalent, so they're sourced from the
    // live tracker only.
    const live = deps.qualityProxyTracker.getMetrics();
    const ownSessionId = deps.sessionTracker?.getMetrics().sessionId;
    // Day-filter this process's own live contribution the same way GET
    // /api/tool-selection-score does just below — QualityProxyTracker has no
    // concept of "day" internally (events accumulate for the tracker's whole
    // process lifetime), so a --local dashboard daemon running since before
    // midnight would otherwise blend yesterday's (or older) signals into
    // "today's sessions" here, inconsistent with the correctly-scoped Tool
    // Selection panel right next to it.
    const startMs = localStartOfDay(Date.now());
    const liveRawCounts = rawQualityCountsFromEvents(
      live.events.filter((e) => e.timestamp >= startMs),
    );
    const persistedCounts = (deps.sessionStore?.loadTodaySessions() ?? [])
      .filter((s) => s.sessionId !== ownSessionId)
      .map((s) => s.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS);
    const combined = combineQualityProxyRawCounts([liveRawCounts, ...persistedCounts]);
    jsonOk(res, {
      ...combined,
      qualityByTurnBucket: live.qualityByTurnBucket,
      degradationDetected: live.degradationDetected,
      events: live.events,
    });
  });

  routes.set('GET /api/tool-selection-score', (_req, res) => {
    if (!deps.toolSelectionScorer) return unavailable(res, 'toolSelectionScorer');
    const startMs = localStartOfDay(Date.now());

    // (1) this process's own already-paired, already-parsed live records —
    // full fidelity, same source the old code used.
    const ownRecords = (deps.toolCallBuffer?.getRecords() ?? []).filter(
      (r) => r.timestamp >= startMs,
    );

    // (2) every OTHER process's still-undrained buffer, paired into full
    // ToolCallRecords (see tool-selection-aggregate.ts). This process's own
    // buffer file is typically already drained into (1) by the time it's
    // peeked, but exclude its sessionId defensively so a change in drain
    // timing can never double-count.
    const ownSessionId = deps.sessionTracker?.getMetrics().sessionId;
    const peeked = deps.localStore?.peekAllBuffers() ?? [];
    const crossProcessRecords = pairToolCallsFromBufferEvents(
      peeked as unknown as readonly HookEvent[],
    ).filter((r) => r.timestamp >= startMs && r.sessionId !== ownSessionId);

    // Score all of today's live, not-yet-persisted activity together so
    // redundant-read/repeated-failure detection sees real cross-call
    // sequencing (not just independently-summed per-session counts).
    const liveMetrics = deps.toolSelectionScorer.scoreSession([
      ...ownRecords,
      ...crossProcessRecords,
    ]);

    // (3) sessions already completed and persisted today — each carries its
    // own toolSelectionMetrics summary computed at save time (see
    // buildSessionSummary in session-store.ts), before outputSizeBytes was
    // gone for good.
    const persistedSummaries = (deps.sessionStore?.loadTodaySessions() ?? [])
      .filter((s) => s.sessionId !== ownSessionId)
      .map((s) => s.toolSelectionMetrics)
      .filter((m): m is ToolSelectionSummary => m != null);

    const combined = deps.toolSelectionScorer.combineSummaries([
      toToolSelectionSummary(liveMetrics),
      ...persistedSummaries,
    ]);
    jsonOk(res, combined);
  });

  routes.set('GET /api/git-efficiency', (_req, res) => {
    if (!deps.gitEfficiencyTracker) return unavailable(res, 'gitEfficiencyTracker');
    jsonOk(res, deps.gitEfficiencyTracker.getMetrics());
  });

  routes.set('GET /api/context', (req, res) => {
    if (!deps.contextTracker) return unavailable(res, 'contextTracker');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const local = deps.contextTracker.getMetrics(sessionId);
    // A session live only in a different --stdio process never touches this
    // process's own ContextTrackerRegistry, so local.turnCount stays 0 even
    // when the session has real activity elsewhere. Recompute from any
    // process's undrained buffer before falling back to the (correctly)
    // empty default.
    if (local.turnCount === 0 && sessionId && deps.localStore) {
      const events = buildContextReplayEvents(deps.localStore.peekAllBuffers(), sessionId);
      if (events.length > 0) {
        jsonOk(res, computeContextMetricsFromEvents(events));
        return;
      }
    }
    jsonOk(res, local);
  });

  routes.set('GET /api/context-composition', (_req, res) => {
    if (!deps.contextCompositionTracker) return unavailable(res, 'contextCompositionTracker');
    jsonOk(res, deps.contextCompositionTracker.getMetrics());
  });

  routes.set('GET /api/context-efficiency', (_req, res) => {
    if (!deps.contextEfficiencyTracker) return unavailable(res, 'contextEfficiencyTracker');
    jsonOk(res, deps.contextEfficiencyTracker.getMetrics());
  });

  routes.set('GET /api/concurrency', (req, res) => {
    if (!deps.concurrencyTracker) return unavailable(res, 'concurrencyTracker');
    try {
      const livePeak = deps.concurrencyTracker.getPeakConcurrent();

      const url = new URL(req.url ?? '/', 'http://localhost');
      const view = url.searchParams.get('view');
      if (view === 'history') {
        const daysParam = url.searchParams.get('days');
        const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90) : 30;
        const since = new Date(localStartOfDay());
        since.setDate(since.getDate() - days);
        const allSessions = deps.sessionStore?.loadAllSessions?.({ since }) ?? [];
        const dailyPeaks = computeDailyPeakConcurrency(
          allSessions as readonly SessionActivityLike[],
          days,
        );
        // Override today's bucket with the live peak — disk-derived
        // concurrency only sees persisted (completed) sessions, so a
        // dashboard with active concurrent sessions but nothing flushed
        // to disk yet would otherwise report peak=0 for today.
        if (dailyPeaks.length > 0 && livePeak > 0) {
          const today = dailyPeaks[dailyPeaks.length - 1];
          if (today.peak < livePeak) {
            dailyPeaks[dailyPeaks.length - 1] = { ...today, peak: livePeak };
          }
        }
        jsonOk(res, { dailyPeaks });
        return;
      }

      // loadAllSessions() already excludes synthetic session ids (`local-*`,
      // `proxy-*`, `pending-*`) — same producer-level guarantee that keeps
      // them out of /api/sessions and /api/sessions/live — so `allTimePeak`
      // stays comparable to `peak` below without re-filtering here.
      const allSessions = deps.sessionStore?.loadAllSessions?.() ?? [];
      const allTimePeak = computeTodayPeakConcurrency(
        allSessions as readonly SessionActivityLike[],
      );

      // Prefer loadSessionsOverlappingToday() so a session that started
      // yesterday and is still running isn't invisible to the chart —
      // loadTodaySessions() filters by filename date (= start date) and
      // would otherwise silently drop it. Downstream window-building already
      // clamps each session's activity to [startTimestamp, dayEnd], so widening
      // the input set here can't leak yesterday's activity into today's buckets.
      // loadAllSessions()/loadTodaySessions() already exclude synthetic session
      // ids, so the chart buckets below agree with the session list shown
      // alongside the chart without re-filtering here.
      const todaySessions =
        deps.sessionStore?.loadSessionsOverlappingToday?.() ??
        deps.sessionStore?.loadTodaySessions() ??
        [];

      // 96 × 15-minute fixed-grid buckets covering today (local midnight →
      // local midnight + 24h). Each bucket holds the peak concurrent
      // session count within its window. Bounded payload (~10 KB) and
      // renders cleanly at any zoom level. Replaces the prior unbounded
      // 30-second rolling timeSeries.
      const startTimestamp = localStartOfDay();
      // getLiveSessions() already excludes synthetic session ids too.
      const liveIds = deps.liveSessionRegistry?.getLiveSessions() ?? [];
      const bufferRecords = deps.toolCallBuffer?.getRecords() ?? [];
      const windows = collectTodayActivityWindows(todaySessions, liveIds, bufferRecords);
      const buckets = computeTodayConcurrencyBuckets(windows, startTimestamp);
      // Derive the headline "today peak" from the SAME buckets shown in the
      // chart — rather than from an independent computation over a
      // differently-scoped session set — so the two numbers can never
      // disagree by construction. Computing them from two different
      // concurrency models is exactly how the headline and chart can
      // silently drift apart.
      //
      // Deliberately NOT folded with `livePeak` here (unlike allTimePeak
      // below): `livePeak` is a synthetic-id-unfiltered, never-reset
      // lifetime max from LiveSessionRegistry, so mixing it into today's
      // headline can reintroduce that same chart/headline disagreement.
      // It's unnecessary anyway:
      // `windows` already unions each live session's buffered (not-yet-
      // persisted) activity into the same buckets, so a currently-live
      // session with any tool-call activity is already reflected here.
      const historicalPeak = buckets.reduce((max, b) => Math.max(max, b.count), 0);

      jsonOk(res, {
        current: computeCrossProcessLiveSessionIds(deps).length,
        peak: historicalPeak,
        allTimePeak: Math.max(livePeak, historicalPeak, allTimePeak),
        bucketSizeMs: CONCURRENCY_BUCKET_SIZE_MS,
        startTimestamp,
        buckets,
      });
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  routes.set('GET /api/activity-heatmap', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const view = url.searchParams.get('view') ?? 'today';
      // The browser sends its own IANA timezone (Intl.DateTimeFormat().
      // resolvedOptions().timeZone) as `tz` — see fetchActivityHeatmap in
      // src/web/api/client.ts. When present and recognized, `tz` is used
      // instead of this dashboard *server* process's own OS/Intl timezone to
      // draw the day boundary, so a cloud-hosted or containerized dashboard
      // viewed from a different timezone than the server still buckets
      // "today" the way the viewing browser expects. Falls back to the
      // server's own timezone when `tz` is absent, blank, or not a name this
      // server's ICU recognizes — Intl.DateTimeFormat throws a RangeError on
      // an unrecognized IANA name, which can happen from ICU version skew
      // alone (e.g. a browser reporting a newer alias like
      // "America/Ciudad_Juarez" that this server's Node/ICU doesn't have),
      // with no malice or client bug required; probing it here keeps that
      // case a graceful fallback instead of a 500 for the whole panel.
      const tzParam = url.searchParams.get('tz')?.trim();
      let tz: string | undefined;
      if (tzParam) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tzParam });
          tz = tzParam;
        } catch {
          tz = undefined;
        }
      }

      if (view === 'today') {
        const now = Date.now();
        const startMs = localStartOfDay(now, tz);
        const bucketSizeMs = 900_000;
        const bucketCount = Math.ceil((now - startMs) / bucketSizeMs) || 1;
        const buckets = new Array<number>(bucketCount).fill(0);

        const bufferRecords = deps.toolCallBuffer?.getRecords() ?? [];
        for (const r of bufferRecords) {
          if (r.timestamp >= startMs) {
            const idx = Math.floor((r.timestamp - startMs) / bucketSizeMs);
            if (idx >= 0 && idx < bucketCount) {
              buckets[idx]++;
            }
          }
        }

        // Prefer loadSessionsOverlappingToday() so a session that started
        // yesterday and is still running isn't invisible here —
        // loadTodaySessions() filters by filename date (= start date) and
        // would otherwise silently drop it. The `entry.timestamp >= startMs`
        // check just below already excludes that session's yesterday-side
        // entries, so widening the input set can't double-count anything.
        const todaySessions =
          deps.sessionStore?.loadSessionsOverlappingToday?.() ??
          deps.sessionStore?.loadTodaySessions() ??
          [];
        for (const s of todaySessions) {
          const session = s as { timeline?: readonly { timestamp: number }[] };
          if (session.timeline) {
            for (const entry of session.timeline) {
              if (entry.timestamp >= startMs) {
                const idx = Math.floor((entry.timestamp - startMs) / bucketSizeMs);
                if (idx >= 0 && idx < bucketCount) {
                  buckets[idx]++;
                }
              }
            }
          }
        }

        const maxCount = Math.max(...buckets, 1);
        jsonOk(res, { buckets, bucketSizeMs, startTimestamp: startMs, maxCount });
        return;
      }

      if (view === 'history') {
        const weeksParam = url.searchParams.get('weeks');
        const weeks = weeksParam ? Math.min(Math.max(parseInt(weeksParam, 10) || 12, 1), 52) : 12;
        // Local (not UTC) day boundaries — see localStartOfDay's doc comment
        // and computeDailyPeakConcurrency's identical handling just above. A
        // developer's evening session commonly straddles UTC midnight, which
        // would otherwise land that activity on the wrong calendar day for
        // anyone not in UTC.
        const todayStart = localStartOfDay(undefined, tz);

        // Walk backward from today to the start of the window, one day at a
        // time, snapping each step to that day's actual local midnight via
        // localStartOfDay rather than subtracting a fixed 86_400_000ms — a
        // local day can be 23h or 25h across a DST transition. Subtracting
        // 12h before re-snapping is always enough to land within the
        // previous day (the shortest possible local day is 23h) and never
        // enough to skip past it (the longest is 25h).
        const totalDays = weeks * 7;
        const dayBoundaries = new Array<number>(totalDays + 1);
        dayBoundaries[totalDays] = todayStart;
        for (let i = totalDays - 1; i >= 0; i--) {
          dayBoundaries[i] = localStartOfDay(dayBoundaries[i + 1] - 12 * 3_600_000, tz);
        }
        const startMs = dayBoundaries[0];

        const sessions = deps.sessionStore?.loadAllSessions?.({ since: new Date(startMs) }) ?? [];

        const dayMap = new Map<string, number>();
        for (const boundary of dayBoundaries) {
          dayMap.set(localDateKey(boundary, tz), 0);
        }

        // Bucket by each timeline entry's own timestamp, mirroring the
        // `view=today` branch above — not by attributing a session's entire
        // toolCallCount to the single day it *started* on. A session whose
        // activity spans a day boundary would otherwise show a false spike
        // on the start day and a false gap on the day(s) it actually
        // continued into.
        //
        // `timeline` is optional and was only added to persisted sessions
        // ~2026-06-02 (session-store.ts) — this route's default 12-week
        // window still reaches sessions saved before that. A session with no
        // timeline falls back to the old, still local-day-keyed,
        // start-day/toolCallCount attribution so that older history doesn't
        // silently drop to zero; only sessions that *do* have a timeline get
        // the per-entry walk.
        for (const s of sessions) {
          const session = s as {
            startTime?: number;
            toolCallCount?: number;
            timeline?: readonly { timestamp: number }[];
          };
          if (session.timeline) {
            for (const entry of session.timeline) {
              if (entry.timestamp < startMs) continue;
              const key = localDateKey(entry.timestamp, tz);
              if (dayMap.has(key)) {
                dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
              }
            }
            continue;
          }
          if (!session.startTime || session.startTime < startMs) continue;
          const key = localDateKey(session.startTime, tz);
          if (dayMap.has(key)) {
            dayMap.set(key, (dayMap.get(key) ?? 0) + (session.toolCallCount ?? 0));
          }
        }

        const days = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
        const maxCount = Math.max(...days.map((d) => d.count), 1);
        jsonOk(res, { days, maxCount });
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_view', message: 'Use view=today or view=history' }));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  routes.set('GET /api/git-efficiency/repos', (_req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    // Prefer loadSessionsOverlappingToday() so a session that started
    // yesterday and crossed into today isn't invisible from these pills —
    // loadTodaySessions() filters by filename date (= start date) and would
    // otherwise silently drop it, even though its git activity still counts
    // toward the KPIs shown alongside these pills — same reasoning as the
    // day-boundary hydration in src/index.ts.
    const todaySessions = (deps.sessionStore.loadSessionsOverlappingToday?.() ??
      deps.sessionStore.loadTodaySessions()) as Array<{
      repoName?: string | null;
      sessionId: string;
    }>;
    const repoSet = new Set<string>();
    for (const session of todaySessions) {
      if (typeof session.repoName === 'string' && session.repoName) {
        repoSet.add(session.repoName);
      }
    }
    // Include the current repo from git efficiency tracker if available
    let currentRepo: string | null = null;
    if (deps.gitEfficiencyTracker) {
      const trackerRepo = deps.gitEfficiencyTracker.getMetrics().repoContext.repoName;
      if (trackerRepo) {
        currentRepo = trackerRepo;
        repoSet.add(trackerRepo);
      }
    }
    jsonOk(res, { repos: [...repoSet].sort(), currentRepo });
  });

  // ── Diagnostics endpoint ────────────────────────────────────────────────

  routes.set('GET /api/diagnostics', async (_req, res) => {
    const { runDiagnostics } = await import('../../install/diagnostics.js');
    const checks = await runDiagnostics({
      configPath: deps.configFilePath ?? undefined,
      // Pass the runtime-resolved storagePath so env-var overrides are
      // captured. diagnostics.ts prioritises this value over the file-validated
      // storagePath, so the same path the MCP server writes to is always checked.
      storagePath: deps.config?.storagePath,
      platform: deps.getActivePlatform?.(),
    });
    jsonOk(res, checks);
  });

  // ── Settings endpoints ──────────────────────────────────────────────────

  routes.set('GET /api/settings', (_req, res) => {
    if (!deps.config) return unavailable(res, 'config');
    const c = deps.config;

    // Read editable fields from disk so the UI reflects the latest saved
    // values after a PATCH (deps.config is frozen at startup and never
    // updated in memory).
    let disk: Record<string, unknown> = {};
    if (deps.configFilePath) {
      try {
        disk = JSON.parse(readFileSync(deps.configFilePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        /* config file may not exist yet — fall through to startup defaults */
      }
    }

    const diskAlerts = (disk.alerts ?? {}) as Record<string, unknown>;
    const diskPersonal = (diskAlerts['personal'] ?? {}) as Record<string, unknown>;

    jsonOk(res, {
      // Editable fields: prefer disk, fall back to startup config
      developer: typeof disk.developer === 'string' ? disk.developer : c.developer,
      teamId: 'teamId' in disk ? (disk.teamId as string | null) : c.teamId,
      sessionBudgetUsd:
        'sessionBudgetUsd' in disk ? (disk.sessionBudgetUsd as number | null) : c.sessionBudgetUsd,
      dailyBudgetUsd:
        'dailyBudgetUsd' in disk ? (disk.dailyBudgetUsd as number | null) : c.dailyBudgetUsd,
      weeklyBudgetUsd:
        'weeklyBudgetUsd' in disk ? (disk.weeklyBudgetUsd as number | null) : c.weeklyBudgetUsd,
      retainSessionsDays:
        'retainSessionsDays' in disk
          ? (disk.retainSessionsDays as number | null)
          : c.retainSessionsDays,
      digestWebhookUrl:
        'digestWebhookUrl' in disk ? (disk.digestWebhookUrl as string | null) : c.digestWebhookUrl,
      digestSchedule:
        typeof disk.digestSchedule === 'string' ? disk.digestSchedule : c.digestSchedule,
      alerts: {
        personal: {
          dailyCostUsd:
            typeof diskPersonal['dailyCostUsd'] === 'number'
              ? diskPersonal['dailyCostUsd']
              : c.personalAlertThresholds.dailyCostUsd,
          sessionCostUsd:
            typeof diskPersonal['sessionCostUsd'] === 'number'
              ? diskPersonal['sessionCostUsd']
              : c.personalAlertThresholds.sessionCostUsd,
          efficiencyScoreMin:
            typeof diskPersonal['efficiencyScoreMin'] === 'number'
              ? diskPersonal['efficiencyScoreMin']
              : c.personalAlertThresholds.efficiencyScoreMin,
          stuckLoopCountMax:
            typeof diskPersonal['stuckLoopCountMax'] === 'number'
              ? diskPersonal['stuckLoopCountMax']
              : c.personalAlertThresholds.stuckLoopCountMax,
          antiPatternCountMax:
            typeof diskPersonal['antiPatternCountMax'] === 'number'
              ? diskPersonal['antiPatternCountMax']
              : c.personalAlertThresholds.antiPatternCountMax,
        },
      },
      // Read-only fields always from startup config
      accountId: c.accountId ?? null,
      appName: c.appName,
      mode: c.mode,
      storagePath: c.storagePath,
      highSecurity: c.highSecurity,
      licenseKey: c.licenseKey ? '••••' + c.licenseKey.slice(-4) : null,
    });
  });

  routes.set('PATCH /api/settings', async (req, res) => {
    if (!deps.configFilePath) return unavailable(res, 'configFilePath');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(deps.configFilePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no existing config — start fresh */
    }

    const errors: string[] = [];
    let digestUrlOnly = true; // tracks whether only digest URL changed

    if ('developer' in body) {
      if (typeof body.developer !== 'string') {
        errors.push('developer must be a string');
      } else {
        existing.developer = normalizeDeveloperName(body.developer);
        digestUrlOnly = false;
      }
    }
    if ('teamId' in body) {
      if (body.teamId !== null && typeof body.teamId !== 'string') {
        errors.push('teamId must be string or null');
      } else {
        existing.teamId = body.teamId;
        digestUrlOnly = false;
      }
    }
    if ('sessionBudgetUsd' in body) {
      if (
        body.sessionBudgetUsd !== null &&
        (typeof body.sessionBudgetUsd !== 'number' || body.sessionBudgetUsd <= 0)
      ) {
        errors.push('sessionBudgetUsd must be a positive number or null');
      } else {
        existing.sessionBudgetUsd = body.sessionBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('dailyBudgetUsd' in body) {
      if (
        body.dailyBudgetUsd !== null &&
        (typeof body.dailyBudgetUsd !== 'number' || body.dailyBudgetUsd <= 0)
      ) {
        errors.push('dailyBudgetUsd must be a positive number or null');
      } else {
        existing.dailyBudgetUsd = body.dailyBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('weeklyBudgetUsd' in body) {
      if (
        body.weeklyBudgetUsd !== null &&
        (typeof body.weeklyBudgetUsd !== 'number' || body.weeklyBudgetUsd <= 0)
      ) {
        errors.push('weeklyBudgetUsd must be a positive number or null');
      } else {
        existing.weeklyBudgetUsd = body.weeklyBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('retainSessionsDays' in body) {
      if (
        body.retainSessionsDays !== null &&
        (!Number.isInteger(body.retainSessionsDays) ||
          (body.retainSessionsDays as number) < 1 ||
          (body.retainSessionsDays as number) > 365)
      ) {
        errors.push('retainSessionsDays must be integer 1-365 or null');
      } else {
        existing.retainSessionsDays = body.retainSessionsDays;
        digestUrlOnly = false;
      }
    }
    if ('digestWebhookUrl' in body) {
      if (
        body.digestWebhookUrl !== null &&
        (typeof body.digestWebhookUrl !== 'string' ||
          !body.digestWebhookUrl.startsWith('https://hooks.slack.com/'))
      ) {
        errors.push(
          'digestWebhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...) or null',
        );
      } else {
        existing.digestWebhookUrl = body.digestWebhookUrl ?? undefined;
        if (existing.digestWebhookUrl === undefined) {
          delete existing.digestWebhookUrl;
        }
      }
    }
    if ('digestSchedule' in body) {
      if (typeof body.digestSchedule !== 'string') {
        errors.push('digestSchedule must be a string');
      } else {
        existing.digestSchedule = body.digestSchedule;
        digestUrlOnly = false;
      }
    }
    if ('alerts' in body) {
      const alertsBody = body.alerts as Record<string, unknown> | undefined;
      const personal = alertsBody?.['personal'] as Record<string, unknown> | undefined;
      if (personal) {
        const existingAlerts = (existing.alerts ?? {}) as Record<string, unknown>;
        const existingPersonal = (existingAlerts['personal'] ?? {}) as Record<string, unknown>;
        if ('dailyCostUsd' in personal) {
          if (typeof personal.dailyCostUsd !== 'number' || personal.dailyCostUsd < 0) {
            errors.push('alerts.personal.dailyCostUsd must be a non-negative number');
          } else {
            existingPersonal.dailyCostUsd = personal.dailyCostUsd;
          }
        }
        if ('sessionCostUsd' in personal) {
          if (typeof personal.sessionCostUsd !== 'number' || personal.sessionCostUsd < 0) {
            errors.push('alerts.personal.sessionCostUsd must be a non-negative number');
          } else {
            existingPersonal.sessionCostUsd = personal.sessionCostUsd;
          }
        }
        if ('efficiencyScoreMin' in personal) {
          if (
            typeof personal.efficiencyScoreMin !== 'number' ||
            personal.efficiencyScoreMin < 0 ||
            personal.efficiencyScoreMin > 1
          ) {
            errors.push('alerts.personal.efficiencyScoreMin must be 0-1');
          } else {
            existingPersonal.efficiencyScoreMin = personal.efficiencyScoreMin;
          }
        }
        if ('stuckLoopCountMax' in personal) {
          if (
            !Number.isInteger(personal.stuckLoopCountMax) ||
            (personal.stuckLoopCountMax as number) < 0
          ) {
            errors.push('alerts.personal.stuckLoopCountMax must be a non-negative integer');
          } else {
            existingPersonal.stuckLoopCountMax = personal.stuckLoopCountMax;
          }
        }
        if ('antiPatternCountMax' in personal) {
          if (
            !Number.isInteger(personal.antiPatternCountMax) ||
            (personal.antiPatternCountMax as number) < 0
          ) {
            errors.push('alerts.personal.antiPatternCountMax must be a non-negative integer');
          } else {
            existingPersonal.antiPatternCountMax = personal.antiPatternCountMax;
          }
        }
        existingAlerts['personal'] = existingPersonal;
        existing.alerts = existingAlerts;
        digestUrlOnly = false;
      }
    }

    if (errors.length > 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'validation_failed', errors }));
      return;
    }

    writeFileSync(deps.configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    jsonOk(res, { ok: true, restartRequired: !digestUrlOnly });
  });

  routes.set('POST /api/digest/send', async (_req, res) => {
    if (!deps.weeklySummaryGenerator || !deps.configFilePath) return unavailable(res, 'digest');
    const result = await handleSendDigest(deps.weeklySummaryGenerator, deps.configFilePath);
    jsonOk(res, result);
  });

  return async (req, res) => {
    try {
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      // Normalize a single trailing slash so `/api/workflows/` resolves to the
      // same static route as `/api/workflows`. Without this, a trailing-slash
      // request misses the exact-match static `routes` map AND misses the
      // workflow-detail regex `^/api/workflows/([…]{1,64})$` (its capture group
      // requires ≥1 char after the slash), so it fell through to the catch-all
      // 404 `{error:'not_found'}`. The root path `/` is preserved. Applied to
      // every route, so detail/replay dynamic matchers also accept a trailing
      // slash (`/api/sessions/<id>/`).
      const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
      const key = `${req.method ?? 'GET'} ${path}`;
      const fn = routes.get(key);
      if (fn) {
        await fn(req, res);
        return;
      }

      // Workflow detail. Allow `wf_<hex>-<hex>` filename runIds
      // (lowercase letters, digits, hyphens, underscores; capped at 64 chars
      // to defend against pathological inputs).
      const workflowDetailMatch = /^\/api\/workflows\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
      if (req.method === 'GET' && workflowDetailMatch) {
        const runId = workflowDetailMatch[1]!;
        if (!deps.workflowStore) return unavailable(res, 'workflowStore');
        const run = deps.workflowStore.getRun(runId);
        if (run === null) {
          // Live fallback: a still-running workflow has no on-disk `wf_*.json`
          // rollup yet (that is written only at termination), but its subagent
          // transcripts already exist and the swimlane surfaces the run as
          // clickable. Synthesize a 'running' detail from those transcripts so
          // the drawer shows live progress instead of "Failed to load run
          // details." Falls through to 404 only when no live data exists either.
          const live = deps.subagentTimeline?.getRunLive?.(runId) ?? null;
          if (live !== null) {
            jsonOk(res, toLiveWorkflowDetail(live));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        // Serialize to camelCase so the detail drawer + agent table read real
        // values instead of rendering every field as `—`. The per-agent rows
        // only carry an aggregate `tokens` count (no input/output/cache split).
        const runRow = run as WorkflowRunRow;
        jsonOk(res, {
          run: toWorkflowRunDto(runRow),
          agents: (runRow.agents ?? []).map(toWorkflowAgentDto),
          topology: runRow.topology ?? null,
        });
        return;
      }

      // ONE subagent's individual tool calls, for the attributed session-trace
      // view. Matched BEFORE the `/subagents` branch below so the longer,
      // more-specific path wins (`.../subagents/<agentId>/calls` would also
      // satisfy the broader matcher's prefix otherwise). Trailing slashes are
      // already normalized by the dispatcher, so `.../calls/` resolves here too.
      const subagentCallsMatch =
        /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/subagents\/([a-zA-Z0-9_-]{1,64})\/calls$/.exec(
          path,
        );
      if (req.method === 'GET' && subagentCallsMatch) {
        if (!deps.subagentTimeline) return unavailable(res, 'subagentTimeline');
        const sessionId = subagentCallsMatch[1]!;
        const agentId = subagentCallsMatch[2]!;
        jsonOk(res, deps.subagentTimeline.getAgentCalls(sessionId, agentId));
        return;
      }

      // Agent fan-out swimlane data for one session. Dynamic `:sessionId`
      // route — matched here alongside the other `/api/sessions/:id/...`
      // branches (and after the workflow-detail branch above). Trailing
      // slashes are already normalized by the dispatcher, so
      // `/api/sessions/<id>/subagents/` resolves here too.
      const subagentsMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/subagents$/.exec(path);
      if (req.method === 'GET' && subagentsMatch) {
        if (!deps.subagentTimeline) return unavailable(res, 'subagentTimeline');
        const sessionId = subagentsMatch[1]!;
        jsonOk(res, deps.subagentTimeline.getSubagentsForSession(sessionId));
        return;
      }

      // Try dynamic routes
      const replayMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/replay$/.exec(path);
      if (req.method === 'GET' && replayMatch) {
        const sessionId = replayMatch[1]!;
        const replay = buildReplayResponse(sessionId, deps);
        if (replay === null) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no_replay_data' }));
          return;
        }
        jsonOk(res, replay);
        return;
      }

      const sessionIdMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (req.method === 'GET' && sessionIdMatch) {
        const sessionId = sessionIdMatch[1]!;
        if (!deps.sessionStore) return unavailable(res, 'sessionStore');
        const session = deps.sessionStore.loadSession(sessionId);
        if (session != null) {
          // Read the session's own persisted raw counts directly and derive
          // its rates — no more re-deriving signals from `timeline`, now that
          // QualityProxyTracker.getRawCounts() is captured at save time.
          const quality = combineQualityProxyRawCounts([
            session.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS,
          ]);
          // toDashboardSummary drops sensitive content fields (session_intent)
          // that must not reach the HTTP surface; the detail view augments the
          // remaining fields below.
          const responseBody: Record<string, unknown> = toDashboardSummary(session);
          if (quality.totalSignals > 0) responseBody.qualityProxy = quality;
          // The persisted shape's key is `toolSelectionMetrics`, but
          // Sessions.tsx's SessionTimeline reads `toolSelectionScore` —
          // remap here so this branch's response uses the same field name
          // as the other two `/api/sessions/:id` branches.
          if (session.toolSelectionMetrics) {
            responseBody.toolSelectionScore = session.toolSelectionMetrics;
          }
          // `session.timeline` is append-only in processing order, not
          // timestamp order (parallel tool calls can complete out of
          // start-order) — sort before returning, mirroring the identical
          // fix already applied to buildReplayResponse()'s persisted branch.
          if (Array.isArray(session.timeline)) {
            responseBody.timeline = [...session.timeline].sort((a, b) => a.timestamp - b.timestamp);
          }
          jsonOk(res, responseBody);
          return;
        }
        // Not persisted — check if it's the current live session
        if (deps.sessionTracker) {
          const live = deps.sessionTracker.getMetrics();
          if (live.sessionId === sessionId) {
            const costMetrics = deps.costTracker?.getMetrics();
            const costUsd = costMetrics?.sessionTotalCostUsd ?? null;
            const model = costMetrics?.model ?? null;
            // Per-model breakdown so the UI can show every model used this
            // session, not just the last one seen (`model` above collapses a
            // mid-session model switch to whichever model was current at
            // read time). Persisted sessions already carry this via
            // FullSessionSummary.modelBreakdown — mirror it here so the live
            // branch renders the same way.
            const modelBreakdown = deps.modelUsageTracker?.getRawBreakdown();
            const antiPatterns: PersistedAntiPattern[] = deps.antiPatternDetector
              ? toPersistedAntiPatterns(deps.antiPatternDetector.getCurrentPatterns())
              : [];
            const ownSessionRecords = (deps.toolCallBuffer?.getRecords() ?? []).filter(
              (r) => r.sessionId === sessionId,
            );
            const quality = deps.qualityProxyTracker?.getMetrics();
            jsonOk(res, {
              sessionId: live.sessionId,
              sessionName: live.sessionName ?? null,
              sessionNameSource: live.sessionNameSource ?? null,
              startTime: live.sessionStartTime,
              durationMs: live.sessionDurationMs,
              toolCallCount: live.toolCallCount,
              estimatedCostUsd: costUsd,
              model,
              modelBreakdown,
              outcome: 'in progress',
              toolBreakdown: live.toolCallCountByTool,
              antiPatterns,
              qualityProxy: quality && quality.totalSignals > 0 ? quality : undefined,
              toolSelectionScore:
                ownSessionRecords.length > 0
                  ? deps.toolSelectionScorer?.scoreSession(ownSessionRecords)
                  : undefined,
              // Use the same `timeline` shape as persisted sessions so the
              // Sessions and Replay views can consume one type. See
              // src/storage/types.ts ReplayTimelineEntry. `toolCallTimeline`
              // is append-only in processing order, not timestamp order —
              // sort before returning, mirroring buildReplayResponse().
              timeline: live.toolCallTimeline
                .map((t) => ({
                  timestamp: t.timestamp,
                  toolName: t.toolName,
                  durationMs: t.durationMs,
                  success: t.success ?? true,
                }))
                .sort((a, b) => a.timestamp - b.timestamp),
            });
            return;
          }
        }
        // Concurrent live session tracked by the registry but not this server's
        // own session — synthesize from tool call buffer records.
        if (computeCrossProcessLiveSessionIds(deps).includes(sessionId)) {
          const allRecords = deps.toolCallBuffer?.getRecords() ?? [];
          const records = allRecords.filter(
            (r) => (r as { sessionId?: string | null }).sessionId === sessionId,
          );
          const timeline = records
            .map((r) => ({
              timestamp: r.timestamp,
              toolName: r.toolName,
              durationMs: r.durationMs ?? null,
              success: r.success,
              filePath: r.filePath ? redactSensitive(String(r.filePath)) : undefined,
              command: r.command ? redactSensitive(String(r.command)) : undefined,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);
          const breakdown: Record<string, number> = Object.create(null);
          for (const r of records) {
            breakdown[r.toolName] = (breakdown[r.toolName] ?? 0) + 1;
          }
          const startTime = timeline.length > 0 ? timeline[0]!.timestamp : Date.now();
          const lastTs = timeline.length > 0 ? timeline[timeline.length - 1]!.timestamp : startTime;
          // Chronological order matters for both detectors below (thrashing/
          // stuck-loop/self-correction all reason about call sequence), but
          // `records` comes straight from the tool call buffer with no
          // ordering guarantee — sort a copy, mirroring `timeline` above.
          const sortedRecords = [...records].sort((a, b) => a.timestamp - b.timestamp);
          // A fresh AntiPatternDetector instance, not `deps.antiPatternDetector`
          // — that shared instance belongs to this process's own live session
          // and caches its last analyze() result for getCurrentPatterns();
          // reusing it here would clobber that cache with a different
          // session's patterns.
          const antiPatternResults =
            sortedRecords.length > 0 ? new AntiPatternDetector().analyze(sortedRecords) : null;
          const antiPatterns: PersistedAntiPattern[] = antiPatternResults
            ? toPersistedAntiPatterns(antiPatternResults.patterns)
            : [];
          // Likewise a fresh QualityProxyTracker — it's stateful (tracks the
          // last edit for backtrack/self-correction detection), so it can't
          // be a pure function call the way AntiPatternDetector.analyze() is.
          const qualityTracker = new QualityProxyTracker();
          for (const r of sortedRecords) qualityTracker.recordToolCall(r);
          const quality = combineQualityProxyRawCounts([qualityTracker.getRawCounts()]);
          jsonOk(res, {
            sessionId,
            sessionName: deps.liveSessionRegistry?.getSessionName(sessionId) ?? null,
            sessionNameSource: deps.liveSessionRegistry?.getSessionNameSource?.(sessionId) ?? null,
            startTime,
            durationMs: lastTs - startTime,
            toolCallCount: records.length,
            estimatedCostUsd: null,
            model: null,
            outcome: 'in progress',
            toolBreakdown: breakdown,
            antiPatterns,
            qualityProxy: quality.totalSignals > 0 ? quality : undefined,
            toolSelectionScore:
              sortedRecords.length > 0
                ? deps.toolSelectionScorer?.scoreSession(sortedRecords)
                : undefined,
            timeline,
          });
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      const logger = (await import('../../shared/index.js')).createLogger('api-handler');
      logger.error('Unhandled error in API route handler', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  };
}

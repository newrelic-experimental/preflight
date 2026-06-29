/**
 * MCP tool definitions and handlers for cross-session analytics and digest delivery.
 *
 * Tools: nr_observe_get_session_history, nr_observe_get_weekly_summary,
 *   nr_observe_get_trends, nr_observe_get_collaboration_profile,
 *   nr_observe_get_claudemd_impact, nr_observe_get_cost_per_outcome,
 *   nr_observe_get_recommendations, nr_observe_get_platform_comparison,
 *   nr_observe_get_team_summary, nr_observe_subscribe_digest,
 *   nr_observe_unsubscribe_digest, nr_observe_send_digest
 *
 * Tool defs and handlers are exported for integration into the main
 * registerTools() in session-stats.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { SessionStore } from '../storage/session-store.js';
import { formatSlackDigest } from '../digest/digest-formatter.js';
import { sendSlackDigest } from '../digest/digest-sender.js';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import { getIsoWeekId } from '../storage/weekly-summary.js';
import type { TrendAnalyzer } from '../metrics/trend-analyzer.js';
import type { CollaborationProfiler } from '../metrics/collaboration-profile.js';
import type { ClaudeMdTracker } from '../metrics/claudemd-tracker.js';
import type { CostPerOutcomeAnalyzer } from '../metrics/cost-per-outcome.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { RecommendationEngine } from '../metrics/recommendation-engine.js';
import { PersonalCoach } from '../metrics/personal-coach.js';

function getNerdgraphUrl(collectorHost: string | null): string {
  if (collectorHost === 'eu') return 'https://api.eu.newrelic.com/graphql';
  return 'https://api.newrelic.com/graphql';
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SESSION_HISTORY_TOOL = {
  name: 'nr_observe_get_session_history',
  description:
    'Get a list of past sessions with summary metrics (efficiency, cost, tool calls, outcome).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      since: {
        type: 'string',
        description: 'ISO date string to filter sessions from (e.g., "2026-04-01")',
      },
      developer: {
        type: 'string',
        description: 'Filter by developer name',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of sessions to return (default: 20)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const WEEKLY_SUMMARY_TOOL = {
  name: 'nr_observe_get_weekly_summary',
  description:
    'Get a weekly summary report with per-developer breakdown, cost, efficiency, and anti-pattern counts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      week: {
        type: 'string',
        description: 'ISO week (e.g., "2026-W16") or "latest" for the most recent summary',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const TRENDS_TOOL = {
  name: 'nr_observe_get_trends',
  description:
    'Get trend data for a metric over time: weekly efficiency, cost, task success rate, or tool call counts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      metric: {
        type: 'string',
        description:
          'Metric to trend: "efficiency", "cost", "task_success", or "tool_calls" (default: "efficiency")',
      },
      developer: {
        type: 'string',
        description: 'Filter by developer name',
      },
      weeks: {
        type: 'number',
        description: 'Number of weeks to include (default: 8)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const COLLABORATION_PROFILE_TOOL = {
  name: 'nr_observe_get_collaboration_profile',
  description:
    "Get a developer's collaboration profile: specificity, autonomy, correction rate, task complexity, and classification.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      developer: {
        type: 'string',
        description: 'Developer name (default: current developer)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const CLAUDEMD_IMPACT_TOOL = {
  name: 'nr_observe_get_claudemd_impact',
  description:
    'Get the impact report for the most recent CLAUDE.md change: before/after comparison with deltas and verdict.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

export const COST_PER_OUTCOME_TOOL = {
  name: 'nr_observe_get_cost_per_outcome',
  description:
    'Get cost breakdown by outcome type (bug fix, feature, refactor, etc.) with waste ratio and ROI estimate.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      since: {
        type: 'string',
        description: 'ISO date string to filter from (e.g., "2026-04-01")',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const RECOMMENDATIONS_TOOL = {
  name: 'nr_observe_get_recommendations',
  description:
    'Get personalized optimization recommendations covering cost, efficiency, prompt engineering, CLAUDE.md impact, and model selection.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      developer: {
        type: 'string',
        description: 'Developer name (default: current developer)',
      },
      topN: {
        type: 'number',
        description: 'Maximum number of recommendations to return',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const PLATFORM_COMPARISON_TOOL = {
  name: 'nr_observe_get_platform_comparison',
  description:
    'Compare AI coding assistant platforms side-by-side on a given metric: efficiency, cost, task_success, tool_calls, or error_rate.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      metric: {
        type: 'string',
        description:
          'Metric to compare: "efficiency", "cost", "task_success", "tool_calls", or "error_rate" (default: "efficiency")',
      },
      weeks: {
        type: 'number',
        description: 'Number of weeks to include (default: 4)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const TEAM_SUMMARY_TOOL = {
  name: 'nr_observe_get_team_summary',
  description:
    'Get aggregated AI coding cost and efficiency metrics for all developers in the configured team, queried via New Relic NRQL. Requires teamId to be set in config.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      since: {
        type: 'string',
        description: 'Time window (e.g. "7 days ago", "1 day ago"). Default: "7 days ago".',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const SUBSCRIBE_DIGEST_TOOL = {
  name: 'nr_observe_subscribe_digest',
  description:
    'Register a Slack webhook URL to receive weekly AI coding cost and efficiency summaries.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      webhookUrl: {
        type: 'string',
        description: 'Slack incoming webhook URL (https://hooks.slack.com/...)',
      },
    },
    required: ['webhookUrl'],
  },
  annotations: { readOnlyHint: false },
};

export const UNSUBSCRIBE_DIGEST_TOOL = {
  name: 'nr_observe_unsubscribe_digest',
  description: 'Remove the registered Slack webhook for weekly digests.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: false },
};

export const SEND_DIGEST_TOOL = {
  name: 'nr_observe_send_digest',
  description:
    'Generate the current weekly AI coding summary and POST it to the configured Slack webhook immediately.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: false },
};

export const PERSONAL_INSIGHTS_TOOL = {
  name: 'nr_observe_get_personal_insights',
  description:
    "Returns a narrative coaching report comparing this week's personal AI coding metrics against your historical baseline. " +
    'Includes highlights, regressions, streaks, and a top recommendation. ' +
    'Requires at least 2 weeks of session history. ' +
    'Returns status: "insufficient_data" with a message when history is too sparse.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// All tool definitions (for conditional registration)
// ---------------------------------------------------------------------------

export const CROSS_SESSION_TOOLS = [
  SESSION_HISTORY_TOOL,
  WEEKLY_SUMMARY_TOOL,
  TRENDS_TOOL,
  COLLABORATION_PROFILE_TOOL,
  CLAUDEMD_IMPACT_TOOL,
  COST_PER_OUTCOME_TOOL,
  RECOMMENDATIONS_TOOL,
  PLATFORM_COMPARISON_TOOL,
  TEAM_SUMMARY_TOOL,
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function toFiniteNumber(x: unknown, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetSessionHistory(
  sessionStore: SessionStore,
  args: { since?: string; developer?: string; limit?: number },
) {
  const since = args.since ? new Date(args.since) : undefined;
  if (since && isNaN(since.getTime())) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid since date' }) }],
      isError: true,
    };
  }
  const developer = typeof args.developer === 'string' ? args.developer.slice(0, 256) : undefined;
  const sessions = sessionStore.loadAllSessions({
    since,
    developer,
  });

  const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 20), 500));
  const limited = sessions.slice(-limit);

  const result = limited.map((s) => ({
    session_id: s.sessionId,
    session_name: s.sessionName ?? null,
    developer: s.developer,
    start_time: new Date(s.startTime).toISOString(),
    duration_ms: s.durationMs,
    tool_calls: s.toolCallCount,
    efficiency_score: s.efficiencyScore,
    estimated_cost_usd: s.estimatedCostUsd,
    task_count: s.taskCount,
    outcome: s.outcome,
    model: s.model,
  }));

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ sessions: result, count: result.length }, null, 2),
      },
    ],
  };
}

export function handleGetWeeklySummary(
  weeklySummaryGenerator: WeeklySummaryGenerator,
  args: { week?: string },
) {
  if (!args.week || args.week === 'latest') {
    const latest = weeklySummaryGenerator.getLatest();
    if (!latest) {
      // Generate current week
      const currentWeek = getIsoWeekId(new Date());
      const generated = weeklySummaryGenerator.generate(currentWeek);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(generated, null, 2),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(latest, null, 2),
        },
      ],
    };
  }

  // N-03: validate week format before it reaches file-path construction
  if (!/^\d{4}-W\d{2}$/.test(args.week)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Invalid week format. Use YYYY-Wnn (e.g. "2026-W16") or "latest".',
          }),
        },
      ],
      isError: true,
    };
  }

  const summary = weeklySummaryGenerator.generate(args.week);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(summary, null, 2),
      },
    ],
  };
}

export function handleGetTrends(
  trendAnalyzer: TrendAnalyzer,
  args: { metric?: string; developer?: string; weeks?: number },
) {
  const weeks = Math.max(1, args.weeks ?? 8);
  const since = new Date(Date.now() - weeks * 7 * 86_400_000);

  const developer = typeof args.developer === 'string' ? args.developer.slice(0, 256) : undefined;
  const trends = trendAnalyzer.computeTrends({
    since,
    developer,
  });

  const metric = args.metric ?? 'efficiency';
  let data;
  switch (metric) {
    case 'cost':
      data = trends.weeklyCostTrend;
      break;
    case 'task_success':
      data = trends.weeklyTaskSuccessTrend;
      break;
    case 'tool_calls':
      data = trends.weeklyToolCallTrend;
      break;
    case 'efficiency':
    default:
      data = trends.weeklyEfficiencyTrend;
      break;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ metric, weeks, data_points: data }, null, 2),
      },
    ],
  };
}

export function handleGetCollaborationProfile(
  collaborationProfiler: CollaborationProfiler,
  args: { developer?: string },
) {
  const developer =
    typeof args.developer === 'string'
      ? args.developer.trim().slice(0, 256) || 'unknown'
      : 'unknown';
  const profile = collaborationProfiler.computeProfile(developer);
  const comparison = collaborationProfiler.compareToTeam(developer);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            developer: profile.developer,
            classification: profile.classification,
            dimensions: profile.dimensions,
            session_count: profile.sessionCount,
            team_comparison: comparison.deltas,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleGetClaudeMdImpact(claudeMdTracker: ClaudeMdTracker) {
  const changes = claudeMdTracker.getChanges();

  if (changes.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ message: 'No CLAUDE.md changes detected' }, null, 2),
        },
      ],
    };
  }

  const latestChange = changes[changes.length - 1]!;
  const impact = claudeMdTracker.computeImpact(latestChange.timestamp);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            change: {
              file: latestChange.filePath,
              type: latestChange.changeType,
              timestamp: new Date(latestChange.timestamp).toISOString(),
            },
            before: impact.beforeMetrics,
            after: impact.afterMetrics,
            deltas: impact.deltas,
            context_tokens: impact.contextTokensForClaudeMd,
            verdict: impact.verdict,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleGetCostPerOutcome(
  costPerOutcomeAnalyzer: CostPerOutcomeAnalyzer,
  taskDetector: TaskDetector,
  args: { since?: string },
) {
  let tasks = taskDetector.getCompletedTasks();

  const current = taskDetector.getCurrentTask();
  if (current) {
    tasks = [...tasks, current];
  }

  if (args.since) {
    const sinceMs = new Date(args.since).getTime();
    if (isNaN(sinceMs)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: `Invalid since date: "${args.since}"` }),
          },
        ],
        isError: true,
      };
    }
    tasks = tasks.filter((t) => t.startTime >= sinceMs);
  }

  const attribution = costPerOutcomeAnalyzer.attributeCosts(tasks);
  const roi = costPerOutcomeAnalyzer.estimateROI(attribution, 75); // default $75/hr

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            outcome_distribution: attribution.outcomeDistribution,
            waste_ratio: attribution.wasteRatio,
            total_cost: attribution.totalCost,
            total_tasks: attribution.totalTasks,
            roi_estimate: roi,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleGetRecommendations(
  recommendationEngine: RecommendationEngine,
  args: { developer?: string; topN?: number },
) {
  const developer =
    typeof args.developer === 'string'
      ? args.developer.trim().slice(0, 256) || 'unknown'
      : 'unknown';
  const recs = recommendationEngine.generateAllRecommendations(developer, {
    topN: args.topN,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ recommendations: recs, count: recs.length }, null, 2),
      },
    ],
  };
}

export function handleGetPlatformComparison(
  sessionStore: SessionStore,
  args: { metric?: string; weeks?: number },
) {
  const weeks = args.weeks ?? 4;
  const since = new Date(Date.now() - weeks * 7 * 86_400_000);
  const metric = args.metric ?? 'efficiency';

  const sessions = sessionStore.loadAllSessions({ since });

  // Group sessions by platform (uses 'claude-code' as default)
  const byPlatform = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const rawPlatform = (s as Record<string, unknown>).platform;
    const platform = typeof rawPlatform === 'string' ? rawPlatform : 'claude-code';
    const list = byPlatform.get(platform) ?? [];
    list.push(s);
    byPlatform.set(platform, list);
  }

  const comparison: Record<string, unknown> = {};

  for (const [platform, platformSessions] of byPlatform) {
    const count = platformSessions.length;
    if (count === 0) continue;

    let value: number;
    switch (metric) {
      case 'cost': {
        const total = platformSessions.reduce((sum, s) => sum + (s.estimatedCostUsd ?? 0), 0);
        value = Math.round((total / count) * 100) / 100;
        break;
      }
      case 'task_success': {
        const total = platformSessions.reduce((sum, s) => sum + (s.taskSuccessRate ?? 0), 0);
        value = Math.round((total / count) * 100) / 100;
        break;
      }
      case 'tool_calls': {
        const total = platformSessions.reduce((sum, s) => sum + (s.toolCallCount ?? 0), 0);
        value = Math.round(total / count);
        break;
      }
      case 'error_rate': {
        let weightedErrors = 0;
        let totalTc = 0;
        for (const s of platformSessions) {
          const tc = s.toolCallCount ?? 0;
          const errorRate = 1 - (s.toolSuccessRate ?? 1);
          weightedErrors += tc * errorRate;
          totalTc += tc;
        }
        value = totalTc > 0 ? Math.round((weightedErrors / totalTc) * 100) / 100 : 0;
        break;
      }
      case 'efficiency':
      default: {
        const total = platformSessions.reduce((sum, s) => sum + (s.efficiencyScore ?? 0), 0);
        value = Math.round((total / count) * 100) / 100;
        break;
      }
    }

    comparison[platform] = {
      session_count: count,
      average: value,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ metric, weeks, platforms: comparison }, null, 2),
      },
    ],
  };
}

export async function handleGetTeamSummary(options: {
  teamId: string | null;
  accountId: string;
  nrApiKey: string | null;
  collectorHost?: string | null;
  since?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!options.teamId) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'teamId is not configured. Set NEW_RELIC_AI_TEAM_ID or teamId in config.',
          }),
        },
      ],
      isError: true,
    };
  }

  if (!options.nrApiKey) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'NEW_RELIC_API_KEY (User key) is required for team summary queries.',
          }),
        },
      ],
      isError: true,
    };
  }

  // Validate `since` against a strict allowlist: "<N> <unit>(s) ago"
  const rawSince = options.since ?? '7 days ago';
  if (!/^\d+\s+(?:minute|hour|day|week)s?\s+ago$/i.test(rawSince)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error:
              'Invalid since value. Use a relative time like "7 days ago", "24 hours ago", or "1 week ago".',
          }),
        },
      ],
      isError: true,
    };
  }
  const since = rawSince;

  if (!/^[a-zA-Z0-9_-]+$/.test(options.teamId)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid teamId format. Allowed characters: a-z, A-Z, 0-9, underscore, hyphen.',
          }),
        },
      ],
      isError: true,
    };
  }
  const safeTeamId = options.teamId;

  const accountId = Number(options.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Invalid accountId: "${options.accountId}" is not a valid number`,
          }),
        },
      ],
      isError: true,
    };
  }

  const nerdgraphQuery = `query($accountId: Int!, $nrql: Nrql!) {
    actor { account(id: $accountId) { nrql(query: $nrql) { results } } }
  }`;

  const nerdgraphUrl = getNerdgraphUrl(options.collectorHost ?? null);

  async function runNrql(nrql: string): Promise<Array<Record<string, unknown>>> {
    const resp = await fetch(nerdgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': options.nrApiKey! },
      body: JSON.stringify({ query: nerdgraphQuery, variables: { accountId, nrql } }),
    });
    if (!resp.ok) {
      throw new Error(`NerdGraph request failed: HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as {
      data?: { actor: { account: { nrql: { results: unknown[] } } } };
      errors?: unknown[];
    };
    if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      const msg = (json.errors as Array<{ message?: unknown }>)
        .map((e) => String(e.message ?? e))
        .join('; ');
      throw new Error(`NerdGraph errors: ${msg}`);
    }
    if (!json.data?.actor?.account?.nrql?.results) {
      throw new Error('NerdGraph query returned no data (unexpected response structure)');
    }
    return json.data.actor.account.nrql.results as Array<Record<string, unknown>>;
  }

  let costRows: Array<Record<string, unknown>>;
  let effRows: Array<Record<string, unknown>>;
  let antiPatternRows: Array<Record<string, unknown>>;
  try {
    [costRows, effRows, antiPatternRows] = await Promise.all([
      runNrql(
        `SELECT sum(ai.estimated_cost_usd) AS totalCost
         FROM AiCodingTask WHERE team_id = '${safeTeamId}'
         SINCE ${since} FACET developer LIMIT 50`,
      ),
      runNrql(
        `SELECT average(ai.efficiency.score) AS avgScore
         FROM Metric WHERE team_id = '${safeTeamId}'
         SINCE ${since} FACET developer LIMIT 50`,
      ),
      runNrql(
        `SELECT count(*) AS antiPatterns
         FROM AiAntiPattern WHERE team_id = '${safeTeamId}'
         SINCE ${since} FACET developer LIMIT 50`,
      ),
    ]);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Failed to query New Relic: ${err instanceof Error ? err.message : String(err)}`,
          }),
        },
      ],
      isError: true,
    };
  }

  // Use Object.create(null) to prevent prototype-pollution if a developer name
  // is "__proto__", "constructor", or "toString".
  const byDev = Object.create(null) as Record<
    string,
    { costUsd: number; efficiencyScore: number | null; antiPatterns: number }
  >;
  for (const row of costRows) {
    const dev = ((row.developer && String(row.developer).trim()) || 'unknown') as string;
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    byDev[dev].costUsd = toFiniteNumber(row.totalCost);
  }
  for (const row of effRows) {
    const dev = ((row.developer && String(row.developer).trim()) || 'unknown') as string;
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    const score = toFiniteNumber(row.avgScore, Number.NaN);
    byDev[dev].efficiencyScore = Number.isFinite(score) ? score : null;
  }
  for (const row of antiPatternRows) {
    const dev = ((row.developer && String(row.developer).trim()) || 'unknown') as string;
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    byDev[dev].antiPatterns = toFiniteNumber(row.antiPatterns);
  }

  const result = {
    teamId: options.teamId,
    since,
    developers: Object.entries(byDev).map(([developer, stats]) => ({ developer, ...stats })),
    totals: {
      costUsd: Object.values(byDev).reduce((s, d) => s + d.costUsd, 0),
      developerCount: Object.keys(byDev).length,
    },
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export function handleSubscribeDigest(
  webhookUrl: string,
  configFilePath: string,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'webhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...)',
          }),
        },
      ],
      isError: true,
    };
  }
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no existing config */
    }
    existing.digestWebhookUrl = webhookUrl;
    writeFileSync(configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            message: 'Webhook registered. Digest will be sent on the configured schedule.',
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }
}

export function handleUnsubscribeDigest(configFilePath: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no existing config */
    }
    delete existing.digestWebhookUrl;
    writeFileSync(configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Webhook removed.' }) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }
}

export async function handleSendDigest(
  weeklySummaryGenerator: WeeklySummaryGenerator,
  configFilePath: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Read webhook URL from config file at call time (not in-memory config, which won't
  // reflect updates made via nr_observe_subscribe_digest without a server restart).
  let webhookUrl: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
    if (typeof raw.digestWebhookUrl === 'string') {
      webhookUrl = raw.digestWebhookUrl;
    }
  } catch {
    /* config file may not exist yet */
  }

  if (!webhookUrl) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'No webhook URL configured. Call nr_observe_subscribe_digest first.',
          }),
        },
      ],
    };
  }

  const currentWeek = getIsoWeekId(new Date());
  const summary = weeklySummaryGenerator.generate(currentWeek);
  const payload = formatSlackDigest(summary);

  try {
    await sendSlackDigest(webhookUrl, payload);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            week: currentWeek,
            message: 'Digest sent successfully.',
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Failed to send digest: ${err instanceof Error ? err.message : String(err)}`,
          }),
        },
      ],
    };
  }
}

export function handleGetPersonalInsights(
  summaryGenerator: WeeklySummaryGenerator,
  developer: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const coach = new PersonalCoach(summaryGenerator, developer);
  const result = coach.generate();
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

#!/usr/bin/env npx tsx
/**
 * Generate realistic demo telemetry for the Adoption & Cost dashboard.
 *
 * Emits the full Preflight event surface for a small simulated team:
 * AiToolCall (including hook-observed mcp__* calls and rejected/denied edits),
 * AiCodingTask, AiMcpToolCall (proxy shape), AiAntiPattern, and Metric gauges
 * (ai.cost.*, ai.git.*, ai.efficiency.score) with per-session cumulative
 * semantics matching what a live Preflight MCP server exports.
 *
 * The NR Event and Metric APIs drop data points older than 48 hours, so the
 * window is clamped to the last 47 hours. Run it daily (or on a schedule) to
 * accumulate longer history for the weekly Team Pulse widgets.
 *
 * Usage:
 *   NEW_RELIC_LICENSE_KEY=...NRAL NEW_RELIC_ACCOUNT_ID=12345 \
 *     npx tsx scripts/generate-demo-data.ts [--hours 46] [--seed 7] [--dry-run] [--eu | --staging]
 *
 * Requires an ingest license key (...NRAL), not a User API key.
 */

interface Persona {
  readonly developer: string;
  readonly platform: string;
  readonly project: string;
  readonly model: string;
  readonly sessionsPerDay: number;
  readonly tasksPerSession: number;
  readonly costPerTaskUsd: number;
  readonly cacheHitRate: number;
  readonly efficiencyBase: number;
  readonly prsPerSession: number;
  /** Share of tool calls that are hook-observed mcp__* calls. */
  readonly mcpShare: number;
  readonly mcpServers: readonly string[];
  /** Emits AiMcpToolCall proxy events when true. */
  readonly usesProxy: boolean;
  /** 0..1 position in the window after which this persona goes quiet. */
  readonly activeUntil: number;
}

const PERSONAS: readonly Persona[] = [
  {
    developer: 'sofia_reyes',
    platform: 'claude-code',
    project: 'checkout-service',
    model: 'claude-sonnet-5',
    sessionsPerDay: 4,
    tasksPerSession: 4,
    costPerTaskUsd: 3.4,
    cacheHitRate: 0.93,
    efficiencyBase: 0.82,
    prsPerSession: 1.4,
    mcpShare: 0.12,
    mcpServers: ['github', 'newrelic'],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'marcus_chen',
    platform: 'claude-code',
    project: 'billing-api',
    model: 'claude-haiku-4-5',
    sessionsPerDay: 2,
    tasksPerSession: 3,
    costPerTaskUsd: 0.7,
    cacheHitRate: 0.95,
    efficiencyBase: 0.9,
    prsPerSession: 1.1,
    mcpShare: 0.05,
    mcpServers: ['github'],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'devon_okafor',
    platform: 'cursor',
    project: 'web-frontend',
    model: 'claude-sonnet-5',
    sessionsPerDay: 2,
    tasksPerSession: 2,
    costPerTaskUsd: 1.6,
    cacheHitRate: 0.82,
    efficiencyBase: 0.71,
    prsPerSession: 0.6,
    mcpShare: 0,
    mcpServers: [],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'priya_sharma',
    platform: 'claude-code',
    project: 'checkout-service',
    model: 'claude-opus-5',
    sessionsPerDay: 3,
    tasksPerSession: 3,
    costPerTaskUsd: 2.3,
    cacheHitRate: 0.9,
    efficiencyBase: 0.78,
    prsPerSession: 0.9,
    mcpShare: 0.15,
    mcpServers: ['newrelic', 'playwright'],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'liam_gallagher',
    platform: 'claude-code',
    project: 'infra-tooling',
    model: 'claude-sonnet-5',
    sessionsPerDay: 2,
    tasksPerSession: 2,
    costPerTaskUsd: 1.9,
    cacheHitRate: 0.86,
    efficiencyBase: 0.74,
    prsPerSession: 0.7,
    mcpShare: 0,
    mcpServers: [],
    usesProxy: true,
    activeUntil: 1,
  },
  {
    developer: 'yuki_tanaka',
    platform: 'windsurf',
    project: 'web-frontend',
    model: 'claude-sonnet-5',
    sessionsPerDay: 1,
    tasksPerSession: 2,
    costPerTaskUsd: 1.1,
    cacheHitRate: 0.8,
    efficiencyBase: 0.68,
    prsPerSession: 0.5,
    mcpShare: 0,
    mcpServers: [],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'omar_haddad',
    platform: 'claude-code',
    project: 'billing-api',
    model: 'claude-opus-5',
    sessionsPerDay: 3,
    tasksPerSession: 3,
    costPerTaskUsd: 2.9,
    cacheHitRate: 0.88,
    efficiencyBase: 0.76,
    prsPerSession: 1.0,
    mcpShare: 0.08,
    mcpServers: ['github', 'slack'],
    usesProxy: true,
    activeUntil: 1,
  },
  {
    developer: 'elena_volkov',
    platform: 'claude-code',
    project: 'infra-tooling',
    model: 'claude-sonnet-5',
    sessionsPerDay: 2,
    tasksPerSession: 2,
    costPerTaskUsd: 1.8,
    cacheHitRate: 0.85,
    efficiencyBase: 0.72,
    prsPerSession: 0.8,
    mcpShare: 0.06,
    mcpServers: ['github'],
    usesProxy: false,
    activeUntil: 0.4,
  },
  {
    developer: 'raj_patel',
    platform: 'copilot',
    project: 'mobile-app',
    model: 'claude-haiku-4-5',
    sessionsPerDay: 1,
    tasksPerSession: 1,
    costPerTaskUsd: 0.5,
    cacheHitRate: 0.75,
    efficiencyBase: 0.65,
    prsPerSession: 0.3,
    mcpShare: 0,
    mcpServers: [],
    usesProxy: false,
    activeUntil: 1,
  },
  {
    developer: 'tessa_lindqvist',
    platform: 'claude-code',
    project: 'mobile-app',
    model: 'claude-sonnet-5',
    sessionsPerDay: 2,
    tasksPerSession: 3,
    costPerTaskUsd: 2.0,
    cacheHitRate: 0.89,
    efficiencyBase: 0.8,
    prsPerSession: 0.9,
    mcpShare: 0.1,
    mcpServers: ['github', 'playwright'],
    usesProxy: false,
    activeUntil: 1,
  },
];

const CORE_TOOLS: ReadonlyArray<readonly [string, number]> = [
  ['Read', 0.3],
  ['Bash', 0.2],
  ['Edit', 0.18],
  ['Grep', 0.09],
  ['Write', 0.07],
  ['Glob', 0.05],
  ['TodoWrite', 0.05],
  ['WebFetch', 0.03],
  ['Task', 0.03],
];

const MCP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  github: ['create_pull_request', 'get_pull_request', 'list_issues', 'merge_pull_request'],
  newrelic: ['execute_nrql_query', 'search_entities', 'get_alerts'],
  playwright: ['browser_navigate', 'browser_click', 'browser_snapshot'],
  slack: ['post_message', 'list_channels'],
};

const ANTI_PATTERN_TYPES = ['thrashing', 'repeated_reads', 'blind_edits', 'stuck_loop'] as const;

const TASK_OUTCOMES: ReadonlyArray<readonly [string, number]> = [
  ['feature', 0.3],
  ['refactor', 0.25],
  ['bug_fix', 0.2],
  ['investigation', 0.12],
  ['documentation', 0.05],
  ['configuration', 0.04],
  ['failed_attempt', 0.04],
];

const OUTCOME_COST_FACTOR: Readonly<Record<string, number>> = {
  feature: 1.3,
  refactor: 1.0,
  bug_fix: 0.9,
  investigation: 0.4,
  documentation: 0.3,
  configuration: 0.3,
  failed_attempt: 0.7,
};

type EventRow = Record<string, string | number | boolean>;

interface MetricRow {
  readonly name: string;
  readonly type: 'gauge';
  readonly value: number;
  readonly timestamp: number;
  readonly attributes: Record<string, string | number>;
}

// Deterministic RNG so reruns with the same seed produce the same shape.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface IngestEndpoints {
  readonly eventsHost: string;
  readonly metricsHost: string;
}

const REGIONS: Readonly<Record<string, IngestEndpoints>> = {
  us: {
    eventsHost: 'https://insights-collector.newrelic.com',
    metricsHost: 'https://metric-api.newrelic.com',
  },
  eu: {
    eventsHost: 'https://insights-collector.eu01.nr-data.net',
    metricsHost: 'https://metric-api.eu.newrelic.com',
  },
  staging: {
    eventsHost: 'https://staging-insights-collector.newrelic.com',
    metricsHost: 'https://staging-metric-api.newrelic.com',
  },
};

function parseArgs(): { hours: number; seed: number; dryRun: boolean; region: IngestEndpoints } {
  const args = process.argv.slice(2);
  const valueOf = (flag: string, fallback: number): number => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return fallback;
    const n = Number(args[i + 1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid value for ${flag}`);
    return n;
  };
  const region = args.includes('--staging') ? 'staging' : args.includes('--eu') ? 'eu' : 'us';
  return {
    hours: Math.min(valueOf('--hours', 46), 47),
    seed: valueOf('--seed', 7),
    dryRun: args.includes('--dry-run'),
    region: REGIONS[region],
  };
}

function main(): Promise<void> {
  const { hours, seed, dryRun, region } = parseArgs();
  const licenseKey = process.env.NEW_RELIC_LICENSE_KEY;
  const accountId = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!dryRun && (!licenseKey || !accountId)) {
    console.error('Set NEW_RELIC_LICENSE_KEY and NEW_RELIC_ACCOUNT_ID, or pass --dry-run.');
    process.exit(1);
  }

  const rand = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const weighted = (pairs: ReadonlyArray<readonly [string, number]>): string => {
    let r = rand();
    for (const [name, w] of pairs) {
      r -= w;
      if (r <= 0) return name;
    }
    return pairs[pairs.length - 1][0];
  };

  const now = Date.now();
  const windowStart = now - hours * 3600_000;
  const events: EventRow[] = [];
  const metrics: MetricRow[] = [];
  let sessionCounter = 0;

  for (const p of PERSONAS) {
    const sessionCount = Math.max(1, Math.round(p.sessionsPerDay * (hours / 24)));
    const quietAfter = windowStart + (now - windowStart) * p.activeUntil;

    for (let s = 0; s < sessionCount; s++) {
      const latestStart = Math.min(quietAfter, now - 30 * 60_000);
      if (latestStart <= windowStart) break;
      const sessionStart = windowStart + rand() * (latestStart - windowStart);
      const sessionMinutes = between(35, 170);
      const sessionEnd = Math.min(sessionStart + sessionMinutes * 60_000, now);
      sessionCounter += 1;
      const sessionId = `demo-${seed}-${p.developer}-${sessionCounter}`;
      const base = {
        developer: p.developer,
        platform: p.platform,
        app_name: p.platform,
        session_id: sessionId,
        project_id: p.project,
      };

      // --- AiToolCall stream -------------------------------------------------
      const callCount = Math.round(between(30, 130));
      for (let c = 0; c < callCount; c++) {
        const ts = sessionStart + ((sessionEnd - sessionStart) * c) / callCount;
        const isMcp = rand() < p.mcpShare && p.mcpServers.length > 0;
        let tool: string;
        if (isMcp) {
          const server = pick(p.mcpServers);
          tool = `mcp__${server}__${pick(MCP_TOOLS[server])}`;
        } else {
          tool = weighted(CORE_TOOLS);
        }

        let success = true;
        let errorType: string | undefined;
        const roll = rand();
        if ((tool === 'Edit' || tool === 'Write') && roll < 0.032) {
          success = false;
          errorType = roll < 0.02 ? 'rejected' : roll < 0.027 ? 'denied' : 'interrupted';
        } else if (roll < 0.055) {
          success = false;
          errorType = roll < 0.045 ? 'execution_error' : 'timeout';
        }

        events.push({
          eventType: 'AiToolCall',
          timestamp: Math.round(ts),
          tool,
          tool_use_id: `toolu_demo_${sessionCounter}_${c}`,
          success,
          duration_ms: Math.round(between(40, tool === 'Bash' ? 9000 : 2500)),
          ...(errorType !== undefined ? { error_type: errorType } : {}),
          ...base,
        });
      }

      // --- AiMcpToolCall (proxy shape) --------------------------------------
      if (p.usesProxy) {
        const proxyCalls = Math.round(between(8, 35));
        for (let c = 0; c < proxyCalls; c++) {
          const ts = sessionStart + rand() * (sessionEnd - sessionStart);
          const server = pick(['github', 'newrelic', 'slack'] as const);
          const upstream = between(30, 700);
          events.push({
            eventType: 'AiMcpToolCall',
            timestamp: Math.round(ts),
            server,
            tool: pick(MCP_TOOLS[server]),
            success: rand() > 0.03,
            duration_ms: Math.round(upstream + between(5, 60)),
            upstream_latency_ms: Math.round(upstream),
            developer: p.developer,
            app_name: p.platform,
            session_id: sessionId,
          });
        }
      }

      // --- AiCodingTask ------------------------------------------------------
      const taskCount = Math.max(1, Math.round(p.tasksPerSession * between(0.6, 1.4)));
      let sessionCost = 0;
      let sessionTokens = 0;
      for (let t = 0; t < taskCount; t++) {
        const tEnd = sessionStart + ((sessionEnd - sessionStart) * (t + 1)) / taskCount;
        const durationMs = Math.round((sessionEnd - sessionStart) / taskCount);
        // outcome_type and model mirror AiCodingTask's attribution fields;
        // cost and test results correlate with the outcome so the Model ×
        // Task Type widgets tell a coherent story.
        const outcome = weighted(TASK_OUTCOMES);
        const model =
          rand() < 0.15
            ? p.model === 'claude-haiku-4-5'
              ? 'claude-sonnet-5'
              : 'claude-haiku-4-5'
            : p.model;
        const cost = p.costPerTaskUsd * OUTCOME_COST_FACTOR[outcome] * between(0.4, 1.9);
        const tokens = Math.round(cost * between(140_000, 220_000));
        sessionCost += cost;
        sessionTokens += tokens;
        const testsRun =
          outcome === 'failed_attempt' || rand() < 0.7 ? Math.round(between(1, 40)) : 0;
        const testsPassed =
          outcome === 'failed_attempt'
            ? Math.round(testsRun * between(0, 0.6))
            : testsRun > 0
              ? Math.round(testsRun * (rand() < 0.85 ? 1 : between(0.5, 0.95)))
              : 0;
        const linesAdded = Math.round(between(8, 600));
        events.push({
          eventType: 'AiCodingTask',
          timestamp: Math.round(tEnd),
          task_id: `task-${sessionCounter}-${t}`,
          start_time: Math.round(tEnd - durationMs),
          end_time: Math.round(tEnd),
          duration_ms: durationMs,
          tool_call_count: Math.round(callCount / taskCount),
          files_read: Math.round(between(2, 25)),
          files_modified: Math.round(between(1, 9)),
          lines_added: linesAdded,
          lines_removed: Math.round(linesAdded * between(0.1, 0.7)),
          bash_commands_run: Math.round(between(1, 15)),
          tests_run: testsRun,
          tests_passed: testsPassed,
          estimated_cost_usd: Number(cost.toFixed(4)),
          cost_estimated: false,
          tokens_used: tokens,
          sub_agents_spawned: rand() < 0.25 ? Math.round(between(1, 4)) : 0,
          outcome_type: outcome,
          model,
          ...base,
        });

        metrics.push({
          name: 'ai.efficiency.score',
          type: 'gauge',
          value: Number(Math.min(0.98, p.efficiencyBase * between(0.85, 1.15)).toFixed(3)),
          timestamp: Math.round(tEnd),
          attributes: { developer: p.developer, session_id: sessionId },
        });
      }

      // --- AiAntiPattern -----------------------------------------------------
      if (rand() < 0.45) {
        events.push({
          eventType: 'AiAntiPattern',
          timestamp: Math.round(sessionStart + rand() * (sessionEnd - sessionStart)),
          type: pick(ANTI_PATTERN_TYPES),
          severity: rand() < 0.3 ? 'high' : 'medium',
          ...base,
        });
      }

      // --- Metric snapshots: cumulative per-session gauges -------------------
      // Mirrors a live server harvest: each snapshot re-emits the session's
      // running totals, which is why dashboard queries use max()/ratios.
      const snapshots = Math.max(3, Math.round(sessionMinutes / 10));
      const finalPrs = rand() < Math.min(1, p.prsPerSession) ? Math.round(between(1, 2.9)) : 0;
      const finalCommits = Math.round(taskCount * between(1, 3.2));
      let freshInput = 0;
      let output = 0;
      let thinking = 0;
      let cacheRead = 0;
      let cacheCreation = 0;
      for (let n = 1; n <= snapshots; n++) {
        const frac = n / snapshots;
        const ts = Math.round(sessionStart + (sessionEnd - sessionStart) * frac);
        const totalSoFar = sessionTokens * frac;
        cacheRead = Math.round(totalSoFar * p.cacheHitRate * 0.92);
        freshInput = Math.round(totalSoFar * (1 - p.cacheHitRate) * 0.7);
        output = Math.round(totalSoFar * 0.05);
        thinking = Math.round(totalSoFar * 0.02);
        cacheCreation = Math.round(totalSoFar * 0.03);
        const costAttrs = { developer: p.developer, session_id: sessionId, model: p.model };
        const gitAttrs = { developer: p.developer, session_id: sessionId };
        const costSoFar = Number((sessionCost * frac).toFixed(4));
        const rows: ReadonlyArray<readonly [string, number, Record<string, string | number>]> = [
          ['ai.cost.session_total_usd', costSoFar, costAttrs],
          ['ai.cost.tokens_input', freshInput, costAttrs],
          ['ai.cost.tokens_output', output, costAttrs],
          ['ai.cost.tokens_thinking', thinking, costAttrs],
          ['ai.cost.tokens_cache_read', cacheRead, costAttrs],
          ['ai.cost.tokens_cache_creation', cacheCreation, costAttrs],
          [
            'ai.cost.cache_savings_usd',
            Number((costSoFar * p.cacheHitRate * 2.4).toFixed(4)),
            costAttrs,
          ],
          ['ai.git.commit_count', Math.round(finalCommits * frac), gitAttrs],
          ['ai.git.push_count', Math.round(finalCommits * frac * 0.6), gitAttrs],
          ['ai.git.force_push_count', frac > 0.8 && rand() < 0.1 ? 1 : 0, gitAttrs],
          ['ai.git.pr_created', Math.round(finalPrs * frac), gitAttrs],
          [
            'ai.git.pr_merged',
            frac > 0.6 ? Math.max(0, Math.round(finalPrs * frac) - 1) : 0,
            gitAttrs,
          ],
        ];
        for (const [name, value, attributes] of rows) {
          metrics.push({ name, type: 'gauge', value, timestamp: ts, attributes });
        }
      }
    }
  }

  return send(events, metrics, { licenseKey, accountId, dryRun, region });
}

async function send(
  events: EventRow[],
  metrics: MetricRow[],
  opts: { licenseKey?: string; accountId?: string; dryRun: boolean; region: IngestEndpoints },
): Promise<void> {
  const byType = new Map<string, number>();
  for (const e of events) {
    const t = String(e.eventType);
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  console.error('Generated:');
  for (const [t, n] of [...byType.entries()].sort()) console.error(`  ${t}: ${n}`);
  console.error(`  Metric data points: ${metrics.length}`);

  if (opts.dryRun) {
    console.error('\nDry run — nothing sent. Samples:');
    console.error(JSON.stringify(events[0], null, 2));
    console.error(JSON.stringify(metrics[0], null, 2));
    return;
  }

  const post = async (url: string, body: unknown): Promise<void> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': opts.licenseKey as string },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status}: ${await res.text()}`);
    }
  };

  const BATCH = 1000;
  for (let i = 0; i < events.length; i += BATCH) {
    await post(
      `${opts.region.eventsHost}/v1/accounts/${opts.accountId}/events`,
      events.slice(i, i + BATCH),
    );
  }
  console.error(`Sent ${events.length} events.`);
  for (let i = 0; i < metrics.length; i += BATCH) {
    await post(`${opts.region.metricsHost}/metric/v1`, [{ metrics: metrics.slice(i, i + BATCH) }]);
  }
  console.error(`Sent ${metrics.length} metric data points.`);
  console.error('\nData is queryable within a minute or two. Widgets with 7d/30d windows fill');
  console.error('immediately; weekly Team Pulse trends accumulate as you re-run on later days.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

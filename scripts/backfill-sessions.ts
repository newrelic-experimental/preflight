#!/usr/bin/env npx tsx
/**
 * Backfill local session history from New Relic telemetry data.
 *
 * Sessions are reconstructed from AiToolCall, AiCodingTask, AiAntiPattern,
 * and Metric events already in New Relic, then written to
 * ~/.newrelic-preflight/sessions/ in the same format the MCP server produces at
 * shutdown. Weekly summary files are regenerated for all affected weeks.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
 *     npx tsx scripts/backfill-sessions.ts --developer <name> [--days 90] [--dry-run]
 *
 * Requires a New Relic User API key (NRAK-...), not a license key.
 *
 * Note: filesRead / filesModified and token breakdowns cannot be recovered
 * from NR event data and are left empty. All fields used by PersonalCoach
 * (efficiencyScore, estimatedCostUsd, antiPatterns, taskCount, toolBreakdown)
 * are fully recoverable.
 */

import 'dotenv/config';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, buildSessionSummary } from '../src/storage/session-store.js';
import {
  WeeklySummaryGenerator,
  getIsoWeekId,
  getWeekDateRange,
} from '../src/storage/weekly-summary.js';
import type { FullSessionSummary } from '../src/storage/session-store.js';
import { normalizeDeveloperName } from '../src/config.js';

const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

// ---------------------------------------------------------------------------
// Minimal NerdGraph NRQL client
// ---------------------------------------------------------------------------

const NRQL_QUERY = `query NrqlQuery($accountId: Int!, $query: Nrql!) {
  actor {
    account(id: $accountId) {
      nrql(query: $query) {
        results
      }
    }
  }
}`;

interface NrqlResponse {
  data?: { actor: { account: { nrql: { results: Record<string, unknown>[] } } } };
  errors?: Array<{ message: string }>;
}

async function runNrql(
  apiKey: string,
  accountId: number,
  query: string,
): Promise<Record<string, unknown>[]> {
  const resp = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify({ query: NRQL_QUERY, variables: { accountId, query } }),
  });
  if (!resp.ok) throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as NrqlResponse;
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data!.actor.account.nrql.results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const devIdx = args.indexOf('--developer');
  const developerRaw = devIdx !== -1 ? (args[devIdx + 1] ?? null) : null;
  if (!developerRaw) {
    console.error('Error: --developer <name> is required.');
    process.exit(1);
  }
  const developer = normalizeDeveloperName(developerRaw);

  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? '90', 10) : 90;
  if (Number.isNaN(days) || days < 1) {
    console.error('Error: --days must be a positive integer.');
    process.exit(1);
  }

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required.');
    process.exit(1);
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number. Got: "${accountIdStr}"`);
    process.exit(1);
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    console.error(
      'Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key).',
    );
    process.exit(1);
  }

  const storagePath = join(homedir(), '.newrelic-preflight');
  const sessionStore = new SessionStore({ storagePath });
  const weeklySummaryGenerator = new WeeklySummaryGenerator({ storagePath, sessionStore });

  const since = `${days} days ago`;
  const devFilter = `developer = '${developer}'`;

  process.stdout.write(
    `Backfilling sessions for developer "${developer}" over last ${days} days...\n\n`,
  );

  // Step 1: Session IDs per ISO week.
  // NR's `timestamp` field cannot be used with aggregation functions (min/max/earliest/latest),
  // so we loop over each ISO week in the lookback window using SINCE/UNTIL date bounds instead.
  // startTime is set to Monday of the session's week — accurate enough for weekly bucketing.
  process.stdout.write('  [1/6] Fetching sessions by week...\n');

  const nowMs = Date.now();
  const lookbackMs = days * 24 * 60 * 60 * 1000;
  const seenWeekIds = new Set<string>();
  const weekRanges: Array<{
    weekId: string;
    startMs: number;
    endMs: number;
    sinceStr: string;
    untilStr: string;
  }> = [];
  for (let t = nowMs; t >= nowMs - lookbackMs; t -= 7 * 24 * 60 * 60 * 1000) {
    const weekId = getIsoWeekId(new Date(t));
    if (seenWeekIds.has(weekId)) continue;
    seenWeekIds.add(weekId);
    const { start, end } = getWeekDateRange(weekId);
    weekRanges.push({
      weekId,
      startMs: start.getTime(),
      endMs: end.getTime(),
      sinceStr: start.toISOString().slice(0, 10),
      untilStr: end.toISOString().slice(0, 10),
    });
  }
  weekRanges.sort((a, b) => a.startMs - b.startMs);

  type BaseInfo = { sessionId: string; startTime: number; endTime: number; toolCallCount: number };
  const sessionMap = new Map<string, BaseInfo>();
  for (const week of weekRanges) {
    const rows = await runNrql(
      apiKey,
      accountId,
      `SELECT count(*) AS toolCallCount FROM AiToolCall WHERE ${devFilter} ` +
        `SINCE '${week.sinceStr}' UNTIL '${week.untilStr}' FACET session_id LIMIT MAX`,
    );
    for (const row of rows) {
      const sessionId = String(row['session_id'] ?? '');
      if (!sessionId || sessionMap.has(sessionId)) continue;
      sessionMap.set(sessionId, {
        sessionId,
        startTime: week.startMs,
        endTime: week.endMs,
        toolCallCount: Number(row['toolCallCount'] ?? 0),
      });
    }
  }

  if (sessionMap.size === 0) {
    process.stdout.write('No sessions found in New Relic for this developer and time range.\n');
    return;
  }
  process.stdout.write(
    `  Found ${sessionMap.size} sessions across ${weekRanges.length} week(s).\n\n`,
  );

  // Step 2: Tool breakdown per session
  process.stdout.write('  [2/6] Fetching tool breakdowns...\n');
  const toolRows = await runNrql(
    apiKey,
    accountId,
    `SELECT count(*) AS toolCount FROM AiToolCall WHERE ${devFilter} ` +
      `SINCE ${since} FACET session_id, tool LIMIT MAX`,
  );
  const toolBreakdowns = new Map<string, Record<string, number>>();
  for (const row of toolRows) {
    const sessionId = String(row['session_id'] ?? '');
    const tool = String(row['tool'] ?? '');
    if (!sessionId || !tool) continue;
    const bd = toolBreakdowns.get(sessionId) ?? (Object.create(null) as Record<string, number>);
    bd[tool] = (bd[tool] ?? 0) + Number(row['toolCount'] ?? 0);
    toolBreakdowns.set(sessionId, bd);
  }

  // Step 3: Tool success rates per session
  process.stdout.write('  [3/6] Fetching tool success rates...\n');
  const successRows = await runNrql(
    apiKey,
    accountId,
    `SELECT filter(count(*), WHERE success = true) AS successCount, count(*) AS totalCount ` +
      `FROM AiToolCall WHERE ${devFilter} SINCE ${since} FACET session_id LIMIT MAX`,
  );
  const successRates = new Map<string, number>();
  for (const row of successRows) {
    const sessionId = String(row['session_id'] ?? '');
    const total = Number(row['totalCount'] ?? 0);
    if (!sessionId || total === 0) continue;
    successRates.set(sessionId, Number(row['successCount'] ?? 0) / total);
  }

  // Step 4: Task aggregates per session
  process.stdout.write('  [4/6] Fetching task aggregates...\n');
  const taskRows = await runNrql(
    apiKey,
    accountId,
    `SELECT uniqueCount(task_id) AS taskCount, ` +
      `sum(estimated_cost_usd) AS estimatedCostUsd, ` +
      `sum(lines_added) AS linesAdded, sum(lines_removed) AS linesRemoved, ` +
      `sum(bash_commands_run) AS bashCommandCount, ` +
      `sum(tests_run) AS testRunCount, sum(tests_passed) AS testPassCount, ` +
      `sum(build_run) AS buildRunCount, sum(build_passed) AS buildPassCount ` +
      `FROM AiCodingTask WHERE ${devFilter} SINCE ${since} FACET session_id LIMIT MAX`,
  );
  type TaskAgg = {
    estimatedCostUsd: number;
    taskCount: number;
    linesAdded: number;
    linesRemoved: number;
    bashCommandCount: number;
    testRunCount: number;
    testPassCount: number;
    buildRunCount: number;
    buildPassCount: number;
  };
  const taskAggregates = new Map<string, TaskAgg>();
  for (const row of taskRows) {
    const sessionId = String(row['session_id'] ?? '');
    if (!sessionId) continue;
    taskAggregates.set(sessionId, {
      estimatedCostUsd: Number(row['estimatedCostUsd'] ?? 0),
      taskCount: Number(row['taskCount'] ?? 0),
      linesAdded: Number(row['linesAdded'] ?? 0),
      linesRemoved: Number(row['linesRemoved'] ?? 0),
      bashCommandCount: Number(row['bashCommandCount'] ?? 0),
      testRunCount: Number(row['testRunCount'] ?? 0),
      testPassCount: Number(row['testPassCount'] ?? 0),
      buildRunCount: Number(row['buildRunCount'] ?? 0),
      buildPassCount: Number(row['buildPassCount'] ?? 0),
    });
  }

  // Step 5: Anti-patterns per session
  process.stdout.write('  [5/6] Fetching anti-patterns...\n');
  const antiPatternRows = await runNrql(
    apiKey,
    accountId,
    `SELECT count(*) AS patternCount FROM AiAntiPattern WHERE ${devFilter} ` +
      `SINCE ${since} FACET session_id, type LIMIT MAX`,
  );
  const antiPatterns = new Map<string, Array<{ type: string; count: number }>>();
  for (const row of antiPatternRows) {
    const sessionId = String(row['session_id'] ?? '');
    const type = String(row['type'] ?? '');
    if (!sessionId || !type) continue;
    const list = antiPatterns.get(sessionId) ?? [];
    list.push({ type, count: Number(row['patternCount'] ?? 0) });
    antiPatterns.set(sessionId, list);
  }

  // Step 6: Efficiency score from Metric
  process.stdout.write('  [6/6] Fetching efficiency scores from Metric...\n');
  const efficiencyRows = await runNrql(
    apiKey,
    accountId,
    `FROM Metric SELECT average(ai.efficiency.score) AS efficiencyScore ` +
      `WHERE ${devFilter} SINCE ${since} FACET session_id LIMIT MAX`,
  );
  const efficiencyScores = new Map<string, number>();
  for (const row of efficiencyRows) {
    const sessionId = String(row['session_id'] ?? '');
    const score = Number(row['efficiencyScore']);
    if (!sessionId || Number.isNaN(score)) continue;
    efficiencyScores.set(sessionId, score);
  }

  // ---------------------------------------------------------------------------
  // Build and save FullSessionSummary for each session
  // ---------------------------------------------------------------------------
  process.stdout.write('\n');
  const affectedWeeks = new Set<string>();
  let saved = 0;
  let skipped = 0;

  for (const [sessionId, base] of sessionMap) {
    // Skip sessions that were already persisted locally (e.g. from after the fix)
    if (sessionStore.loadSession(sessionId) !== null) {
      skipped++;
      continue;
    }

    const tasks = taskAggregates.get(sessionId);
    const estimatedCostUsd = tasks?.estimatedCostUsd ?? null;
    const testRunCount = tasks?.testRunCount ?? 0;
    const testPassCount = tasks?.testPassCount ?? 0;

    const summary: FullSessionSummary = {
      sessionId,
      startTime: base.startTime,
      endTime: base.endTime,
      durationMs: base.endTime - base.startTime,
      toolCallCount: base.toolCallCount,
      developer,
      model: null,
      toolBreakdown: toolBreakdowns.get(sessionId) ?? {},
      filesRead: [], // not recoverable from NR event data
      filesModified: [], // not recoverable from NR event data
      linesAdded: tasks?.linesAdded ?? 0,
      linesRemoved: tasks?.linesRemoved ?? 0,
      bashCommandCount: tasks?.bashCommandCount ?? 0,
      testRunCount,
      testPassCount,
      buildRunCount: tasks?.buildRunCount ?? 0,
      buildPassCount: tasks?.buildPassCount ?? 0,
      estimatedCostUsd: typeof estimatedCostUsd === 'number' ? estimatedCostUsd : null,
      tokensInput: 0, // not recoverable from NR event data
      tokensOutput: 0,
      tokensThinking: 0,
      efficiencyScore: efficiencyScores.get(sessionId) ?? null,
      antiPatterns: antiPatterns.get(sessionId) ?? [],
      taskCount: tasks?.taskCount ?? 0,
      taskSuccessRate: testRunCount > 0 ? testPassCount / testRunCount : null,
      toolSuccessRate: successRates.get(sessionId) ?? null,
      contextCompressions: 0,
      agentSpawns: 0,
      userMessages: 0,
      assistantMessages: 0,
      userCorrections: 0,
      outcome: 'completed',
    };

    const weekId = getIsoWeekId(new Date(base.startTime));
    affectedWeeks.add(weekId);

    if (dryRun) {
      process.stdout.write(
        `  [dry-run] ${sessionId.slice(0, 8)}… ` +
          `${new Date(base.startTime).toISOString().slice(0, 10)} ` +
          `week=${weekId}  tools=${base.toolCallCount}  ` +
          `cost=$${(typeof estimatedCostUsd === 'number' ? estimatedCostUsd : 0).toFixed(4)}  ` +
          `eff=${efficiencyScores.get(sessionId)?.toFixed(1) ?? 'n/a'}\n`,
      );
    } else {
      sessionStore.saveSession(summary);
    }
    saved++;
  }

  process.stdout.write(
    `\n${dryRun ? '[dry-run] Would save' : 'Saved'} ${saved} session(s). ` +
      `Skipped ${skipped} already-present.\n`,
  );

  if (!dryRun && saved > 0) {
    process.stdout.write(`\nGenerating weekly summaries for ${affectedWeeks.size} week(s)...\n`);
    for (const weekId of [...affectedWeeks].sort()) {
      try {
        const summary = weeklySummaryGenerator.generate(weekId);
        process.stdout.write(
          `  ${weekId}: ${summary.sessionCount} sessions, ` +
            `$${summary.totalCostUsd.toFixed(4)} total, ` +
            `avg efficiency ${summary.avgEfficiencyScore?.toFixed(1) ?? 'n/a'}\n`,
        );
      } catch (err) {
        process.stdout.write(
          `  ${weekId}: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    process.stdout.write(
      '\nDone. Run nr_observe_get_personal_insights to see your coaching report.\n',
    );
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

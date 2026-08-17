#!/usr/bin/env npx tsx
/**
 * Compare Preflight's tracked cost/tokens for a CLAUDE CODE session against
 * ccusage's independent re-parse of the same session's raw .jsonl transcript.
 *
 * Claude Code only. This is verified only for sessions Preflight tracked via
 * its claude-code platform adapter, because the comparison depends on both
 * tools reading the exact same underlying transcript under the exact same
 * session id — true for Claude Code (ccusage's `claude` reader parses
 * `~/.claude/projects/**\/*.jsonl`, the same file Preflight's session id
 * resolves to), unverified for anything else. Preflight also supports
 * Codex CLI and Gemini CLI sessions (ccusage has readers for both too), but
 * nobody has confirmed the two tools' session-id schemes actually line up
 * for those — this script warns rather than silently producing misleading
 * deltas if it's pointed at a non-claude-code session.
 *
 * Decomposes any $ gap into two independently-checkable causes by re-pricing
 * ccusage's raw token counts through Preflight's own pricing table:
 *
 *   - repricedUsd ≈ preflightCostUsd, far from ccusageCostUsd
 *       → pricing-table mismatch (same tokens, different $/Mtok rates)
 *   - repricedUsd ≈ ccusageCostUsd, far from preflightCostUsd
 *       → token-capture mismatch (Preflight is missing/undercounting tokens
 *         that the transcript actually contains)
 *   - repricedUsd matches neither
 *       → both are contributing
 *
 * Usage:
 *   npx tsx scripts/compare-cost-with-ccusage-claude-code.ts --session-id <id> [--json]
 *   npx tsx scripts/compare-cost-with-ccusage-claude-code.ts --session-id <id> \
 *     --preflight-cost-json <path>   # for a still-live session: save the
 *                                    # output of nr_observe_get_cost_breakdown
 *                                    # to a file and point at it here, since a
 *                                    # live session has no persisted file yet
 *
 * Requires `npx ccusage` to be resolvable (installs on first run if absent).
 * Reads only local files already on disk — no network calls, no NR ingest.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { SessionStore } from '../src/storage/session-store.js';
import { calculateCost } from '../src/shared/pricing.js';
import type { TokenUsage } from '../src/shared/tokens.js';

interface CcusageEntry {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUSD: number;
}

interface CcusageSessionReport {
  readonly sessionId: string;
  readonly totalCost: number;
  readonly totalTokens: number;
  readonly entries: CcusageEntry[];
}

// Shape of nr_observe_get_cost_breakdown's MCP tool response — accepted via
// --preflight-cost-json as an alternative source for a still-live session.
interface PreflightCostJson {
  readonly total_usd: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly thinking: number;
    readonly cache_read: number;
    readonly cache_creation: number;
  };
}

interface PreflightTotals {
  readonly costUsd: number;
  readonly input: number;
  readonly output: number;
  readonly thinking: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  /**
   * Undefined when loaded via --preflight-cost-json (that MCP tool response
   * carries no platform field) or for a pre-fix session file predating it —
   * in both cases we simply can't warn, not a signal the session is fine.
   */
  readonly platform: string | undefined;
}

function parseArgs(argv: string[]): {
  sessionId: string | null;
  json: boolean;
  preflightCostJsonPath: string | null;
  storagePath: string | undefined;
} {
  let sessionId: string | null = null;
  let json = false;
  let preflightCostJsonPath: string | null = null;
  let storagePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session-id') sessionId = argv[++i] ?? null;
    else if (arg === '--json') json = true;
    else if (arg === '--preflight-cost-json') preflightCostJsonPath = argv[++i] ?? null;
    else if (arg === '--storage-path') storagePath = argv[++i];
  }

  return { sessionId, json, preflightCostJsonPath, storagePath };
}

function runCcusage(sessionId: string): CcusageSessionReport {
  const raw = execFileSync(
    'npx',
    ['--yes', 'ccusage@latest', 'session', '--id', sessionId, '--json'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(raw) as CcusageSessionReport;
}

function loadPreflightTotals(
  sessionId: string,
  storagePath: string | undefined,
  preflightCostJsonPath: string | null,
): PreflightTotals {
  if (preflightCostJsonPath) {
    const parsed = JSON.parse(readFileSync(preflightCostJsonPath, 'utf-8')) as PreflightCostJson;
    return {
      costUsd: parsed.total_usd,
      input: parsed.tokens.input,
      output: parsed.tokens.output,
      thinking: parsed.tokens.thinking,
      cacheRead: parsed.tokens.cache_read,
      cacheCreation: parsed.tokens.cache_creation,
      platform: undefined,
    };
  }

  const store = new SessionStore({
    storagePath: storagePath ?? `${process.env.HOME}/.newrelic-preflight`,
  });
  const summary = store.loadSession(sessionId);
  if (!summary) {
    throw new Error(
      `No persisted Preflight session file found for ${sessionId}. ` +
        `Either the session hasn't ended yet (pass --preflight-cost-json with the ` +
        `output of nr_observe_get_cost_breakdown instead), or it's under a ` +
        `different --storage-path.`,
    );
  }
  return {
    costUsd: summary.estimatedCostUsd ?? 0,
    input: summary.tokensInput,
    output: summary.tokensOutput,
    thinking: summary.tokensThinking,
    cacheRead: summary.tokensCacheRead,
    cacheCreation: summary.tokensCacheCreation,
    platform: summary.platform,
  };
}

function sumCcusageTokens(
  entries: CcusageEntry[],
): Omit<TokenUsage, 'totalTokens' | 'thinkingTokens'> {
  return entries.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + e.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + e.cacheCreationTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
}

// Re-prices ccusage's raw token counts through Preflight's own pricing table,
// grouped by model since different entries in one session can carry
// different model ids (e.g. a mid-session upgrade).
function repriceThroughPreflightTable(entries: CcusageEntry[]): number {
  const byModel = new Map<string, CcusageEntry[]>();
  for (const e of entries) {
    const list = byModel.get(e.model) ?? [];
    list.push(e);
    byModel.set(e.model, list);
  }

  let total = 0;
  for (const [model, modelEntries] of byModel) {
    const tokens = sumCcusageTokens(modelEntries);
    const usage: TokenUsage = {
      ...tokens,
      thinkingTokens: 0, // ccusage entries carry no thinking-token split
      totalTokens: tokens.inputTokens + tokens.outputTokens,
    };
    total += calculateCost(model, usage).totalUsd;
  }
  return total;
}

function pctDelta(a: number, b: number): string {
  if (b === 0) return a === 0 ? '0%' : '∞';
  return `${(((a - b) / b) * 100).toFixed(1)}%`;
}

function main(): void {
  const { sessionId, json, preflightCostJsonPath, storagePath } = parseArgs(process.argv.slice(2));
  if (!sessionId) {
    console.error(
      'Usage: compare-cost-with-ccusage-claude-code.ts --session-id <id> [--json] ' +
        '[--preflight-cost-json <path>] [--storage-path <path>]',
    );
    process.exit(1);
  }

  const preflight = loadPreflightTotals(sessionId, storagePath, preflightCostJsonPath);
  if (preflight.platform !== undefined && preflight.platform !== 'claude-code') {
    console.error(
      `WARNING: this session was tracked via Preflight's "${preflight.platform}" platform ` +
        `adapter, not claude-code. This script's ccusage comparison is only verified for ` +
        `Claude Code sessions — ccusage may have no reader for this platform at all, in ` +
        `which case the deltas below are meaningless (comparing real Preflight totals ` +
        `against an empty/unrelated ccusage result), not evidence of a real gap.\n`,
    );
  }

  const ccusage = runCcusage(sessionId);
  const ccusageTokens = sumCcusageTokens(ccusage.entries);
  const repricedUsd = repriceThroughPreflightTable(ccusage.entries);

  const report = {
    sessionId,
    tokens: {
      input: {
        preflight: preflight.input,
        ccusage: ccusageTokens.inputTokens,
        delta: pctDelta(preflight.input, ccusageTokens.inputTokens),
      },
      output: {
        preflight: preflight.output,
        ccusage: ccusageTokens.outputTokens,
        delta: pctDelta(preflight.output, ccusageTokens.outputTokens),
      },
      cacheRead: {
        preflight: preflight.cacheRead,
        ccusage: ccusageTokens.cacheReadTokens,
        delta: pctDelta(preflight.cacheRead, ccusageTokens.cacheReadTokens),
      },
      cacheCreation: {
        preflight: preflight.cacheCreation,
        ccusage: ccusageTokens.cacheCreationTokens,
        delta: pctDelta(preflight.cacheCreation, ccusageTokens.cacheCreationTokens),
      },
      thinking_preflightOnly: preflight.thinking, // ccusage reports no thinking-token split; not comparable
    },
    cost: {
      preflightReportedUsd: preflight.costUsd,
      ccusageReportedUsd: ccusage.totalCost,
      preflightTableAppliedToCcusageTokensUsd: repricedUsd,
    },
    diagnosis: {
      matchesPricingTableHypothesis:
        Math.abs(repricedUsd - preflight.costUsd) < Math.abs(repricedUsd - ccusage.totalCost),
      note:
        'If preflightTableAppliedToCcusageTokensUsd is close to preflightReportedUsd, the ' +
        'gap is a pricing-table rate difference (same tokens, different $/Mtok). If it is ' +
        'close to ccusageReportedUsd instead, the gap is token-capture (Preflight is missing ' +
        'tokens the transcript actually contains — check subagent/parent transcript coverage).',
    },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nSession ${sessionId}`);
  console.log('─'.repeat(60));
  console.log('Token counts (Preflight vs ccusage):');
  for (const [label, v] of Object.entries(report.tokens)) {
    if (label === 'thinking_preflightOnly') {
      console.log(`  thinking (Preflight-only, no ccusage split): ${v}`);
      continue;
    }
    const t = v as { preflight: number; ccusage: number; delta: string };
    console.log(
      `  ${label.padEnd(14)} preflight=${t.preflight}  ccusage=${t.ccusage}  delta=${t.delta}`,
    );
  }
  console.log('\nCost:');
  console.log(
    `  Preflight reported:                       $${report.cost.preflightReportedUsd.toFixed(4)}`,
  );
  console.log(
    `  ccusage reported:                         $${report.cost.ccusageReportedUsd.toFixed(4)}`,
  );
  console.log(
    `  Preflight pricing × ccusage's tokens:      $${report.cost.preflightTableAppliedToCcusageTokensUsd.toFixed(4)}`,
  );
  console.log(`\n${report.diagnosis.note}`);
  console.log(
    report.diagnosis.matchesPricingTableHypothesis
      ? '  → Looks like a PRICING-TABLE gap.'
      : '  → Looks like a TOKEN-CAPTURE gap.',
  );
}

main();

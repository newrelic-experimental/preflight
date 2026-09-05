import { describe, it, expect } from '@jest/globals';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { localDateKey } from '../lib/date.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}`,
    sessionName: 'my-project',
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    model: 'claude-sonnet-4-20250514',
    toolBreakdown: {},
    filesRead: [],
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandCount: 0,
    testRunCount: 0,
    testPassCount: 0,
    buildRunCount: 0,
    buildPassCount: 0,
    estimatedCostUsd: 56.02,
    subagentCostUsd: 12.5,
    tokensInput: 143_758,
    tokensOutput: 383_743,
    tokensThinking: 0,
    tokensCacheRead: 171_800_083,
    tokensCacheCreation: 3_409_635,
    cacheSavingsUsd: 4.2,
    efficiencyScore: null,
    toolSelectionMetrics: null,
    modelBreakdown: {
      'claude-sonnet-5': {
        requestCount: 44,
        totalInputTokens: 143_758,
        totalOutputTokens: 383_743,
        totalCostUsd: 56.02,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    },
    costByWorkflowRunId: { wf_abc: { [localDateKey()]: 12.5 } },
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 1,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

describe('buildCostTrackerSeed', () => {
  it('maps every FullSessionSummary field onto the seed correctly, entirely-today session', () => {
    const summary = makeSummary();
    const seed = buildCostTrackerSeed(summary);

    expect(seed.totalCostUsd).toBe(56.02);
    expect(seed.subagentCostUsd).toBe(12.5);
    expect(seed.parentCostUsd).toBeCloseTo(43.52, 6); // 56.02 - 12.5
    expect(seed.totalInputTokens).toBe(143_758);
    expect(seed.totalOutputTokens).toBe(383_743);
    expect(seed.totalThinkingTokens).toBe(0);
    expect(seed.totalCacheReadTokens).toBe(171_800_083);
    expect(seed.totalCacheCreationTokens).toBe(3_409_635);
    expect(seed.totalCacheSavingsUsd).toBe(4.2);
    expect(seed.costByModel).toEqual({ 'claude-sonnet-5': 56.02 });
    expect(seed.costByWorkflowRunId).toEqual({ wf_abc: { [localDateKey()]: 12.5 } });
    expect(seed.dayKey).toBe(localDateKey());
    // Session is entirely within today (startTime/endTime both `now`-relative),
    // so todayPortionRatio is exactly 1 — the full totals book to today.
    expect(seed.dayCostUsd).toBeCloseTo(56.02, 6);
    expect(seed.daySubagentCostUsd).toBeCloseTo(12.5, 6);
  });

  it('derives parentCostUsd as totalCostUsd minus subagentCostUsd, not a separate field', () => {
    const seed = buildCostTrackerSeed(makeSummary({ estimatedCostUsd: 10, subagentCostUsd: 3 }));
    expect(seed.parentCostUsd).toBeCloseTo(7, 6);
  });

  it('defaults totalCostUsd to 0 when estimatedCostUsd is null', () => {
    const seed = buildCostTrackerSeed(makeSummary({ estimatedCostUsd: null, subagentCostUsd: 0 }));
    expect(seed.totalCostUsd).toBe(0);
    expect(seed.parentCostUsd).toBe(0);
  });

  it('passes costByWorkflowRunId through unchanged', () => {
    const raw = { wf_x: { [localDateKey()]: 1.1 }, wf_y: { [localDateKey()]: 2.2 } };
    const seed = buildCostTrackerSeed(makeSummary({ costByWorkflowRunId: raw }));
    expect(seed.costByWorkflowRunId).toEqual(raw);
  });

  it('builds an empty costByModel from an empty modelBreakdown', () => {
    const seed = buildCostTrackerSeed(makeSummary({ modelBreakdown: {} }));
    expect(seed.costByModel).toEqual({});
  });
});

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { localDateKey, localStartOfDay } from '../lib/date.js';
import {
  SessionStore,
  buildSessionSummary,
  type FullSessionSummary,
} from '../storage/session-store.js';
import type { SessionTracker } from './session-tracker.js';
import { CostTracker } from './cost-tracker.js';
import { BudgetTracker, type BudgetThresholdEvent } from './budget-tracker.js';
import { shouldApplyCostEstimate } from './cost-estimate-gate.js';
import { handleReportTokens, handleGetPromptCacheHealth } from '../tools/cost-tools.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    skillBreakdown: {},
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

  it('carries unpriced and estimated model usage into the seed', () => {
    const unpricedByModel = { 'claude-foo-9-9': { calls: 1, tokens: 2 } };
    const estimatedByModel = {
      'claude-opus-5-9': { calls: 3, tokens: 4, estimatedFrom: 'claude-opus-5' },
    };
    const seed = buildCostTrackerSeed(makeSummary({ unpricedByModel, estimatedByModel }));
    expect(seed.unpricedByModel).toEqual(unpricedByModel);
    expect(seed.estimatedByModel).toEqual(estimatedByModel);
    expect(buildCostTrackerSeed(makeSummary()).estimatedByModel).toBeUndefined();
  });
});

describe('buildCostTrackerSeed hadExactReport', () => {
  const LEDGER = {
    costUsd: 1.5,
    inputTokens: 400_000,
    outputTokens: 100_000,
    costByModel: { 'claude-sonnet-5': 1.5 },
    costByDayUsd: { [localDateKey()]: 1.5 },
  };
  const EMPTY_EXACT = { costUsd: 0, inputTokens: 0, outputTokens: 0, costByDayUsd: {} };
  const estimateOnly = (overrides?: Partial<FullSessionSummary>): FullSessionSummary =>
    makeSummary({
      estimatedCostUsd: LEDGER.costUsd,
      tokensInput: LEDGER.inputTokens,
      tokensOutput: LEDGER.outputTokens,
      tokensThinking: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      byteEstimates: LEDGER,
      exactTotals: EMPTY_EXACT,
      ...overrides,
    });

  it('marks a session whose saved exact share is empty as estimate-only', () => {
    expect(buildCostTrackerSeed(estimateOnly()).hadExactReport).toBe(false);
  });

  it('derives the exact share from the ledger when exactTotals was not saved', () => {
    expect(buildCostTrackerSeed(estimateOnly({ exactTotals: undefined })).hadExactReport).toBe(
      false,
    );
    expect(
      buildCostTrackerSeed(
        estimateOnly({
          exactTotals: undefined,
          estimatedCostUsd: LEDGER.costUsd + 2,
          tokensInput: LEDGER.inputTokens + 10,
        }),
      ).hadExactReport,
    ).toBeUndefined();
  });

  it.each([
    ['exact cost', { exactTotals: { ...EMPTY_EXACT, costUsd: 0.5 } }],
    ['exact input tokens', { exactTotals: { ...EMPTY_EXACT, inputTokens: 10 } }],
    ['exact output tokens', { exactTotals: { ...EMPTY_EXACT, outputTokens: 10 } }],
    ['thinking tokens', { tokensThinking: 5 }],
    ['cache-read tokens', { tokensCacheRead: 5 }],
    ['cache-creation tokens', { tokensCacheCreation: 5 }],
  ] as const)('treats %s as an exact report', (_label, overrides) => {
    expect(buildCostTrackerSeed(estimateOnly(overrides)).hadExactReport).toBeUndefined();
  });

  it('ignores floating-point dust in the exact cost', () => {
    const seed = buildCostTrackerSeed(
      estimateOnly({ exactTotals: { ...EMPTY_EXACT, costUsd: 1e-12 } }),
    );
    expect(seed.hadExactReport).toBe(false);
  });

  it('treats a summary with no byte-estimate ledger as reported', () => {
    expect(buildCostTrackerSeed(makeSummary()).hadExactReport).toBeUndefined();
  });
});

describe('byte-estimate sessions across a real restart', () => {
  const MODEL = 'claude-sonnet-4-6';
  const SESSION_ID = 'sess-restart';
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSessionTracker(): SessionTracker {
    return {
      getMetrics: () => ({
        sessionId: SESSION_ID,
        sessionName: null,
        sessionStartTime: Date.now(),
        toolCallCount: 0,
        toolCallCountByTool: {},
        bashCommandsRun: 0,
        toolSuccessRate: null,
      }),
    } as unknown as SessionTracker;
  }

  function makeRestart(before: CostTracker): CostTracker {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-restart-'));
    dirs.push(dir);
    const store = new SessionStore({ storagePath: dir });
    store.saveSession(
      buildSessionSummary({
        sessionTracker: makeSessionTracker(),
        costTracker: before,
        developer: 'dev1',
      }),
    );
    const persisted = store.loadSession(SESSION_ID);
    if (!persisted) throw new Error('session was not persisted');
    const after = new CostTracker();
    after.seedFromPersisted(buildCostTrackerSeed(persisted));
    return after;
  }

  function gateAllowsEstimate(tracker: CostTracker): boolean {
    return shouldApplyCostEstimate({
      estimateBytes: 400,
      reportCount: tracker.getMetrics().reportCount,
      recordSessionId: 'own',
      ownSessionId: 'own',
    });
  }

  function dataQualityOf(tracker: CostTracker): unknown {
    const result = handleGetPromptCacheHealth(tracker);
    return (JSON.parse(result.content[0]!.text) as { data_quality?: unknown }).data_quality;
  }

  const REPORT = { input_tokens: 1000, output_tokens: 500, model: MODEL };

  it('keeps cost reported and applies further estimates to an estimate-only session', () => {
    const before = new CostTracker();
    before.recordEstimatedTokens(400_000, 100_000, MODEL);

    const after = makeRestart(before);

    expect(after.getMetrics().sessionTotalCostUsd).toBeCloseTo(
      before.getMetrics().sessionTotalCostUsd ?? NaN,
      9,
    );
    expect(after.getMetrics().sessionTotalCostUsd).not.toBeNull();
    expect(gateAllowsEstimate(after)).toBe(true);
    expect(dataQualityOf(after)).toBe('estimated');
  });

  it('keeps already-fired budget thresholds fired after the restart', () => {
    const before = new CostTracker();
    before.recordEstimatedTokens(400_000, 100_000, MODEL);
    const total = before.getMetrics().sessionTotalCostUsd ?? 0;
    const events: BudgetThresholdEvent[] = [];
    const budget = new BudgetTracker({
      sessionBudgetUsd: total / 0.9,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });

    const after = makeRestart(before);
    budget.seedFiredThresholdsFromSessionTotal(after.getMetrics().sessionTotalCostUsd ?? 0);
    budget.updateCost(total, 0, 0);

    expect(events).toHaveLength(0);
  });

  it('stops applying estimates once the session had an exact report', () => {
    const before = new CostTracker();
    handleReportTokens(before, REPORT);

    const after = makeRestart(before);

    expect(gateAllowsEstimate(after)).toBe(false);
    expect(dataQualityOf(after)).toBe('self_reported');
  });

  it('stops applying estimates when an exact report followed the estimates', () => {
    const before = new CostTracker();
    before.recordEstimatedTokens(4000, 4000, MODEL);
    handleReportTokens(before, REPORT);

    expect(gateAllowsEstimate(makeRestart(before))).toBe(false);
  });

  it('keeps earlier estimates when a self-report follows and stops new ones', () => {
    const tracker = new CostTracker();
    const est = tracker.recordEstimatedTokens(400_000, 100_000, MODEL);

    handleReportTokens(tracker, REPORT);

    const reportOnly = new CostTracker();
    handleReportTokens(reportOnly, REPORT);
    expect(tracker.getMetrics().sessionTotalCostUsd).toBeCloseTo(
      est.totalUsd + (reportOnly.getMetrics().sessionTotalCostUsd ?? NaN),
      9,
    );
    expect(gateAllowsEstimate(tracker)).toBe(false);
  });

  it('keeps a self-report after a restart on top of the restored estimates', () => {
    const before = new CostTracker();
    const est = before.recordEstimatedTokens(400_000, 100_000, MODEL);
    const after = makeRestart(before);

    handleReportTokens(after, REPORT);

    const reportOnly = new CostTracker();
    handleReportTokens(reportOnly, REPORT);
    expect(after.getMetrics().sessionTotalCostUsd).toBeCloseTo(
      est.totalUsd + (reportOnly.getMetrics().sessionTotalCostUsd ?? NaN),
      9,
    );
  });

  it('treats a summary written before the exact/estimate split as reported', () => {
    const after = new CostTracker();
    after.seedFromPersisted(buildCostTrackerSeed(makeSummary()));

    expect(gateAllowsEstimate(after)).toBe(false);
    expect(after.getMetrics().reportCount).toBe(1);
  });
});

describe('buildCostTrackerSeed today attribution', () => {
  const NOON = new Date(2026, 9, 29, 12, 0, 0).getTime();
  const TODAY_KEY = localDateKey(NOON);
  const YESTERDAY_KEY = localDateKey(NOON - 86_400_000);
  const DAY_START = localStartOfDay(NOON);
  const HOUR = 3_600_000;

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOON,
      doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeEntries(count: number, fromMs: number): NonNullable<FullSessionSummary['timeline']> {
    return Array.from({ length: count }, (_, i) => ({
      timestamp: fromMs + i * 1000,
      durationMs: null,
      toolName: 'Read',
      success: true,
    }));
  }

  function makeCrossMidnight(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
    return makeSummary({
      startTime: DAY_START - 2 * HOUR,
      endTime: DAY_START + 2 * HOUR,
      estimatedCostUsd: 10,
      subagentCostUsd: 0,
      timeline: [
        ...makeEntries(9, DAY_START - 90 * 60_000),
        ...makeEntries(1, DAY_START + 60 * 60_000),
      ],
      ...overrides,
    });
  }

  function seedTracker(persisted: FullSessionSummary): CostTracker {
    const tracker = new CostTracker();
    tracker.seedFromPersisted(buildCostTrackerSeed(persisted));
    return tracker;
  }

  it('books nothing to today for a session whose activity was all yesterday', () => {
    const tracker = seedTracker(
      makeSummary({
        startTime: DAY_START - 26 * HOUR,
        endTime: DAY_START - 2 * HOUR,
        estimatedCostUsd: 7,
        subagentCostUsd: 0,
        timeline: makeEntries(5, DAY_START - 10 * HOUR),
      }),
    );
    expect(tracker.getCostForDay(TODAY_KEY)).toBe(0);
    expect(tracker.getMetrics().sessionTotalCostUsd).toBeCloseTo(7, 6);
  });

  it('seeds today cost from the exact persisted day bucket, not a timeline pro-rate', () => {
    const tracker = seedTracker(
      makeCrossMidnight({ costByDayUsd: { [YESTERDAY_KEY]: 8, [TODAY_KEY]: 2 } }),
    );
    expect(tracker.getCostForDay(TODAY_KEY)).toBeCloseTo(2, 6);
  });

  it('seeds today subagent cost from the exact persisted day bucket, not a ratio', () => {
    const tracker = seedTracker(
      makeCrossMidnight({
        subagentCostUsd: 4,
        costByDayUsd: { [YESTERDAY_KEY]: 8, [TODAY_KEY]: 2 },
        subagentCostByDayUsd: { [YESTERDAY_KEY]: 3.5, [TODAY_KEY]: 0.5 },
      }),
    );
    expect(tracker.getSubagentCostForDay(TODAY_KEY)).toBeCloseTo(0.5, 6);
  });

  it('books nothing to today for a legacy phantom session with no attributable activity', () => {
    const seed = buildCostTrackerSeed(
      makeSummary({
        startTime: DAY_START + HOUR,
        endTime: DAY_START + 2 * HOUR,
        estimatedCostUsd: 248,
        subagentCostUsd: 0,
        toolCallCount: 0,
        timeline: [],
        costByDayUsd: undefined,
      }),
    );
    expect(seed.totalCostUsd).toBe(248);
    expect(seed.dayCostUsd).toBe(0);
    expect(seed.daySubagentCostUsd).toBe(0);
  });

  it('never seeds a today subagent share above today total cost', () => {
    const seed = buildCostTrackerSeed(
      makeCrossMidnight({
        subagentCostUsd: 10,
        costByDayUsd: { [YESTERDAY_KEY]: 8, [TODAY_KEY]: 2 },
        subagentCostByDayUsd: undefined,
        timeline: [
          ...makeEntries(5, DAY_START - 90 * 60_000),
          ...makeEntries(5, DAY_START + 60 * 60_000),
        ],
      }),
    );
    expect(seed.dayCostUsd).toBeCloseTo(2, 6);
    expect(seed.daySubagentCostUsd).toBeLessThanOrEqual(seed.dayCostUsd);
  });
});

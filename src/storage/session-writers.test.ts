import { describe, it, expect } from '@jest/globals';
import {
  combineSessionFiles,
  deserializeFullSessionSummary,
  mergeSummaries,
} from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import {
  captureLegacyIndex,
  foldWriterContributions,
  type WriterContribution,
} from './session-writers.js';

const START = Date.parse('2026-03-01T10:00:00Z');
const DAY = '2026-03-01';
const TOOLS = ['Read', 'Bash', 'Edit'] as const;
const RUNS = 200;
const EXACT_OUTPUT = 11;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NO_LEDGER = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  costByModel: {},
  costByDayUsd: {},
};

function file(fields: Record<string, unknown>): FullSessionSummary {
  return deserializeFullSessionSummary({
    sessionId: 'shared',
    startTime: START,
    endTime: START + 1000,
    ...fields,
  } as unknown as Parameters<typeof deserializeFullSessionSummary>[0]);
}

type Call = { toolUseId: string; toolName: string; timestamp: number };

interface Share {
  calls: Call[];
  exactUsd: number;
  ledgerUsd: number;
  exactInput: number;
  ledgerInput: number;
  ledgerCalls: number;
  userMessages: number;
  endTime: number;
}

function summaryOf(s: Share): FullSessionSummary {
  const toolBreakdown: Record<string, number> = {};
  for (const c of s.calls) toolBreakdown[c.toolName] = (toolBreakdown[c.toolName] ?? 0) + 1;
  const ledger = {
    costUsd: s.ledgerUsd,
    inputTokens: s.ledgerInput,
    outputTokens: s.ledgerCalls,
    costByModel: { m: s.ledgerUsd },
    costByDayUsd: { [DAY]: s.ledgerUsd },
    estimatedByModel: { m: { calls: s.ledgerCalls, tokens: s.ledgerInput, estimatedFrom: 'p' } },
  };
  return file({
    endTime: s.endTime,
    sessionName: `name-${s.endTime}`,
    toolCallCount: s.calls.length,
    toolBreakdown,
    bashCommandCount: s.calls.filter((c) => c.toolName === 'Bash').length,
    timeline: s.calls.map((c) => ({ ...c, durationMs: 1, success: true })),
    estimatedCostUsd: s.exactUsd + s.ledgerUsd,
    costByDayUsd: { [DAY]: s.exactUsd + s.ledgerUsd },
    tokensInput: s.exactInput + s.ledgerInput,
    tokensOutput: EXACT_OUTPUT + s.ledgerCalls,
    estimatedByModel: {
      m: { calls: s.ledgerCalls + 1, tokens: s.ledgerInput + 1, estimatedFrom: 'p' },
    },
    byteEstimates: ledger,
    exactTotals: {
      costUsd: s.exactUsd,
      inputTokens: s.exactInput,
      outputTokens: EXACT_OUTPUT,
      costByDayUsd: { [DAY]: s.exactUsd },
    },
    userMessages: s.userMessages,
  });
}

function randomShare(next: () => number, writer: number): Share {
  const int = (n: number) => Math.floor(next() * n);
  return {
    calls: Array.from({ length: int(6) }, (_, i) => ({
      toolUseId: `toolu_${writer}_${i}`,
      toolName: TOOLS[int(TOOLS.length)],
      timestamp: START + int(1000),
    })),
    exactUsd: int(1000) / 100,
    ledgerUsd: int(1000) / 100,
    exactInput: int(5000),
    ledgerInput: int(5000),
    ledgerCalls: 1 + int(3),
    userMessages: int(20),
    endTime: START + 1000 + int(4) * 1000,
  };
}

const own = (s: Share, retracted = false): WriterContribution => ({
  summary: summaryOf(s),
  retracted,
});

function randomShares(seed: number): Share[] {
  const next = mulberry32(seed);
  return Array.from({ length: 2 + Math.floor(next() * 3) }, (_, w) => randomShare(next, w));
}

const total = (shares: Share[], f: (s: Share) => number) => shares.reduce((n, s) => n + f(s), 0);
const fold = (cs: WriterContribution[]) =>
  foldWriterContributions(cs as [WriterContribution, ...WriterContribution[]]);

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

describe('foldWriterContributions', () => {
  it('adds writers whose calls are disjoint', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const shares = randomShares(seed);
      const folded = fold(shares.map((s) => own(s)));
      const calls = shares.flatMap((s) => s.calls);
      const named = (name: string) => calls.filter((c) => c.toolName === name).length;
      expect(folded.toolCallCount).toBe(calls.length);
      for (const name of TOOLS) expect(folded.toolBreakdown[name] ?? 0).toBe(named(name));
      expect(folded.bashCommandCount).toBe(named('Bash'));
      const cost = total(shares, (s) => s.exactUsd + s.ledgerUsd);
      expect(folded.estimatedCostUsd).toBeCloseTo(cost, 9);
      expect(folded.costByDayUsd?.[DAY]).toBeCloseTo(cost, 9);
      expect(folded.byteEstimates?.costUsd).toBeCloseTo(
        total(shares, (s) => s.ledgerUsd),
        9,
      );
      expect(folded.tokensInput).toBe(total(shares, (s) => s.exactInput + s.ledgerInput));
      expect(folded.userMessages).toBe(Math.max(...shares.map((s) => s.userMessages)));
    }
  });

  it('counts a call two writers both drained once', () => {
    const call = { toolUseId: 'toolu_split', toolName: 'Bash', timestamp: START + 5 };
    const share = (endTime: number): Share => ({
      ...randomShare(mulberry32(endTime), 0),
      calls: [call],
      endTime,
    });
    const folded = fold([own(share(START + 1000)), own(share(START + 2000))]);
    expect(folded.toolCallCount).toBe(1);
    expect(folded.bashCommandCount).toBe(1);
    expect(folded.toolBreakdown).toEqual({ Bash: 1 });
    expect(folded.timeline).toHaveLength(1);
  });

  it('counts each call by its toolUseId when writers share some of them', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const shares = randomShares(seed);
      const disjoint = fold(shares.map((s) => own(s)));
      const next = mulberry32(seed + RUNS);
      const overlapping = shares.map((s, w) => {
        const earlier = shares.slice(0, w).flatMap((e) => e.calls);
        return { ...s, calls: [...s.calls, ...earlier.filter(() => next() < 0.5)] };
      });
      const folded = fold(overlapping.map((s) => own(s)));
      expect(folded.toolCallCount).toBe(disjoint.toolCallCount);
      expect(folded.toolBreakdown).toEqual(disjoint.toolBreakdown);
      expect(folded.bashCommandCount).toBe(disjoint.bashCommandCount);
    }
  });

  it('gives one answer in every input order', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const shares = randomShares(seed).slice(0, 3);
      shares[1] = { ...shares[1], calls: [...shares[1].calls, ...shares[0].calls.slice(0, 1)] };
      const contributions = shares.map((s, w) => own(s, seed % 3 === 0 && w === 1));
      const [first, ...rest] = permutations(contributions).map(fold);
      for (const other of rest) expect(other).toEqual(first);
    }
  });

  it('takes labels from the newest writer', () => {
    const share = randomShare(mulberry32(7), 0);
    const named = (sessionName: string, endTime: number) => ({
      ...summaryOf({ ...share, endTime }),
      sessionName,
    });
    const folded = fold([
      { summary: named('newer', START + 9000), retracted: false },
      { summary: named('older', START + 2000), retracted: false },
    ]);
    expect(folded.sessionName).toBe('newer');
  });

  it('returns a single writer unchanged', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const summary = summaryOf(randomShare(mulberry32(seed), 0));
      expect(foldWriterContributions([{ summary, retracted: false }])).toEqual(summary);
    }
  });

  it('drops every writer estimate once any writer retracts', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const shares = randomShares(seed);
      const next = mulberry32(seed + 2 * RUNS);
      const flags = shares.map(() => next() < 0.3);
      const folded = fold(shares.map((s, w) => own(s, flags[w])));
      const ledgerUsd = flags.some(Boolean) ? 0 : total(shares, (s) => s.ledgerUsd);
      const ledgerInput = flags.some(Boolean) ? 0 : total(shares, (s) => s.ledgerInput);
      const ledgerCalls = flags.some(Boolean) ? 0 : total(shares, (s) => s.ledgerCalls);
      const cost = total(shares, (s) => s.exactUsd) + ledgerUsd;
      expect(folded.byteEstimates?.costUsd).toBeCloseTo(ledgerUsd, 9);
      expect(folded.estimatedCostUsd).toBeCloseTo(cost, 9);
      expect(folded.costByDayUsd?.[DAY]).toBeCloseTo(cost, 9);
      expect(folded.exactTotals?.costUsd).toBeCloseTo(
        total(shares, (s) => s.exactUsd),
        9,
      );
      expect(folded.tokensInput).toBe(total(shares, (s) => s.exactInput) + ledgerInput);
      expect(folded.tokensOutput).toBe(EXACT_OUTPUT * shares.length + ledgerCalls);
      expect(folded.estimatedByModel?.m.calls).toBe(shares.length + ledgerCalls);
    }
  });

  it('takes the estimated calls out with the estimates, per model and per day', () => {
    const unpriced = (calls: number) => ({ calls, tokens: 10 * calls });
    const estimated = (calls: number) => ({ ...unpriced(calls), estimatedFrom: 'p' });
    const byModelAndDay = (n: number) => ({
      unpricedByModel: { u: unpriced(n) },
      unpricedByDay: { [DAY]: { u: unpriced(n) } },
      estimatedByModel: { e: estimated(n) },
      estimatedByDay: { [DAY]: { e: estimated(n) } },
    });
    const estimating = file({
      estimatedCostUsd: 3,
      costByDayUsd: { [DAY]: 3 },
      ...byModelAndDay(3),
      byteEstimates: { ...NO_LEDGER, costUsd: 1, costByDayUsd: { [DAY]: 1 }, ...byModelAndDay(1) },
    });
    const retracting = file({ endTime: START + 9000, estimatedCostUsd: 1, costByDayUsd: {} });
    const folded = fold([
      { summary: estimating, retracted: false },
      { summary: retracting, retracted: true },
    ]);
    expect(folded).toMatchObject({ estimatedCostUsd: 3, ...byModelAndDay(2) });
  });

  it('drops a lone retracted writer estimates and keeps its absent fields absent', () => {
    const estimates = {
      ...NO_LEDGER,
      costUsd: 2,
      inputTokens: 3,
      outputTokens: 4,
      costByDayUsd: { [DAY]: 2 },
    };
    const fields = {
      estimatedCostUsd: 2,
      tokensInput: 8,
      tokensOutput: 9,
      byteEstimates: estimates,
    };
    const withDays = file({ ...fields, costByDayUsd: { [DAY]: 2 } });
    expect(fold([{ summary: withDays, retracted: true }])).toMatchObject({
      estimatedCostUsd: 0,
      costByDayUsd: { [DAY]: 0 },
      tokensInput: 5,
      tokensOutput: 5,
    });
    const folded = fold([{ summary: file(fields), retracted: true }]);
    expect(folded.costByDayUsd).toBeUndefined();
    expect(folded.unpricedByModel).toBeUndefined();
    expect(folded.unpricedByDay).toBeUndefined();
    expect(folded.estimatedByModel).toBeUndefined();
    expect(folded.estimatedByDay).toBeUndefined();
  });
});

/** Dollar amounts are quarters, which binary floats add and subtract exactly. */
function richSummary(next: () => number, writer: string, endTime: number): FullSessionSummary {
  const int = (n: number) => Math.floor(next() * n);
  const usd = () => int(40) / 4;
  const share: Share = {
    calls: Array.from({ length: 1 + int(5) }, (_, i) => ({
      toolUseId: `toolu_${writer}_${i}`,
      toolName: TOOLS[int(TOOLS.length)],
      timestamp: START + int(1000),
    })).sort((x, y) => x.timestamp - y.timestamp),
    exactUsd: usd(),
    ledgerUsd: usd(),
    exactInput: int(5000),
    ledgerInput: int(5000),
    ledgerCalls: 1 + int(3),
    userMessages: int(20),
    endTime,
  };
  const unpriced = { u: { calls: 1 + int(3), tokens: int(100) } };
  const estimated = {
    calls: share.ledgerCalls + 1,
    tokens: share.ledgerInput + 1,
    estimatedFrom: 'p',
  };
  const subagentUsd = usd();
  const testRuns = int(5);
  return file({
    ...summaryOf(share),
    durationMs: endTime - START,
    sessionName: `name-${writer}`,
    skillBreakdown: { s: int(4) },
    linesAdded: int(50),
    linesRemoved: int(50),
    testRunCount: testRuns,
    testPassCount: int(testRuns + 1),
    buildRunCount: int(5),
    buildPassCount: int(5),
    subagentCostUsd: subagentUsd,
    subagentCostByDayUsd: { [DAY]: subagentUsd },
    unpricedByModel: unpriced,
    unpricedByDay: { [DAY]: unpriced },
    estimatedByDay: { [DAY]: { m: estimated } },
    tokensThinking: int(100),
    tokensCacheRead: int(100),
    tokensCacheCreation: int(100),
    selfReportCount: int(3),
    cacheSavingsUsd: usd(),
    antiPatterns: [{ type: 'loop', file: `f${int(3)}`, iterations: 2 }],
    taskCount: 1 + int(4),
    taskSuccessRate: int(5) / 4,
    toolSuccessRate: int(5) / 4,
    contextCompressions: int(3),
    agentSpawns: int(3),
    costByWorkflowRunId: { run: { [DAY]: usd() } },
    modelBreakdown: {
      m: {
        requestCount: int(9),
        totalInputTokens: int(900),
        totalOutputTokens: int(900),
        totalCostUsd: usd(),
        totalCacheReadTokens: int(900),
        totalCacheCreationTokens: int(900),
        totalThinkingTokens: int(900),
      },
    },
    qualityProxy: {
      totalSignals: int(9),
      diffApplyCleanCount: int(9),
      diffFailCount: int(9),
      testPassCount: int(9),
      testFailCount: int(9),
      backtrackCount: int(9),
      selfCorrectionCount: int(9),
    },
    attribution: {
      buckets: {
        tool: {
          Read: {
            costUsd: usd(),
            tokens: 40,
            count: int(5),
            durationMs: int(500),
            breakdown: {
              inputTokens: 10,
              outputTokens: 10,
              cacheReadTokens: 10,
              cacheCreationTokens: 10,
            },
            breakdownUsd: { inputUsd: 1, outputUsd: 1, cacheReadUsd: 1, cacheCreationUsd: 1 },
          },
        },
      },
      highContextCostUsd: usd(),
      apiDurationMs: int(1000),
    },
  });
}

const contribution = (summary: FullSessionSummary): WriterContribution => ({
  summary,
  retracted: false,
});

function randomWriters(next: () => number): WriterContribution[] {
  return Array.from({ length: 1 + Math.floor(next() * 3) }, (_, w) =>
    contribution(richSummary(next, `w${w}`, START + 1000 * (w + 1))),
  );
}

function expectSameSession(actual: FullSessionSummary, expected: FullSessionSummary): void {
  const rates = (s: FullSessionSummary) => [s.taskSuccessRate ?? -1, s.toolSuccessRate ?? -1];
  const withoutRates = (s: FullSessionSummary) => ({
    ...s,
    taskSuccessRate: null,
    toolSuccessRate: null,
  });
  expect(withoutRates(actual)).toEqual(withoutRates(expected));
  rates(actual).forEach((rate, i) => expect(rate).toBeCloseTo(rates(expected)[i], 9));
}

describe('captureLegacyIndex', () => {
  it('gives back an index that holds the writer files and an older build on top', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const next = mulberry32(seed);
      const writers = randomWriters(next);
      const older = contribution(richSummary(next, 'older', START + 9000));
      const index = fold([...writers, older]);
      const capture = captureLegacyIndex([index], writers);
      expectSameSession(fold([...writers, capture]), index);
      const totals = (s: FullSessionSummary) => [
        s.toolCallCount,
        s.estimatedCostUsd,
        s.costByDayUsd,
        s.tokensInput,
        s.tokensOutput,
        s.exactTotals,
        s.byteEstimates,
      ];
      expect(totals(capture.summary)).toEqual(totals(older.summary));
    }
  });

  it('is zero when the writer files already hold everything in the index', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const next = mulberry32(seed + RUNS);
      const writers = randomWriters(next);
      const stale = fold(writers.slice(0, 1 + Math.floor(next() * writers.length)));
      const { summary } = captureLegacyIndex([stale], writers);
      expect(summary).toMatchObject({
        toolCallCount: 0,
        estimatedCostUsd: 0,
        tokensInput: 0,
        tokensOutput: 0,
        subagentCostUsd: 0,
        timeline: [],
        antiPatterns: [],
        unpricedByModel: {},
        estimatedByModel: {},
      });
      expect(summary.byteEstimates?.costUsd).toBe(0);
      expectSameSession(fold([...writers, contribution(summary)]), fold(writers));
    }
  });

  it('equals the legacy total when no writer files exist', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const next = mulberry32(seed + 2 * RUNS);
      const files = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, i) =>
        richSummary(next, `legacy${i}`, START + 1000 * (i + 1)),
      );
      const capture = captureLegacyIndex(files as [FullSessionSummary], []);
      expect(fold([capture])).toEqual(combineSessionFiles(files));
    }
  });

  it('captures a split legacy session once, a stale copy included', () => {
    const next = mulberry32(5);
    const a = richSummary(next, 'a', START + 1000);
    const b = richSummary(next, 'b', START + 2000);
    const staleA = {
      ...a,
      toolCallCount: 1,
      timeline: a.timeline?.slice(0, 1),
      endTime: START + 500,
    };
    const { summary } = captureLegacyIndex([staleA, b, a], []);
    expect(summary.toolCallCount).toBe(a.toolCallCount + b.toolCallCount);
    expect(summary.estimatedCostUsd).toBe((a.estimatedCostUsd ?? 0) + (b.estimatedCostUsd ?? 0));
    expect(summary.tokensInput).toBe(a.tokensInput + b.tokensInput);
  });

  it('never counts the pre-upgrade history twice across successive captures', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const next = mulberry32(seed + 3 * RUNS);
      const preUpgrade = contribution(richSummary(next, 'pre', START + 500));
      const [a, b] = [1, 2].map((w) => contribution(richSummary(next, `w${w}`, START + w * 1000)));
      const older = contribution(richSummary(next, 'older', START + 9000));
      const preUpgradeCapture = captureLegacyIndex([preUpgrade.summary], []);
      const projectionOfA = fold([a, preUpgradeCapture]);
      const olderBuildIndex = mergeSummaries(
        projectionOfA,
        fold([contribution(projectionOfA), older]),
      );
      const rewriteCapture = captureLegacyIndex([olderBuildIndex], [a]);
      const captures = mergeSummaries(preUpgradeCapture.summary, rewriteCapture.summary);
      const loaded = fold([a, b, contribution(captures)]);
      const truth = fold([preUpgrade, a, older, b]);
      expect(loaded.toolCallCount).toBe(truth.toolCallCount);
      expect(loaded.toolBreakdown).toEqual(truth.toolBreakdown);
      expect(loaded.estimatedCostUsd).toBe(truth.estimatedCostUsd);
      expect(loaded.byteEstimates).toEqual(truth.byteEstimates);
      expect(loaded.tokensInput).toBe(truth.tokensInput);
      expect(loaded.modelBreakdown).toEqual(truth.modelBreakdown);
    }
  });

  it('takes rates and score means out by weight, clamped to [0, 1]', () => {
    const scored = (score: number, samples: number, toolSuccessRate: number, calls: number) =>
      file({
        toolCallCount: calls,
        toolSuccessRate,
        taskCount: samples,
        taskSuccessRate: toolSuccessRate,
        efficiencyScore: score,
        efficiencyScoreSampleCount: samples,
        efficiencyScoreComponents: {
          speed: score,
          correctness: score,
          autonomy: score,
          firstAttemptQuality: score,
        },
      });
    const writer = scored(0.5, 1, 0.5, 4);
    const { summary } = captureLegacyIndex([scored(0.875, 5, 0.75, 8)], [contribution(writer)]);
    expect(summary).toMatchObject({
      efficiencyScore: 0.96875,
      efficiencyScoreSampleCount: 4,
      efficiencyScoreComponents: { speed: 0.96875, firstAttemptQuality: 0.96875 },
      toolSuccessRate: 1,
      taskSuccessRate: 0.8125,
    });
    expect(fold([contribution(writer), contribution(summary)])).toMatchObject({
      efficiencyScore: 0.875,
      toolSuccessRate: 0.75,
    });
    const low = captureLegacyIndex([scored(0.25, 3, 0.25, 8)], [contribution(scored(1, 1, 1, 4))]);
    expect(low.summary).toMatchObject({
      efficiencyScore: 0,
      toolSuccessRate: 0,
      taskSuccessRate: 0,
    });
    const unrated = captureLegacyIndex([scored(0.875, 5, 0.75, 8)], [contribution(file({}))]);
    expect(unrated.summary).toMatchObject({ toolSuccessRate: 0.75, taskSuccessRate: 0.75 });
    const tested = (runs: number, passes: number) =>
      file({ testRunCount: runs, testPassCount: passes, taskCount: 2, taskSuccessRate: 0.5 });
    const counted = captureLegacyIndex([tested(10, 7)], [contribution(tested(4, 1))]);
    expect(counted.summary.taskSuccessRate).toBe(1);
    const none = captureLegacyIndex([scored(0.5, 1, 0.5, 4)], [contribution(writer)]);
    expect(none.summary).toMatchObject({
      efficiencyScore: null,
      efficiencyScoreSampleCount: 0,
      efficiencyScoreComponents: null,
      toolSuccessRate: null,
      taskSuccessRate: null,
    });
  });

  it('takes a writer estimates out as exact cost from an index saved before the ledger', () => {
    const writer = richSummary(mulberry32(9), 'w', START + 1000);
    const total = (writer.estimatedCostUsd ?? 0) + 5;
    const legacy = file({
      estimatedCostUsd: total,
      costByDayUsd: { [DAY]: total },
      tokensInput: writer.tokensInput + 7,
    });
    const { summary } = captureLegacyIndex([legacy], [contribution(writer)]);
    expect(summary).toMatchObject({
      estimatedCostUsd: 5,
      costByDayUsd: { [DAY]: 5 },
      tokensInput: 7,
    });
    expect(fold([contribution(writer), contribution(summary)]).estimatedCostUsd).toBe(total);
  });

  it('keeps an index without cost or day buckets without them', () => {
    const writer = richSummary(mulberry32(11), 'w', START + 1000);
    const { summary } = captureLegacyIndex([file({ toolCallCount: 9 })], [contribution(writer)]);
    expect(summary.estimatedCostUsd).toBeNull();
    expect(summary.costByDayUsd).toBeUndefined();
    expect(summary.toolCallCount).toBe(9 - writer.toolCallCount);
  });

  it('drops an attribution split the writer cannot take out', () => {
    const bucket = (tokens: number, split: boolean) => ({
      costUsd: tokens,
      tokens,
      count: 1,
      durationMs: 1,
      ...(split
        ? {
            breakdown: {
              inputTokens: tokens,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
            breakdownUsd: { inputUsd: tokens, outputUsd: 0, cacheReadUsd: 0, cacheCreationUsd: 0 },
          }
        : {}),
    });
    const attributed = (tokens: number, split: boolean) =>
      file({
        attribution: {
          buckets: { tool: { Read: bucket(tokens, split) } },
          highContextCostUsd: 0,
          apiDurationMs: null,
        },
      });
    const read = (s: FullSessionSummary) => s.attribution?.buckets.tool?.Read;
    const unsplit = captureLegacyIndex([attributed(8, true)], [contribution(attributed(3, false))]);
    expect(read(unsplit.summary)).toEqual({ ...bucket(5, false), count: 0, durationMs: 0 });
    const split = captureLegacyIndex([attributed(8, true)], [contribution(attributed(3, true))]);
    expect(read(split.summary)).toEqual({ ...bucket(5, true), count: 0, durationMs: 0 });
    expect(split.summary.attribution?.apiDurationMs).toBeNull();
  });
});

import { describe, it, expect } from '@jest/globals';
import { deserializeFullSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import { foldWriterContributions, type WriterContribution } from './session-writers.js';

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

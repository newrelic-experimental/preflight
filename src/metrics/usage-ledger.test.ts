import { describe, expect, it } from '@jest/globals';

import type { TokenUsage } from '../shared/index.js';

import {
  UsageLedger,
  ZERO_TOTALS,
  copilotAppRangeId,
  copilotAppRangeUsage,
  decodeUsageLedger,
  encodeUsageLedger,
  foldUsage,
  parsePersistedUsageLedger,
} from './usage-ledger.js';
import type { CopilotAppCounters, UsageEntry } from './usage-ledger.js';
import { mergeSummaries, usageLedgerOf } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';

const DAY = '2026-09-10';

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'msg_1',
    provisional: false,
    replaces: true,
    ts: 1_000,
    day: DAY,
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1,
    cacheSavingsUsd: 0,
    ...overrides,
  };
}

/** A Copilot app range over the input, output and cached counters, at a cent per token. */
function appRange(epoch: number, from: number[], to: number[]): UsageEntry {
  const counters = (c: number[]): CopilotAppCounters => ({
    input: c[0]!,
    output: c[1]!,
    cached: c[2]!,
    reasoning: 0,
  });
  const usage = copilotAppRangeUsage(counters(from), counters(to));
  return makeEntry({
    id: copilotAppRangeId('s', epoch, counters(from), counters(to)),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.totalTokens / 100,
  });
}

function usageOf(e: UsageEntry): TokenUsage {
  return {
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    thinkingTokens: e.thinkingTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    totalTokens: e.inputTokens + e.outputTokens + e.cacheReadTokens,
  };
}

function makeSummary(overrides: Partial<FullSessionSummary> = {}): FullSessionSummary {
  return {
    sessionId: 's1',
    startTime: 0,
    endTime: 5_000,
    durationMs: 5_000,
    toolCallCount: 1,
    developer: 'dev',
    estimatedCostUsd: 0,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    ...overrides,
  } as unknown as FullSessionSummary;
}

function withLedger(entries: UsageEntry[], overrides: Partial<FullSessionSummary> = {}) {
  const fold = foldUsage(entries);
  return makeSummary({
    estimatedCostUsd: fold.totals.costUsd,
    subagentCostUsd: fold.totals.subagentCostUsd,
    tokensInput: fold.totals.inputTokens,
    tokensOutput: fold.totals.outputTokens,
    costByDayUsd: { ...fold.totals.costByDayUsd },
    usageLedger: encodeUsageLedger(entries),
    ...overrides,
  });
}

describe('UsageLedger', () => {
  it('counts an id once, however often it is inserted', () => {
    const ledger = new UsageLedger();
    expect(ledger.insert(makeEntry())).toBe(true);
    expect(ledger.insert(makeEntry())).toBe(false);
    expect(ledger.fold().totals.costUsd).toBe(1);
  });

  it('keeps the same entry for an id whichever copy arrives first', () => {
    const small = makeEntry({ outputTokens: 10, costUsd: 1, replaces: false });
    const grown = makeEntry({ outputTokens: 50, costUsd: 2 });
    const a = new UsageLedger();
    a.union([small, grown]);
    const b = new UsageLedger();
    b.union([grown, small]);
    expect(a.fold().totals).toEqual(b.fold().totals);
    expect(a.fold().totals.costUsd).toBe(2);
  });

  it('is idempotent under union', () => {
    const entries = [makeEntry(), makeEntry({ id: 'msg_2', costUsd: 3 })];
    const ledger = new UsageLedger();
    ledger.union(entries);
    ledger.union(entries);
    ledger.union([...entries].reverse());
    expect(ledger.fold().totals.costUsd).toBe(4);
  });

  it('refuses a Copilot app range overlapping one it holds, in the same epoch only', () => {
    const ledger = new UsageLedger();
    expect(ledger.insert(appRange(0, [0, 0, 0], [500, 0, 0]))).toBe(true);
    expect(ledger.insert(appRange(0, [500, 0, 0], [800, 0, 0]))).toBe(true);
    expect(ledger.insert(appRange(0, [0, 0, 0], [800, 0, 0]))).toBe(false);
    expect(ledger.insert(appRange(1, [0, 0, 0], [300, 0, 0]))).toBe(true);
    expect(ledger.fold().totals.inputTokens).toBe(1_100);
  });

  it('claims only the part of a Copilot app range past the ranges it overlaps', () => {
    const ledger = new UsageLedger();
    ledger.insert(appRange(0, [0, 0, 0], [1_000, 100, 200]));
    ledger.insert(appRange(0, [1_000, 100, 200], [2_000, 300, 500]));
    const reread = appRange(0, [1_000, 100, 200], [2_600, 350, 600]);
    const tail = ledger.claim(reread.id, usageOf(reread));
    expect(tail?.id).toBe(appRange(0, [2_000, 300, 500], [2_600, 350, 600]).id);
    expect(tail?.usage).toMatchObject({ inputTokens: 500, cacheReadTokens: 100, outputTokens: 50 });
    expect(ledger.claim(appRange(0, [0, 0, 0], [2_000, 300, 500]).id, usageOf(reread))).toBeNull();
    const fresh = appRange(0, [2_000, 300, 500], [2_100, 300, 500]);
    expect(ledger.claim(fresh.id, usageOf(fresh))?.id).toBe(fresh.id);
  });

  it('unions overlapping Copilot app ranges the same whichever copy goes first', () => {
    const x = [appRange(0, [0, 0, 0], [100, 0, 0]), appRange(0, [100, 0, 0], [200, 0, 0])];
    const y = [appRange(0, [100, 0, 0], [250, 0, 0])];
    const merged = (first: UsageEntry[], second: UsageEntry[]): number => {
      const ledger = new UsageLedger();
      ledger.union(first);
      ledger.union(second);
      return ledger.fold().totals.inputTokens;
    };
    expect(merged(x, y)).toBe(250);
    expect(merged(y, x)).toBe(250);
  });

  it('keeps the copy of a call that knows its workflow run and agent type, whichever goes first', () => {
    const bare = makeEntry({ id: 'msg_sub', agentId: 'a', replaces: false });
    const rich = { ...bare, agentType: 'Explore', workflowRunId: 'run-1' };
    for (const order of [
      [bare, rich],
      [rich, bare],
    ]) {
      const ledger = new UsageLedger();
      for (const e of order) ledger.insert(e);
      expect(ledger.fold().totals.costByWorkflowRunId).toEqual({ 'run-1': { [DAY]: 1 } });
    }
  });

  it('retires an estimate once a replaying report is at or after it', () => {
    const est = makeEntry({ id: 'est:a:1', provisional: true, replaces: false, ts: 2_000 });
    const earlier = makeEntry({ id: 'msg_early', ts: 1_000, costUsd: 5 });
    const later = makeEntry({ id: 'msg_late', ts: 3_000, costUsd: 7 });
    expect(foldUsage([est, earlier]).totals.costUsd).toBe(6);
    expect(foldUsage([est, earlier, later]).totals.costUsd).toBe(12);
    expect(foldUsage([est, later]).byteEstimates?.costUsd).toBe(0);
  });

  it('never retires an estimate on a self-report or a subagent turn', () => {
    const est = makeEntry({ id: 'est:a:1', provisional: true, replaces: false, ts: 2_000 });
    const self = makeEntry({ id: 'anon:a:1', replaces: false, ts: 3_000, costUsd: 5 });
    const sub = makeEntry({ id: 'msg_sub', replaces: false, agentId: 'a', ts: 3_000 });
    expect(foldUsage([est, self, sub]).byteEstimates?.costUsd).toBe(1);
  });

  it('folds the same incrementally as from scratch', () => {
    const ledger = new UsageLedger();
    const all: UsageEntry[] = [];
    for (let i = 0; i < 40; i++) {
      const e = makeEntry({
        id: `msg_${i % 30}`,
        ts: i * 100,
        day: i % 3 === 0 ? '2026-09-11' : DAY,
        model: i % 2 === 0 ? 'a' : 'b',
        costUsd: i % 5 === 0 ? 0 : i,
        inputTokens: i,
        replaces: i % 4 !== 0,
        provisional: i % 9 === 1,
        ...(i % 6 === 0 && { agentId: 'agent', agentType: 'Explore', workflowRunId: 'run' }),
      });
      all.push(e);
      ledger.insert(e);
      expect(ledger.fold()).toEqual(foldUsage(ledger.values()));
    }
  });

  it('round-trips through its persisted form', () => {
    const entries = [
      makeEntry({ agentId: 'agent-1', agentType: 'Explore', workflowRunId: 'run-1' }),
      makeEntry({ id: 'est:x:1', provisional: true, replaces: false, day: null }),
      makeEntry({ id: 'msg_3', pricing: { estimatedFrom: 'claude-opus-5' } }),
      makeEntry({ id: 'msg_4', model: 'mystery', pricing: { kind: 'unpriced' } }),
      makeEntry({
        id: 'legacy-est:2026-09-10',
        provisional: true,
        replaces: false,
        calls: {
          unpriced: { u: { calls: 2, tokens: 20 } },
          estimated: { e: { calls: 1, tokens: 5, estimatedFrom: 'base' } },
        },
      }),
    ];
    const parsed = parsePersistedUsageLedger(
      JSON.parse(JSON.stringify(encodeUsageLedger(entries))),
    );
    expect(decodeUsageLedger(parsed!).entries).toEqual(entries);
  });

  it('drops malformed persisted entries', () => {
    const parsed = parsePersistedUsageLedger({
      v: 1,
      models: ['m'],
      entries: ['not json', '["id",9,0,null,0]', '["ok",2,1,null,0,1,1,0,0,0,0.5,0]', 42],
    });
    expect(decodeUsageLedger(parsed!).entries.map((e) => e.id)).toEqual(['ok']);
    expect(parsePersistedUsageLedger({ v: 2, models: [], entries: [] })).toBeUndefined();
  });
});

describe('per-day call counts', () => {
  const unpriced = { kind: 'unpriced' } as const;

  it('splits unpriced and estimated-price calls by the day each was recorded', () => {
    const fold = foldUsage([
      makeEntry({ id: 'a', model: 'u', pricing: unpriced }),
      makeEntry({ id: 'b', model: 'u', day: '2026-09-11', pricing: unpriced }),
      makeEntry({ id: 'c', model: 'e', pricing: { estimatedFrom: 'base' } }),
    ]);
    expect(fold.totals.unpricedByDay).toEqual({
      [DAY]: { u: { calls: 1, tokens: 110 } },
      '2026-09-11': { u: { calls: 1, tokens: 110 } },
    });
    expect(fold.totals.estimatedByDay).toEqual({
      [DAY]: { e: { calls: 1, tokens: 110, estimatedFrom: 'base' } },
    });
  });

  it('counts a late arrival in the totals but in no day', () => {
    const fold = foldUsage([makeEntry({ model: 'u', day: null, pricing: unpriced })]);
    expect(fold.totals.unpricedByModel).toEqual({ u: { calls: 1, tokens: 110 } });
    expect(fold.totals.unpricedByDay).toEqual({});
  });

  it('drops a retired estimate from the totals and its day', () => {
    const est = makeEntry({
      id: 'est:a:1',
      provisional: true,
      replaces: false,
      ts: 1_000,
      model: 'u',
      pricing: unpriced,
    });
    const report = makeEntry({ id: 'msg_x', ts: 2_000 });
    const fold = foldUsage([est, report]);
    expect(fold.totals.unpricedByModel).toEqual({});
    expect(fold.totals.unpricedByDay).toEqual({});
  });

  it('writes the day map with its counts, even when every call arrived late', () => {
    const late = withLedger([makeEntry({ model: 'u', day: null, pricing: unpriced })]);
    const merged = mergeSummaries(late, late);
    expect(merged.unpricedByModel).toEqual({ u: { calls: 1, tokens: 110 } });
    expect(merged.unpricedByDay).toEqual({});
  });

  it("books a pre-ledger summary's calls to its own latest day on merge", () => {
    const legacy = makeSummary({
      estimatedCostUsd: 1,
      costByDayUsd: { '2026-09-08': 0.5, '2026-09-09': 0.5 },
      unpricedByModel: { u: { calls: 2, tokens: 20 } },
    });
    const keyed = withLedger([makeEntry({ id: 'msg_new', model: 'u', pricing: unpriced })]);
    const merged = mergeSummaries(legacy, keyed);
    // The legacy count may already include the keyed call, so one call is
    // taken out of the legacy share, and its day bucket follows.
    expect(merged.unpricedByModel).toEqual({ u: { calls: 2, tokens: 110 } });
    expect(merged.unpricedByDay).toEqual({
      '2026-09-09': { u: { calls: 1, tokens: 0 } },
      [DAY]: { u: { calls: 1, tokens: 110 } },
    });
  });
});

describe('session files and the ledger', () => {
  it('merges two writers of one session as a union', () => {
    const a = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_shared' })]);
    const b = withLedger([makeEntry({ id: 'msg_shared' }), makeEntry({ id: 'msg_b' })]);
    const merged = mergeSummaries(a, b);
    expect(merged.estimatedCostUsd).toBe(3);
    expect(merged.tokensInput).toBe(300);
    expect(mergeSummaries(merged, a).estimatedCostUsd).toBe(3);
  });

  it('keeps a pre-ledger file whole without re-adding the calls the other side keyed', () => {
    // An older process wrote $5 that already includes msg_a; the new side holds msg_a keyed.
    const legacy = makeSummary({
      estimatedCostUsd: 5,
      tokensInput: 500,
      costByDayUsd: { [DAY]: 5 },
    });
    const keyed = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_new' })]);
    const merged = mergeSummaries(legacy, keyed);
    // Base: $5 less the $2 keyed elsewhere, then the $2 keyed added back.
    expect(merged.estimatedCostUsd).toBe(5);
    expect(merged.usageLedger).toBeDefined();
  });

  it('adds calls made after a pre-ledger file was last written to its totals', () => {
    const legacy = makeSummary({ endTime: 5_000, estimatedCostUsd: 5, tokensInput: 500 });
    const later = withLedger([makeEntry({ id: 'msg_new', ts: 6_000, costUsd: 2 })]);
    expect(mergeSummaries(legacy, later).estimatedCostUsd).toBe(7);
    expect(mergeSummaries(later, legacy).estimatedCostUsd).toBe(7);
  });

  it('takes the keyed calls out of a pre-ledger file with no end time before merging', () => {
    // An older build or a crash leaves endTime 0: any keyed call may be in its totals.
    const legacy = makeSummary({ endTime: 0, estimatedCostUsd: 5, tokensInput: 500 });
    const keyed = withLedger([makeEntry({ id: 'msg_a', ts: 6_000, costUsd: 2 })]);
    expect(mergeSummaries(legacy, keyed).estimatedCostUsd).toBe(5);
    expect(mergeSummaries(keyed, legacy).estimatedCostUsd).toBe(5);
  });

  it('turns a pre-ledger byte-estimate ledger into estimates the next report retires', () => {
    const legacy = makeSummary({
      endTime: 5_000,
      estimatedCostUsd: 3,
      tokensInput: 300,
      byteEstimates: {
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 0,
        costByModel: { m: 1 },
        costByDayUsd: { [DAY]: 1 },
      },
    });
    const recovered = usageLedgerOf(legacy);
    expect(recovered.base.costUsd).toBe(2);
    expect(foldUsage(recovered.entries, recovered.base).totals.costUsd).toBe(3);
    const replay = makeEntry({ id: 'msg_after', ts: 6_000, costUsd: 4 });
    expect(foldUsage([...recovered.entries, replay], recovered.base).totals.costUsd).toBe(6);
  });

  it('folds into base what an older writer added on top of a stored ledger', () => {
    // A pre-ledger Preflight max-merged its $9 total into a file whose ledger adds up to $2.
    const touched = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_b' })], {
      estimatedCostUsd: 9,
    });
    const { entries, base } = usageLedgerOf(touched);
    expect(foldUsage(entries, base).totals.costUsd).toBe(9);
    expect(base).not.toBe(ZERO_TOTALS);
  });
});

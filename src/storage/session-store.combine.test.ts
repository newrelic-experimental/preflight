import { describe, it, expect } from '@jest/globals';
import { combineSessionFiles, deserializeFullSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

const START = Date.parse('2026-03-01T10:00:00Z');
const DAY = 86_400_000;
const TIMELINE_CAP = 10_000;

type Entry = { timestamp: number; toolName: string; toolUseId?: string };
const entry = (timestamp: number, toolUseId?: string): Entry => ({
  timestamp,
  toolName: 'Read',
  ...(toolUseId ? { toolUseId } : {}),
});
const entries = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => entry(from + i));

function summary(fields: Record<string, unknown>): FullSessionSummary {
  return deserializeFullSessionSummary({
    sessionId: 'split',
    startTime: START,
    endTime: START + 1000,
    ...fields,
  } as unknown as Parameters<typeof deserializeFullSessionSummary>[0]);
}

type Rule = (older: number, newer: number) => number;
const sum: Rule = (x, y) => x + y;
const max: Rule = (x, y) => Math.max(x, y);
const min: Rule = (x, y) => Math.min(x, y);
const weighted: Rule = (x, y) => (x * x + y * y) / (x + y);

const rows = (whenSeparate: Rule, whenCopies: Rule, paths: string) =>
  paths
    .trim()
    .split(/\s+/)
    .map((path): [string, Rule, Rule] => [path, whenSeparate, whenCopies]);

const COUNTERS = `
  toolCallCount toolBreakdown.Read skillBreakdown.s linesAdded linesRemoved bashCommandCount
  testRunCount testPassCount buildRunCount buildPassCount subagentCostUsd subagentCostByDayUsd.d
  exactTotals.costUsd exactTotals.inputTokens exactTotals.outputTokens exactTotals.costByDayUsd.d
  tokensThinking tokensCacheRead tokensCacheCreation cacheSavingsUsd taskCount contextCompressions
  agentSpawns costByWorkflowRunId.r.d efficiencyScoreSampleCount
  modelBreakdown.m.requestCount modelBreakdown.m.totalInputTokens modelBreakdown.m.totalOutputTokens
  modelBreakdown.m.totalCostUsd modelBreakdown.m.totalCacheReadTokens
  modelBreakdown.m.totalCacheCreationTokens modelBreakdown.m.totalThinkingTokens
  qualityProxy.totalSignals qualityProxy.diffApplyCleanCount qualityProxy.diffFailCount
  qualityProxy.testPassCount qualityProxy.testFailCount qualityProxy.backtrackCount
  qualityProxy.selfCorrectionCount
  attribution.buckets.tool.Read.costUsd attribution.buckets.tool.Read.tokens
  attribution.buckets.tool.Read.count attribution.buckets.tool.Read.durationMs
  attribution.buckets.tool.Read.breakdown.inputTokens attribution.buckets.tool.Read.breakdown.outputTokens
  attribution.buckets.tool.Read.breakdown.cacheReadTokens
  attribution.buckets.tool.Read.breakdown.cacheCreationTokens
  attribution.buckets.tool.Read.breakdownUsd.inputUsd
  attribution.buckets.tool.Read.breakdownUsd.outputUsd
  attribution.buckets.tool.Read.breakdownUsd.cacheReadUsd
  attribution.buckets.tool.Read.breakdownUsd.cacheCreationUsd
  attribution.highContextCostUsd attribution.apiDurationMs`;
const CALL_USAGE = `
  unpricedByModel.m.calls unpricedByModel.m.tokens estimatedByModel.m.calls estimatedByModel.m.tokens
  unpricedByDay.d.m.calls unpricedByDay.d.m.tokens estimatedByDay.d.m.calls estimatedByDay.d.m.tokens`;
const LEDGER = `
  byteEstimates.costUsd byteEstimates.inputTokens byteEstimates.outputTokens
  byteEstimates.costByModel.m byteEstimates.costByDayUsd.d
  ${CALL_USAGE.replace(/(\S+)/g, 'byteEstimates.$1')}`;
/** Each is exact plus ledger, so the fixture sets them to twice its counters. */
const TOTALS = `estimatedCostUsd tokensInput tokensOutput costByDayUsd.d ${CALL_USAGE}`;
const NEVER_ADDED = `
  userMessages assistantMessages userCorrections toolSelectionMetrics.totalCalls
  toolSelectionMetrics.score toolSelectionMetrics.penalizedCalls
  toolSelectionMetrics.redundantReadCount toolSelectionMetrics.repeatedFailureCount
  toolSelectionMetrics.unusedOutputCount`;
const SCORES = `
  efficiencyScore efficiencyScoreComponents.speed efficiencyScoreComponents.correctness
  efficiencyScoreComponents.autonomy efficiencyScoreComponents.firstAttemptQuality`;

const RULES: ReadonlyArray<[string, Rule, Rule]> = [
  ...rows(sum, max, COUNTERS),
  ...rows(sum, max, LEDGER),
  ...rows(
    (x, y) => 2 * (x + y),
    (x, y) => 2 * Math.max(x, y),
    TOTALS,
  ),
  ...rows(max, max, NEVER_ADDED),
  ...rows(weighted, max, SCORES),
  ...rows(min, min, 'firstActivityByDayMs.d'),
  ...rows(() => 1, max, 'taskSuccessRate'),
  ...rows(weighted, max, 'toolSuccessRate'),
];
const TOTAL_PATHS = new Set(TOTALS.trim().split(/\s+/));

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let node = target;
  for (const key of keys) node = (node[key] ??= {}) as Record<string, unknown>;
  node[last] = value;
}

/** A file with every number in RULES set from `k`, so each row can name what combining gives. */
function everyField(k: number, startTime: number, timeline: Entry[]) {
  const fields: Record<string, unknown> = {
    startTime,
    endTime: startTime + 1000,
    timeline,
    developer: `dev-${k}`,
    sessionName: `name-${startTime}`,
    filesRead: [`read-${k}`],
    antiPatterns: [{ type: `t${k}` }],
  };
  for (const [path] of RULES) setPath(fields, path, TOTAL_PATHS.has(path) ? 2 * k : k);
  for (const usage of ['estimatedByModel.m', 'estimatedByDay.d.m']) {
    setPath(fields, `${usage}.estimatedFrom`, 'p');
    setPath(fields, `byteEstimates.${usage}.estimatedFrom`, 'p');
  }
  return summary(fields);
}

function numericLeaves(value: unknown, path = '', out = new Map<string, number>()) {
  if (typeof value === 'number') {
    if (!['startTime', 'endTime', 'durationMs'].includes(path)) out.set(path, value);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      numericLeaves(child, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** Combines in every input order, requires one answer, and returns it. */
function combineInEveryOrder(files: readonly FullSessionSummary[]): FullSessionSummary {
  const [first, ...others] = permutations(files).map((order) => combineSessionFiles(order));
  for (const other of others) expect(other).toEqual(first);
  return first;
}

const calls = (start: number, toolCallCount: number, extra: Record<string, unknown> = {}) =>
  summary({
    startTime: start,
    endTime: start + 1000,
    toolCallCount,
    estimatedCostUsd: toolCallCount / 10,
    timeline: entries(start, toolCallCount),
    ...extra,
  });

describe.each([
  ['the older file smaller', 2, 3],
  ['the older file larger', 3, 2],
])('combining two files, %s', (_, older, newer) => {
  const [t1, t2] = [START, START + DAY];
  const separate = () =>
    combineSessionFiles([
      everyField(older, t1, [entry(t1 + 1)]),
      everyField(newer, t2, [entry(t2 + 1)]),
    ]);
  const copies = () =>
    combineSessionFiles([
      everyField(older, t1, [entry(t1 + 1), entry(t1 + 2)]),
      everyField(newer, t2, [entry(t1 + 2), entry(t2 + 1)]),
    ]);

  it('has a rule for every number on the record', () => {
    expect([...numericLeaves(separate()).keys()].sort()).toEqual(
      RULES.map(([path]) => path).sort(),
    );
  });

  it.each(RULES)('%s', (path, whenSeparate, whenCopies) => {
    expect(numericLeaves(separate()).get(path)).toBeCloseTo(whenSeparate(older, newer));
    expect(numericLeaves(copies()).get(path)).toBeCloseTo(whenCopies(older, newer));
  });

  it('takes labels from the newer file, or from the copy further along', () => {
    expect(separate().developer).toBe(`dev-${newer}`);
    expect(copies().developer).toBe(`dev-${Math.max(older, newer)}`);
    for (const combined of [separate(), copies()]) {
      const span = [combined.startTime, combined.endTime, combined.durationMs];
      expect(span).toEqual([t1, t2 + 1000, t2 + 1000 - t1]);
      expect([...combined.filesRead].sort()).toEqual([`read-${older}`, `read-${newer}`].sort());
    }
  });

  it('unions the timeline and adds anti-patterns only for separate activity', () => {
    const added = separate();
    expect(added.timeline?.map((e) => e.timestamp)).toEqual([t1 + 1, t2 + 1]);
    expect(added.antiPatterns.map((p) => p.type)).toEqual([`t${older}`, `t${newer}`]);
    const maxed = copies();
    expect(maxed.timeline?.map((e) => e.timestamp)).toEqual([t1 + 1, t1 + 2, t2 + 1]);
    expect(maxed.antiPatterns.map((p) => p.type)).toEqual([`t${Math.max(older, newer)}`]);
  });
});

describe('grouping files by shared activity', () => {
  it('returns a single file unchanged', () => {
    const only = calls(START, 4, { exactTotals: { costUsd: 0.1 }, byteEstimates: {} });
    expect(combineSessionFiles([only])).toBe(only);
  });

  it('adds a separate file to a superseded pair in every order', () => {
    const x = calls(START, 10);
    const y = calls(START + DAY, 20);
    const z = calls(START + DAY, 25, { endTime: START + DAY + 5000 });
    const combined = combineInEveryOrder([x, y, z]);
    expect(combined.toolCallCount).toBe(35);
    expect(combined.estimatedCostUsd).toBeCloseTo(3.5);
  });

  it('groups files linked only through a third file', () => {
    const a = calls(START, 100);
    const bridge = summary({ toolCallCount: 2, timeline: [entry(START + 99), entry(START + DAY)] });
    const c = calls(START + DAY, 100);
    expect(combineInEveryOrder([a, bridge, c]).toolCallCount).toBe(100);
  });

  it('treats one tool use id in two files as one call', () => {
    const a = calls(START, 2, { timeline: [entry(START, 'tu-1'), entry(START + 5, 'tu-2')] });
    const b = calls(START + DAY, 3, { timeline: [entry(START + 5, 'tu-2'), entry(START + DAY)] });
    expect(combineInEveryOrder([a, b]).toolCallCount).toBe(3);
  });

  it('keeps parallel calls with one timestamp but different tool use ids apart', () => {
    const a = calls(START, 2, { timeline: [entry(START, 'tu-1')] });
    const b = calls(START + DAY, 3, { timeline: [entry(START, 'tu-2')] });
    expect(combineInEveryOrder([a, b]).toolCallCount).toBe(5);
  });

  it('matches an entry saved before tool use ids to the same call saved with one', () => {
    const a = calls(START, 2, { timeline: [entry(START)] });
    const b = calls(START + DAY, 3, { timeline: [entry(START, 'tu-1')] });
    expect(combineInEveryOrder([a, b]).toolCallCount).toBe(3);
  });

  it('max-merges a file without a timeline into the total, smaller or larger', () => {
    const a = calls(START, 10);
    const b = calls(START + DAY, 20);
    const smaller = summary({ toolCallCount: 25, sessionName: 'old' });
    const larger = summary({ toolCallCount: 40, sessionName: 'new', endTime: START + 2000 });
    expect(combineInEveryOrder([a, b, smaller]).toolCallCount).toBe(30);
    expect(combineInEveryOrder([a, b, larger]).toolCallCount).toBe(40);
    expect(combineInEveryOrder([smaller, larger])).toMatchObject({
      toolCallCount: 40,
      sessionName: 'new',
    });
  });

  it('gives one answer for copies that tie on progress and end time', () => {
    const tied = (sessionName: string) => calls(START, 4, { sessionName, endTime: START + 9000 });
    expect(combineInEveryOrder([tied('a'), tied('b')]).toolCallCount).toBe(4);
  });
});

describe('a timeline at the cap', () => {
  const capped = (toolCallCount: number, keptFrom: number, kept = TIMELINE_CAP) =>
    summary({ endTime: START + 100_000, toolCallCount, timeline: entries(keptFrom, kept) });
  const edits = (from: number, extra = {}) =>
    summary({
      toolCallCount: 2000,
      timeline: entries(from, 2000).map((e) => ({ ...e, toolName: 'Edit' })),
      ...extra,
    });
  const oldestDropped = capped(12_000, START + 50_000);
  const newestDropped = capped(12_000, START + 1);
  const until = (endTime: number) => edits(START + 20_000, { endTime });

  const shortOfCap = capped(12_000, START + 50_000, TIMELINE_CAP - 1);

  it.each<[string, FullSessionSummary, FullSessionSummary, number]>([
    ['a file beside a cap that dropped nothing', capped(TIMELINE_CAP, 10), calls(1e5, 20), 10_020],
    ['a source of the dropped oldest entries', oldestDropped, edits(START + 48_000), 12_000],
    ['a file ending at the first kept entry', oldestDropped, edits(START + 48_001), 14_000],
    [
      'a file starting before the capped file',
      oldestDropped,
      edits(START, { startTime: 0 }),
      14_000,
    ],
    ['a source of the dropped newest entries', newestDropped, edits(START + 10_001), 12_000],
    ['a file starting at the last kept entry', newestDropped, edits(START + 10_000), 14_000],
    ['a source ending with the capped file', newestDropped, until(START + 100_000), 12_000],
    ['a file ending after the capped file', newestDropped, until(START + 100_001), 14_000],
    ['a source that fits the gap', oldestDropped, edits(START + 1), 12_000],
    ['a file too long for the gap', capped(11_999, START + 50_000), edits(START + 1), 13_999],
    ['a file beside one entry short of the cap', shortOfCap, edits(START + 1), 14_000],
  ])('%s', (_, cappedFile, other, total) => {
    expect(combineInEveryOrder([cappedFile, other]).toolCallCount).toBe(total);
  });
});

describe('combining fields that do not always exist', () => {
  const pair = (older: Record<string, unknown>, newer: Record<string, unknown>) =>
    combineInEveryOrder([calls(START, 1, older), calls(START + DAY, 1, newer)]);
  const ledger = (costUsd: number, extra = {}) => ({ costUsd, ...extra });

  it('leaves cost unknown only when neither file knows it', () => {
    const unknown = { estimatedCostUsd: null };
    expect(pair(unknown, unknown).estimatedCostUsd).toBeNull();
    expect(pair(unknown, { estimatedCostUsd: 2 }).estimatedCostUsd).toBeCloseTo(2);
  });

  const optional = `costByDayUsd subagentCostByDayUsd unpricedByModel estimatedByModel
    unpricedByDay estimatedByDay byteEstimates attribution`;
  it.each(optional.split(/\s+/))(
    'keeps %s absent when neither file has it, since absent and empty read differently',
    (k) => {
      expect(pair({}, {})[k]).toBeUndefined();
    },
  );

  it('keeps a day map or a ledger only one file has, with its cost', () => {
    expect(pair({ costByDayUsd: { d: 0.1 } }, {}).costByDayUsd).toEqual({ d: 0.1 });
    const combined = pair({ exactTotals: { costUsd: 1 }, byteEstimates: ledger(2) }, {});
    expect(combined.byteEstimates?.costUsd).toBe(2);
    expect(combined.estimatedCostUsd).toBeCloseTo(1 + 2 + 0.1);
  });

  it('adds the calls a ledger holds per model and per day', () => {
    const usage = (calls: number) => ({ m: { calls, tokens: calls } });
    const side = (calls: number) => ({
      unpricedByModel: usage(2 * calls),
      unpricedByDay: { d: usage(2 * calls) },
      byteEstimates: ledger(0, {
        unpricedByModel: usage(calls),
        unpricedByDay: { d: usage(calls) },
      }),
    });
    const combined = pair(side(1), side(3));
    expect(combined.byteEstimates?.unpricedByModel?.m.calls).toBe(4);
    expect(combined.byteEstimates?.unpricedByDay?.d.m.calls).toBe(4);
    expect(combined.unpricedByModel?.m.calls).toBe(8);
    expect(combined.unpricedByDay?.d.m.calls).toBe(8);
  });

  it('drops the day split only when a file has calls but no day split', () => {
    const usage = { m: { calls: 2, tokens: 2 } };
    const split = { unpricedByModel: usage, unpricedByDay: { d: usage } };
    const combined = pair({ unpricedByModel: usage }, split);
    expect(combined.unpricedByModel?.m.calls).toBe(4);
    expect(combined.unpricedByDay).toBeUndefined();
    expect(pair(split, { unpricedByModel: usage }).unpricedByDay).toBeUndefined();
    expect(pair({}, split).unpricedByDay?.d.m.calls).toBe(2);
  });

  it('drops a bucket dollar split that one file with cost does not have', () => {
    const usd = (inputUsd: number) => ({
      inputUsd,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheCreationUsd: 0,
    });
    const bucket = (costUsd: number, breakdownUsd?: ReturnType<typeof usd>) => ({
      attribution: {
        buckets: { tool: { Read: { costUsd, tokens: 1, count: 1, durationMs: 1, breakdownUsd } } },
        highContextCostUsd: 0,
        apiDurationMs: null,
      },
    });
    const split = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      pair(a, b).attribution?.buckets.tool?.Read;
    expect(split(bucket(1, usd(1)), bucket(2))?.breakdownUsd).toBeUndefined();
    expect(split(bucket(2), bucket(1, usd(1)))?.breakdownUsd).toBeUndefined();
    expect(split(bucket(1, usd(1)), bucket(0))?.breakdownUsd?.inputUsd).toBe(1);
    expect(split(bucket(1, usd(1)), bucket(2, usd(2)))?.breakdownUsd?.inputUsd).toBe(3);
    expect(split(bucket(1, usd(1)), bucket(2, usd(2)))?.costUsd).toBe(3);
    expect(pair(bucket(1), bucket(2)).attribution?.apiDurationMs).toBeNull();
    const timed = { attribution: { buckets: {}, highContextCostUsd: 0, apiDurationMs: 5 } };
    expect(pair(bucket(1), timed).attribution?.apiDurationMs).toBe(5);
  });

  it('weights rates and scores only where both files can be weighted', () => {
    const scored = (score: number | null, efficiencyScoreSampleCount: number, parts = true) => ({
      efficiencyScore: score,
      efficiencyScoreSampleCount,
      efficiencyScoreComponents: parts
        ? { speed: score, correctness: score, autonomy: score, firstAttemptQuality: score }
        : null,
    });
    expect(pair(scored(0.2, 1), scored(0.8, 3))).toMatchObject({ efficiencyScoreSampleCount: 4 });
    expect(pair(scored(0.2, 1), scored(0.8, 3)).efficiencyScore).toBeCloseTo(0.65);
    expect(pair(scored(0.2, 1), scored(null, 0)).efficiencyScore).toBe(0.2);
    expect(pair(scored(0.2, 0), scored(0.8, 3)).efficiencyScore).toBe(0.8);
    expect(pair(scored(0.2, 5), scored(0.8, 3, false)).efficiencyScore).toBe(0.2);
    expect(pair({ toolSuccessRate: 0.5 }, { toolSuccessRate: null }).toolSuccessRate).toBe(0.5);
    expect(
      pair({ toolSuccessRate: 0.5, toolCallCount: 0 }, { toolSuccessRate: 1, toolCallCount: 0 })
        .toolSuccessRate,
    ).toBe(0.75);
  });

  it('pools tests for the task rate, or weights by tasks when a file ran none', () => {
    const tests = (runs: number, passes: number, rate: number, taskCount: number) => ({
      testRunCount: runs,
      testPassCount: passes,
      taskSuccessRate: rate,
      taskCount,
    });
    expect(pair(tests(100, 50, 0.5, 1), tests(1, 1, 1, 9)).taskSuccessRate).toBe(0.505);
    expect(pair(tests(0, 0, 0.5, 1), tests(1, 1, 1, 3)).taskSuccessRate).toBeCloseTo(0.875);
    expect(pair(tests(1, 1, 1, 3), tests(0, 0, 0.5, 1)).taskSuccessRate).toBeCloseTo(0.875);
  });
});

describe('the byte-estimate ledger', () => {
  const file = (start: number, exact: number, ledger: number, extra = {}) =>
    summary({
      startTime: start,
      endTime: start + 1000,
      toolCallCount: 1,
      timeline: [entry(start)],
      estimatedCostUsd: exact + ledger,
      exactTotals: { costUsd: exact },
      byteEstimates: { costUsd: ledger },
      ...extra,
    });

  it('adds the ledgers of separate files', () => {
    const combined = combineInEveryOrder([file(START, 1, 4), file(START + DAY, 1, 4)]);
    expect(combined.byteEstimates?.costUsd).toBe(8);
    expect(combined.estimatedCostUsd).toBeCloseTo(10);
  });

  it('keeps the sum ledger beside a newer file without a timeline', () => {
    const newer = summary({
      endTime: START + 3 * DAY,
      estimatedCostUsd: 1,
      exactTotals: { costUsd: 1 },
      byteEstimates: { costUsd: 0 },
    });
    const combined = combineInEveryOrder([file(START, 1, 4), file(START + DAY, 1, 4), newer]);
    expect(combined.estimatedCostUsd).toBeCloseTo(10);
  });

  it('takes the ledger of the latest copy when calls and exact cost tie', () => {
    const before = file(START, 1, 4, { timeline: [entry(START), entry(START + 1)] });
    const retracted = file(START, 1, 0, { endTime: START + 5000, timeline: [entry(START + 1)] });
    expect(combineInEveryOrder([before, retracted]).estimatedCostUsd).toBeCloseTo(1);
  });

  it('takes the ledger of the copy further along, even if a stale copy was saved later', () => {
    const stale = file(START, 0, 4, { endTime: START + 9 * DAY });
    const folded = file(START, 0, 8, {
      toolCallCount: 2,
      timeline: [entry(START), entry(START + DAY)],
    });
    expect(combineInEveryOrder([stale, folded]).estimatedCostUsd).toBeCloseTo(8);
    expect(combineInEveryOrder([stale, file(START, 3, 0)]).estimatedCostUsd).toBeCloseTo(3);
  });
});

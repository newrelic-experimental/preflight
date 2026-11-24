import { describe, it, expect } from '@jest/globals';
import { computeUsageInsights } from './usage-insights.js';
import { lastDaysWindow } from '../storage/session-window.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type {
  AttributionBucket,
  ReplayTimelineEntry,
  SessionAttribution,
} from '../storage/types.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';
import { localDateKey, localStartOfDay } from '../lib/date.js';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let sessionCounter = 0;

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  sessionCounter += 1;
  return {
    sessionId: `sess-${sessionCounter}`,
    sessionName: null,
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    startTime: NOW - 60_000,
    endTime: NOW,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    model: 'claude-sonnet-4-20250514',
    toolBreakdown: { Read: 5, Edit: 3, Bash: 2 },
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
    estimatedCostUsd: 1,
    subagentCostUsd: 0,
    tokensInput: 100,
    tokensOutput: 100,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensThinking: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: null,
    toolSelectionMetrics: null,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
    antiPatterns: [],
    taskCount: 0,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

function bucket(overrides?: Partial<AttributionBucket>): AttributionBucket {
  return { costUsd: 0, tokens: 0, count: 0, durationMs: 0, ...overrides };
}

function attribution(overrides?: Partial<SessionAttribution>): SessionAttribution {
  return { buckets: {}, highContextCostUsd: 0, apiDurationMs: null, ...overrides };
}

function scheduleWakeupEntry(timestamp: number): ReplayTimelineEntry {
  return { timestamp, toolName: 'ScheduleWakeup', durationMs: null, success: true };
}

describe('computeUsageInsights', () => {
  it('returns an empty report for an empty window', () => {
    const report = computeUsageInsights([], { nowMs: NOW, windowDays: 7 });
    expect(report).toEqual({
      windowDays: 7,
      sessionCount: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      insights: [],
      skills: [],
      skillsTotalCount: 0,
      subagents: [],
      subagentsTotalCount: 0,
      plugins: [],
      pluginsTotalCount: 0,
      loops: [],
      loopsTotalCount: 0,
      attributionRatePct: null,
      sessions: [],
    });
  });

  it('excludes sessions outside the window and sums cost/tokens for the rest', () => {
    const inWindow = makeSummary({
      startTime: NOW - 2 * DAY_MS,
      estimatedCostUsd: 3,
      tokensInput: 100,
      tokensOutput: 50,
      tokensCacheRead: 10,
      tokensCacheCreation: 5,
    });
    const outOfWindow = makeSummary({
      startTime: NOW - 10 * DAY_MS,
      endTime: NOW - 10 * DAY_MS + 60_000,
      estimatedCostUsd: 100,
    });

    const report = computeUsageInsights([inWindow, outOfWindow], { nowMs: NOW, windowDays: 7 });

    expect(report.sessionCount).toBe(1);
    expect(report.totalCostUsd).toBe(3);
    expect(report.totalTokens).toBe(165);
  });

  it('includes tokensThinking in the session and window token totals', () => {
    const session = makeSummary({
      startTime: NOW - 2 * DAY_MS,
      tokensInput: 100,
      tokensOutput: 50,
      tokensCacheRead: 10,
      tokensCacheCreation: 5,
      tokensThinking: 40,
    });

    const report = computeUsageInsights([session], { nowMs: NOW, windowDays: 7 });

    expect(report.totalTokens).toBe(205);
  });

  it('counts the in-window share of a session started before the window and active now', () => {
    const startedNineDaysAgo = makeSummary({
      startTime: NOW - 9 * DAY_MS,
      endTime: NOW,
      estimatedCostUsd: 90,
      costByDayUsd: { [localDateKey(NOW - 9 * DAY_MS)]: 60, [localDateKey(NOW)]: 30 },
    });

    const report = computeUsageInsights([startedNineDaysAgo], { nowMs: NOW, windowDays: 7 });

    expect(report.sessionCount).toBe(1);
    expect(report.totalCostUsd).toBeCloseTo(30, 9);
  });

  it("rows carry each session's in-window share, with its cost on the days it was spent", () => {
    const windowStart = lastDaysWindow(NOW, 7).startMs;
    const resumed = NOW - 2 * DAY_MS;
    const report = computeUsageInsights(
      [
        // No day map: half its active time is in the window.
        makeSummary({
          sessionId: 'resumed',
          startTime: windowStart - 2 * DAY_MS,
          endTime: windowStart + 2 * DAY_MS,
          durationMs: 4 * DAY_MS,
          estimatedCostUsd: 4,
          tokensInput: 1000,
          tokensCacheRead: 400,
          toolBreakdown: { Read: 6, Edit: 1, Write: 0 },
          efficiencyScore: 0.7,
          toolSuccessRate: 0.9,
          antiPatterns: [{ type: 'thrashing' } as FullSessionSummary['antiPatterns'][number]],
        }),
        makeSummary({
          sessionId: 'two-days',
          startTime: resumed,
          estimatedCostUsd: 3,
          costByDayUsd: { [localDateKey(resumed)]: 1, [localDateKey(NOW)]: 1 },
        }),
      ],
      { nowMs: NOW, windowDays: 7 },
    );
    const [noMap, twoDays] = report.sessions;
    expect(noMap).toEqual({
      sessionId: 'resumed',
      model: 'claude-sonnet-4-20250514',
      estimatedCostUsd: 2,
      costByDayUsd: { [localDateKey(windowStart)]: 2 },
      efficiencyScore: 0.7,
      toolSuccessRate: 0.9,
      antiPatterns: [{ type: 'thrashing' }],
      toolBreakdown: { Read: 3, Edit: 1 },
      tokensInput: 500,
      tokensOutput: 50,
      tokensThinking: 0,
      tokensCacheRead: 200,
      tokensCacheCreation: 0,
    });
    // A day map that sums short of the session's cost is scaled up to it.
    expect(twoDays.costByDayUsd).toEqual({
      [localDateKey(resumed)]: 1.5,
      [localDateKey(NOW)]: 1.5,
    });
  });

  it('rows sum on in-window days to the total for a session with cost booked before the window', () => {
    const windowStart = lastDaysWindow(NOW, 7).startMs;
    const firstDay = localDateKey(windowStart);
    const report = computeUsageInsights(
      [
        makeSummary({
          startTime: windowStart + 10 * 60_000,
          endTime: windowStart + 60 * 60_000,
          estimatedCostUsd: 1,
          costByDayUsd: { [localDateKey(windowStart - 60 * 60_000)]: 0.4, [firstDay]: 0.6 },
        }),
      ],
      { nowMs: NOW, windowDays: 7 },
    );
    const chartSum = report.sessions
      .flatMap((r) => Object.entries(r.costByDayUsd))
      .filter(([day]) => day >= firstDay)
      .reduce((sum, [, usd]) => sum + usd, 0);
    expect(report.totalCostUsd).toBeCloseTo(0.6, 10);
    expect(chartSum).toBeCloseTo(report.totalCostUsd, 10);
  });

  describe("selection: 'today'", () => {
    const TODAY_START = localStartOfDay(NOW);
    const TODAY_NOW = TODAY_START + 6 * 60 * 60 * 1000;
    const today = (sessions: FullSessionSummary[]) =>
      computeUsageInsights(sessions, { selection: 'today', nowMs: TODAY_NOW });

    it('counts only the in-window share of costByDayUsd for a session open for days', () => {
      const tenDays = makeSummary({
        startTime: TODAY_NOW - 10 * DAY_MS,
        endTime: TODAY_NOW,
        durationMs: 10 * DAY_MS,
        estimatedCostUsd: 100,
        costByDayUsd: {
          [localDateKey(TODAY_NOW - 9 * DAY_MS)]: 50,
          [localDateKey(TODAY_NOW - 2 * DAY_MS)]: 40,
          [localDateKey(TODAY_NOW)]: 10,
        },
        tokensInput: 1000,
        tokensOutput: 1000,
        subagentCostUsd: 50,
        toolBreakdown: { ScheduleWakeup: 3 },
        attribution: attribution({
          highContextCostUsd: 20,
          buckets: {
            tool: { Read: bucket({ costUsd: 80, tokens: 1000 }) },
            skill: {
              'pstack:unslop': bucket({
                costUsd: 30,
                tokens: 600,
                count: 3,
                breakdownUsd: { inputUsd: 10, outputUsd: 20, cacheReadUsd: 0, cacheCreationUsd: 0 },
              }),
            },
            subagent: { Explore: bucket({ costUsd: 50, tokens: 800, count: 2 }) },
          },
        }),
      });

      const report = today([tenDays]);

      expect(report.windowDays).toBe(1);
      expect(report.sessionCount).toBe(1);
      expect(report.totalCostUsd).toBeCloseTo(10, 9);
      expect(report.totalTokens).toBe(200);
      expect(report.skills[0]).toMatchObject({ key: 'pstack:unslop', tokens: 60 });
      expect(report.skills[0]!.costUsd).toBeCloseTo(3, 9);
      expect(report.skills[0]!.breakdownUsd!.inputUsd).toBeCloseTo(1, 9);
      expect(report.skills[0]!.breakdownUsd!.outputUsd).toBeCloseTo(2, 9);
      expect(report.subagents[0]).toMatchObject({ key: 'Explore', tokens: 80 });
      expect(report.subagents[0]!.costUsd).toBeCloseTo(5, 9);
      expect(report.plugins[0]).toMatchObject({ key: 'pstack', tokens: 60 });
      expect(report.plugins[0]!.costUsd).toBeCloseTo(3, 9);
      expect(report.loops[0]).toMatchObject({ runs: 4, tokens: 200 });
      expect(report.loops[0]!.costUsd).toBeCloseTo(10, 9);
      const byId = Object.fromEntries(report.insights.map((i) => [i.id, i]));
      expect(byId.high_context!.costUsd).toBeCloseTo(2, 9);
      expect(byId.subagent_heavy!.costUsd).toBeCloseTo(10, 9);
      expect(byId.long_sessions!.tokens).toBe(200);
      expect(report.attributionRatePct).toBe(80);
    });

    it('excludes a session whose costByDayUsd has nothing for today', () => {
      const idleToday = makeSummary({
        startTime: TODAY_NOW - 3 * DAY_MS,
        endTime: TODAY_NOW,
        estimatedCostUsd: 100,
        costByDayUsd: { [localDateKey(TODAY_NOW - 3 * DAY_MS)]: 100 },
      });

      const report = today([idleToday]);

      expect(report.sessionCount).toBe(0);
      expect(report.totalCostUsd).toBe(0);
    });

    it('without costByDayUsd, weights by time overlap with today', () => {
      const halfToday = makeSummary({
        startTime: TODAY_START - 6 * 60 * 60 * 1000,
        endTime: TODAY_NOW,
        estimatedCostUsd: 4,
        tokensInput: 100,
        tokensOutput: 100,
      });

      const report = today([halfToday]);

      expect(report.sessionCount).toBe(1);
      expect(report.totalCostUsd).toBeCloseTo(2, 9);
      expect(report.totalTokens).toBe(100);
    });

    it('without costByDayUsd or any calls, subagent cost or timeline, counts none of its cost today', () => {
      const unattributable = { toolCallCount: 0, timeline: [], estimatedCostUsd: 4 };
      const report = today([makeSummary({ ...unattributable, startTime: TODAY_START - 1000 })]);
      expect(report.totalCostUsd).toBe(0);
      expect(report.totalTokens).toBe(0);
    });

    it.each([0, null])(
      'counts an unpriced session (estimatedCostUsd %p) that overlaps today, with pro-rated tokens',
      (estimatedCostUsd) => {
        const unpriced = makeSummary({
          startTime: TODAY_START - 6 * 60 * 60 * 1000,
          endTime: TODAY_NOW,
          estimatedCostUsd,
          tokensInput: 100,
          tokensOutput: 100,
        });

        const report = today([unpriced]);

        expect(report.sessionCount).toBe(1);
        expect(report.totalCostUsd).toBe(0);
        expect(report.totalTokens).toBe(100);
      },
    );

    it('excludes a session that ended before local midnight', () => {
      const ended = makeSummary({
        startTime: TODAY_START - 30 * 60_000,
        endTime: TODAY_START - 10 * 60_000,
      });

      expect(today([ended]).sessionCount).toBe(0);
    });

    it('counts a session with an unknown endTime of 0 that started today', () => {
      const unknownEnd = makeSummary({
        startTime: TODAY_START + 60 * 60_000,
        endTime: 0,
        durationMs: 0,
        estimatedCostUsd: 3,
      });

      const report = today([unknownEnd]);

      expect(report.sessionCount).toBe(1);
      expect(report.totalCostUsd).toBeCloseTo(3, 9);
    });

    it('falls back to startTime + durationMs when endTime is before startTime', () => {
      const spanning = makeSummary({
        startTime: TODAY_START - 30 * 60_000,
        endTime: TODAY_START - 60 * 60_000,
        durationMs: 60 * 60_000,
        estimatedCostUsd: 4,
      });

      const report = today([spanning]);

      expect(report.sessionCount).toBe(1);
      expect(report.totalCostUsd).toBeCloseTo(2, 9);
    });
  });

  it('treats a null estimatedCostUsd as 0', () => {
    const s = makeSummary({ startTime: NOW - DAY_MS, estimatedCostUsd: null });
    const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });
    expect(report.totalCostUsd).toBe(0);
  });

  describe('high_context insight', () => {
    it('sums attribution.highContextCostUsd and reports its share', () => {
      const a = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 4,
        attribution: attribution({ highContextCostUsd: 1 }),
      });
      const b = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 6,
        attribution: attribution({ highContextCostUsd: 0 }),
      });

      const report = computeUsageInsights([a, b], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'high_context');
      expect(insight).toBeDefined();
      expect(insight!.costUsd).toBe(1);
      expect(insight!.sharePct).toBe(10);
      expect(insight!.sessionCount).toBe(1);
      expect(insight!.headline).toBe('10% of your spend was at >150k context');
      expect(insight!.advice).toMatch(/compact mid-task/);
    });

    it('is dropped from insights when its share rounds to 0', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 1000,
        attribution: attribution({ highContextCostUsd: 0 }),
      });
      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });
      expect(report.insights.find((i) => i.id === 'high_context')).toBeUndefined();
    });
  });

  describe('subagent_heavy insight', () => {
    it('counts the whole session cost when subagentCostUsd >= 25% of estimatedCostUsd', () => {
      const heavy = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 4,
        subagentCostUsd: 1, // exactly 25%
      });
      const light = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 4,
        subagentCostUsd: 0.5, // below 25%
      });

      const report = computeUsageInsights([heavy, light], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'subagent_heavy');
      expect(insight).toBeDefined();
      expect(insight!.costUsd).toBe(4);
      expect(insight!.sessionCount).toBe(1);
      expect(insight!.headline).toBe('50% of your spend came from subagent-heavy sessions');
    });

    it('never contributes when estimatedCostUsd is 0', () => {
      const s = makeSummary({ startTime: NOW - DAY_MS, estimatedCostUsd: 0, subagentCostUsd: 0 });
      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });
      expect(report.insights.find((i) => i.id === 'subagent_heavy')).toBeUndefined();
    });
  });

  describe('long_sessions insight', () => {
    it('counts sessions with durationMs >= 8h', () => {
      const long = makeSummary({
        startTime: NOW - DAY_MS,
        durationMs: 8 * 60 * 60 * 1000,
        estimatedCostUsd: 2,
      });
      const short = makeSummary({
        startTime: NOW - DAY_MS,
        durationMs: 8 * 60 * 60 * 1000 - 1,
        estimatedCostUsd: 8,
      });

      const report = computeUsageInsights([long, short], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'long_sessions');
      expect(insight).toBeDefined();
      expect(insight!.costUsd).toBe(2);
      expect(insight!.headline).toBe('20% of your spend came from sessions active for 8+ hours');
    });
  });

  describe('loops insight and table', () => {
    it('identifies a loop session via toolBreakdown.ScheduleWakeup > 0', () => {
      const loop = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 5,
        toolBreakdown: { ScheduleWakeup: 2 },
        tokensInput: 300,
        tokensOutput: 300,
        timeline: [scheduleWakeupEntry(NOW - 1000), scheduleWakeupEntry(NOW - 500)],
      });
      const notLoop = makeSummary({ startTime: NOW - DAY_MS, estimatedCostUsd: 5 });

      const report = computeUsageInsights([loop, notLoop], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'loops');
      expect(insight).toBeDefined();
      expect(insight!.costUsd).toBe(5);
      expect(insight!.headline).toBe('50% of your spend came from /loop sessions');

      expect(report.loops).toHaveLength(1);
      const row = report.loops[0]!;
      expect(row.sessionId).toBe(loop.sessionId);
      expect(row.runs).toBe(3); // 2 wakeups + 1 initial run
      expect(row.tokens).toBe(600);
      expect(row.tokensPerRun).toBe(200);
      expect(row.costUsd).toBe(5);
      expect(row.lastRunMs).toBe(NOW - 500);
    });

    it('identifies a loop session via a "loop" skill bucket even with no ScheduleWakeup calls', () => {
      const loop = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 3,
        attribution: attribution({
          buckets: { skill: { loop: bucket({ costUsd: 3, count: 1 }) } },
        }),
      });

      const report = computeUsageInsights([loop], { nowMs: NOW, windowDays: 7 });

      expect(report.loops).toHaveLength(1);
      expect(report.loops[0]!.runs).toBe(1); // no wakeups: just the initial run
    });

    it('falls back to endTime when a loop session has no ScheduleWakeup timeline entries', () => {
      const loop = makeSummary({
        startTime: NOW - DAY_MS,
        endTime: NOW - 200,
        estimatedCostUsd: 1,
        toolBreakdown: { ScheduleWakeup: 1 },
      });

      const report = computeUsageInsights([loop], { nowMs: NOW, windowDays: 7 });

      expect(report.loops[0]!.lastRunMs).toBe(NOW - 200);
    });

    it('caps the loops table at 10 rows, sorted by cost descending', () => {
      const sessions = Array.from({ length: 12 }, (_, i) =>
        makeSummary({
          startTime: NOW - DAY_MS,
          estimatedCostUsd: i + 1,
          toolBreakdown: { ScheduleWakeup: 1 },
        }),
      );

      const report = computeUsageInsights(sessions, { nowMs: NOW, windowDays: 7 });

      expect(report.loops).toHaveLength(10);
      expect(report.loops[0]!.costUsd).toBe(12);
      expect(report.loops[9]!.costUsd).toBe(3);
      expect(report.loopsTotalCount).toBe(12);
    });
  });

  describe('plugins insight and table', () => {
    it('sums plugin-prefixed skill and subagent buckets, naming the single contributing plugin', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 10,
        attribution: attribution({
          buckets: {
            skill: {
              'pstack:unslop': bucket({ costUsd: 2, tokens: 100, count: 1 }),
              'no-prefix-skill': bucket({ costUsd: 1 }),
            },
            subagent: {
              'pstack:how': bucket({ costUsd: 1, tokens: 50, count: 1 }),
            },
          },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'plugins');
      expect(insight).toBeDefined();
      expect(insight!.costUsd).toBe(3);
      expect(insight!.headline).toBe('30% of your spend came from the plugin "pstack"');
      expect(report.plugins).toEqual([
        { key: 'pstack', costUsd: 3, tokens: 150, count: 2, sharePct: 30 },
      ]);
      expect(report.pluginsTotalCount).toBe(1);
    });

    it('falls back to the plural headline when more than one plugin contributes', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 10,
        attribution: attribution({
          buckets: {
            skill: {
              'pstack:unslop': bucket({ costUsd: 2 }),
              'other:thing': bucket({ costUsd: 1 }),
            },
          },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      const insight = report.insights.find((i) => i.id === 'plugins');
      expect(insight!.headline).toBe('30% of your spend came from plugins');
    });

    it('excludes keys without a plugin prefix', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 10,
        attribution: attribution({
          buckets: { skill: { unslop: bucket({ costUsd: 5 }) } },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.plugins).toEqual([]);
      expect(report.pluginsTotalCount).toBe(0);
      expect(report.insights.find((i) => i.id === 'plugins')).toBeUndefined();
    });

    it('caps the plugins table at 10 rows and reports the total distinct count', () => {
      const skillBuckets: Record<string, AttributionBucket> = {};
      for (let i = 0; i < 12; i++) {
        skillBuckets[`plugin-${i}:skill`] = bucket({ costUsd: i + 1 });
      }
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({ buckets: { skill: skillBuckets } }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.plugins).toHaveLength(10);
      expect(report.pluginsTotalCount).toBe(12);
    });
  });

  describe('skills and subagents tables', () => {
    it('sums buckets per key across sessions and sorts by cost descending', () => {
      const a = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: { skill: { unslop: bucket({ costUsd: 1, tokens: 10, count: 1 }) } },
        }),
      });
      const b = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: {
            skill: {
              unslop: bucket({ costUsd: 4, tokens: 40, count: 3 }),
              how: bucket({ costUsd: 2, tokens: 20, count: 1 }),
            },
          },
        }),
      });

      const report = computeUsageInsights([a, b], { nowMs: NOW, windowDays: 7 });

      expect(report.skills[0]).toMatchObject({ key: 'unslop', costUsd: 5, tokens: 50, count: 4 });
      expect(report.skills[1]).toMatchObject({ key: 'how', costUsd: 2, tokens: 20, count: 1 });
    });

    it('sums the subagents table from attribution.buckets.subagent', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 3,
        attribution: attribution({
          buckets: {
            subagent: { 'general-purpose': bucket({ costUsd: 3, tokens: 30, count: 2 }) },
          },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.subagents).toEqual([
        { key: 'general-purpose', costUsd: 3, tokens: 30, count: 2, sharePct: 100 },
      ]);
    });

    it('sums breakdown per key across sessions that have one', () => {
      const a = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: {
            skill: {
              unslop: bucket({
                costUsd: 1,
                tokens: 100,
                count: 1,
                breakdown: {
                  inputTokens: 60,
                  outputTokens: 20,
                  cacheReadTokens: 10,
                  cacheCreationTokens: 10,
                },
              }),
            },
          },
        }),
      });
      const b = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: {
            skill: {
              unslop: bucket({
                costUsd: 2,
                tokens: 200,
                count: 2,
                breakdown: {
                  inputTokens: 120,
                  outputTokens: 40,
                  cacheReadTokens: 20,
                  cacheCreationTokens: 20,
                },
              }),
            },
          },
        }),
      });

      const report = computeUsageInsights([a, b], { nowMs: NOW, windowDays: 7 });

      expect(report.skills[0]!.breakdown).toEqual({
        inputTokens: 180,
        outputTokens: 60,
        cacheReadTokens: 30,
        cacheCreationTokens: 30,
      });
    });

    it('sums breakdownUsd per key, and drops it when a bucket with spend predates it', () => {
      const usd = (n: number) => ({
        inputUsd: n,
        outputUsd: 2 * n,
        cacheReadUsd: 3 * n,
        cacheCreationUsd: 4 * n,
      });
      const withUsd = (n: number): FullSessionSummary =>
        makeSummary({
          startTime: NOW - DAY_MS,
          attribution: attribution({
            buckets: {
              skill: { unslop: bucket({ costUsd: 1, tokens: 10, count: 1, breakdownUsd: usd(n) }) },
            },
          }),
        });
      const legacy = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: { skill: { unslop: bucket({ costUsd: 1, tokens: 10, count: 1 }) } },
        }),
      });

      const complete = computeUsageInsights([withUsd(1), withUsd(2)], {
        nowMs: NOW,
        windowDays: 7,
      });
      const partial = computeUsageInsights([withUsd(1), legacy], { nowMs: NOW, windowDays: 7 });

      expect(complete.skills[0]!.breakdownUsd).toEqual(usd(3));
      expect(partial.skills[0]!.breakdownUsd).toBeUndefined();
    });

    it('omits breakdown from a row when no contributing bucket had one', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({
          buckets: { skill: { unslop: bucket({ costUsd: 1, tokens: 10, count: 1 }) } },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.skills[0]!.breakdown).toBeUndefined();
    });

    it('caps the skills table at 10 rows', () => {
      const skillBuckets: Record<string, AttributionBucket> = {};
      for (let i = 0; i < 12; i++) {
        skillBuckets[`skill-${i}`] = bucket({ costUsd: i + 1 });
      }
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({ buckets: { skill: skillBuckets } }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.skills).toHaveLength(10);
      expect(report.skills[0]!.key).toBe('skill-11');
      expect(report.skillsTotalCount).toBe(12);
    });

    it('caps the subagents table at 10 rows and reports the total distinct count', () => {
      const subagentBuckets: Record<string, AttributionBucket> = {};
      for (let i = 0; i < 12; i++) {
        subagentBuckets[`agent-${i}`] = bucket({ costUsd: i + 1 });
      }
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        attribution: attribution({ buckets: { subagent: subagentBuckets } }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.subagents).toHaveLength(10);
      expect(report.subagentsTotalCount).toBe(12);
    });
  });

  describe('attributionRatePct', () => {
    it('is null when no session in the window has attribution', () => {
      const s = makeSummary({ startTime: NOW - DAY_MS, estimatedCostUsd: 5 });
      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });
      expect(report.attributionRatePct).toBeNull();
    });

    it('sums tool-bucket cost across sessions as a share of total spend', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 10,
        attribution: attribution({
          buckets: { tool: { Read: bucket({ costUsd: 3 }), Bash: bucket({ costUsd: 1 }) } },
        }),
      });

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.attributionRatePct).toBe(40);
    });

    it('is 0 (not null) when a session carries attribution but total spend is 0', () => {
      const s = makeSummary({
        startTime: NOW - DAY_MS,
        estimatedCostUsd: 0,
        attribution: attribution(),
      });
      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });
      expect(report.attributionRatePct).toBe(0);
    });
  });

  it('sorts insights by share descending', () => {
    const s = makeSummary({
      startTime: NOW - DAY_MS,
      estimatedCostUsd: 10,
      durationMs: 8 * 60 * 60 * 1000, // long_sessions: 100%
      subagentCostUsd: 3, // subagent_heavy: 100% (>= 25% of 10)
      attribution: attribution({ highContextCostUsd: 1 }), // high_context: 10%
    });

    const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

    const shares = report.insights.map((i) => i.sharePct);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(report.insights[0]!.sharePct).toBe(100);
    expect(report.insights[report.insights.length - 1]!.id).toBe('high_context');
  });
});

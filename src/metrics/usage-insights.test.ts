import { describe, it, expect } from '@jest/globals';
import { computeUsageInsights } from './usage-insights.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type {
  AttributionBucket,
  ReplayTimelineEntry,
  SessionAttribution,
} from '../storage/types.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';

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
    const outOfWindow = makeSummary({ startTime: NOW - 10 * DAY_MS, estimatedCostUsd: 100 });

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

  it('uses cutoffMs instead of nowMs - windowDays * DAY_MS when given, while windowDays still reports as given', () => {
    const afterCutoff = makeSummary({ startTime: NOW - 30 * 60_000, estimatedCostUsd: 3 });
    const beforeCutoff = makeSummary({ startTime: NOW - 90 * 60_000, estimatedCostUsd: 100 });

    const report = computeUsageInsights([afterCutoff, beforeCutoff], {
      nowMs: NOW,
      windowDays: 1,
      cutoffMs: NOW - 60 * 60_000,
    });

    expect(report.sessionCount).toBe(1);
    expect(report.totalCostUsd).toBe(3);
    expect(report.windowDays).toBe(1);
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

    it('sums per-category dollars across sessions that persisted them', () => {
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
                  cost: {
                    inputUsd: 0.18,
                    outputUsd: 0.3,
                    cacheReadUsd: 0.003,
                    cacheCreationUsd: 0.0375,
                  },
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
                  cost: {
                    inputUsd: 0.12,
                    outputUsd: 0.2,
                    cacheReadUsd: 0.002,
                    cacheCreationUsd: 0.025,
                  },
                },
              }),
            },
          },
        }),
      });

      const report = computeUsageInsights([a, b], { nowMs: NOW, windowDays: 7 });

      expect(report.skills[0]!.breakdown?.cost).toEqual({
        inputUsd: 0.3,
        outputUsd: 0.5,
        cacheReadUsd: 0.005,
        cacheCreationUsd: 0.0625,
      });
    });

    it('omits category dollars when no contributing bucket persisted them', () => {
      const s = makeSummary({
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

      const report = computeUsageInsights([s], { nowMs: NOW, windowDays: 7 });

      expect(report.skills[0]!.breakdown).toEqual({
        inputTokens: 60,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 10,
      });
      expect(report.skills[0]!.breakdown?.cost).toBeUndefined();
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

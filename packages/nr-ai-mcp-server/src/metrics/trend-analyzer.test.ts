import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { getWeekDateRange } from '../storage/weekly-summary.js';
import {
  TrendAnalyzer,
  movingAverage,
  percentChange,
  significantChange,
} from './trend-analyzer.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-trend-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
  store = new SessionStore({ storagePath: tmpDir });
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}-${Math.random().toString(36).slice(2)}`,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    model: 'claude-sonnet-4-20250514',
    toolBreakdown: { Read: 5, Edit: 3, Bash: 2 },
    filesRead: ['/src/index.ts'],
    filesModified: ['/src/index.ts'],
    linesAdded: 20,
    linesRemoved: 0,
    bashCommandCount: 2,
    testRunCount: 2,
    testPassCount: 2,
    buildRunCount: 1,
    buildPassCount: 1,
    estimatedCostUsd: 0.05,
    tokensInput: 5000,
    tokensOutput: 2000,
    tokensThinking: 1000,
    efficiencyScore: 0.75,
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: 1,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeTrends
// ---------------------------------------------------------------------------

describe('TrendAnalyzer', () => {
  it('computes correct weekly efficiency trend from 4 weeks of data', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    // Create sessions in 4 consecutive weeks: W13-W16 of 2026
    const weeks = ['2026-W13', '2026-W14', '2026-W15', '2026-W16'];
    const scores = [0.6, 0.65, 0.7, 0.8];

    for (let i = 0; i < weeks.length; i++) {
      const { start } = getWeekDateRange(weeks[i]!);
      // Offset by 12h to avoid UTC/local timezone edge cases
      store.saveSession(makeSummary({
        sessionId: `s-w${i}`,
        startTime: start.getTime() + 43_200_000,
        efficiencyScore: scores[i]!,
      }));
    }

    const trends = analyzer.computeTrends();

    expect(trends.weeklyEfficiencyTrend).toHaveLength(4);
    expect(trends.weeklyEfficiencyTrend.map((d) => d.week)).toEqual(weeks);
    expect(trends.weeklyEfficiencyTrend.map((d) => d.value)).toEqual(scores);
  });

  it('aggregates weekly cost correctly across multiple sessions per week', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    const { start } = getWeekDateRange('2026-W16');

    // 3 sessions in the same week with different costs
    store.saveSession(makeSummary({
      sessionId: 's1',
      startTime: start.getTime() + 43_200_000,
      estimatedCostUsd: 0.10,
    }));
    store.saveSession(makeSummary({
      sessionId: 's2',
      startTime: start.getTime() + 43_201_000,
      estimatedCostUsd: 0.25,
    }));
    store.saveSession(makeSummary({
      sessionId: 's3',
      startTime: start.getTime() + 43_202_000,
      estimatedCostUsd: 0.15,
    }));

    const trends = analyzer.computeTrends();

    expect(trends.weeklyCostTrend).toHaveLength(1);
    expect(trends.weeklyCostTrend[0]!.week).toBe('2026-W16');
    expect(trends.weeklyCostTrend[0]!.value).toBe(0.5);
  });

  // ---------------------------------------------------------------------------
  // compareWeeks
  // ---------------------------------------------------------------------------

  it('compareWeeks returns correct deltas and percentage changes', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    const { start: startA } = getWeekDateRange('2026-W15');
    const { start: startB } = getWeekDateRange('2026-W16');

    // Week A: efficiency 0.6, cost $0.50, 4 tests run / 3 passed, 20 tool calls / 2 tasks
    store.saveSession(makeSummary({
      sessionId: 'a1',
      startTime: startA.getTime() + 43_200_000,
      efficiencyScore: 0.6,
      estimatedCostUsd: 0.50,
      testRunCount: 4,
      testPassCount: 3,
      toolCallCount: 20,
      taskCount: 2,
    }));

    // Week B: efficiency 0.8, cost $0.40, 5 tests run / 5 passed, 15 tool calls / 3 tasks
    store.saveSession(makeSummary({
      sessionId: 'b1',
      startTime: startB.getTime() + 43_200_000,
      efficiencyScore: 0.8,
      estimatedCostUsd: 0.40,
      testRunCount: 5,
      testPassCount: 5,
      toolCallCount: 15,
      taskCount: 3,
    }));

    const comparison = analyzer.compareWeeks('2026-W15', '2026-W16');

    expect(comparison.weekA).toBe('2026-W15');
    expect(comparison.weekB).toBe('2026-W16');

    // Efficiency: 0.8 - 0.6 = +0.2
    expect(comparison.efficiencyDelta).toBe(0.2);
    expect(comparison.efficiencyPctChange).toBeCloseTo(33.3, 0);

    // Cost: 0.40 - 0.50 = -0.10
    expect(comparison.costDelta).toBe(-0.1);
    expect(comparison.costPctChange).toBe(-20);

    // Task success: 1.0 - 0.75 = +0.25
    expect(comparison.taskSuccessDelta).toBe(0.25);
  });

  // ---------------------------------------------------------------------------
  // compareDeveloperToTeam
  // ---------------------------------------------------------------------------

  it('compareDeveloperToTeam correctly compares developer vs team average', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    const { start } = getWeekDateRange('2026-W16');

    // Alice: high efficiency
    store.saveSession(makeSummary({
      sessionId: 'alice-1',
      developer: 'alice',
      startTime: start.getTime() + 43_200_000,
      efficiencyScore: 0.8,
      estimatedCostUsd: 0.10,
    }));

    // Bob: lower efficiency
    store.saveSession(makeSummary({
      sessionId: 'bob-1',
      developer: 'bob',
      startTime: start.getTime() + 43_201_000,
      efficiencyScore: 0.4,
      estimatedCostUsd: 0.20,
    }));

    const comparison = analyzer.compareDeveloperToTeam('alice', '2026-W16');

    expect(comparison.developer).toBe('alice');
    expect(comparison.developerEfficiency).toBe(0.8);
    // Team average: (0.8 + 0.4) / 2 = 0.6
    expect(comparison.teamEfficiency).toBe(0.6);
    expect(comparison.developerCost).toBe(0.1);
    // Team total cost: 0.10 + 0.20 = 0.30
    expect(comparison.teamCost).toBe(0.3);
  });

  // ---------------------------------------------------------------------------
  // detectModelMigrationImpact
  // ---------------------------------------------------------------------------

  it('detectModelMigrationImpact compares sessions by model', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    // Opus sessions: expensive, high efficiency
    for (let i = 0; i < 3; i++) {
      store.saveSession(makeSummary({
        sessionId: `opus-${i}`,
        model: 'claude-opus-4-20250514',
        estimatedCostUsd: 4.0,
        efficiencyScore: 0.9,
      }));
    }

    // Sonnet sessions: cheaper, lower efficiency
    for (let i = 0; i < 2; i++) {
      store.saveSession(makeSummary({
        sessionId: `sonnet-${i}`,
        model: 'claude-sonnet-4-20250514',
        estimatedCostUsd: 2.0,
        efficiencyScore: 0.7,
      }));
    }

    const comparison = analyzer.detectModelMigrationImpact('opus', 'sonnet');

    expect(comparison.modelASessionCount).toBe(3);
    expect(comparison.modelBSessionCount).toBe(2);
    expect(comparison.modelACost).toBe(4.0); // avg per session
    expect(comparison.modelBCost).toBe(2.0);
    expect(comparison.modelAEfficiency).toBe(0.9);
    expect(comparison.modelBEfficiency).toBe(0.7);
  });

  // ---------------------------------------------------------------------------
  // generateWeekSummary
  // ---------------------------------------------------------------------------

  it('generateWeekSummary produces readable string with arrows', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    // Previous week (W15)
    const { start: startPrev } = getWeekDateRange('2026-W15');
    store.saveSession(makeSummary({
      sessionId: 'prev-1',
      startTime: startPrev.getTime() + 43_200_000,
      efficiencyScore: 0.6,
      estimatedCostUsd: 1.00,
      testRunCount: 10,
      testPassCount: 8,
    }));

    // Current week (W16)
    const { start: startCur } = getWeekDateRange('2026-W16');
    store.saveSession(makeSummary({
      sessionId: 'cur-1',
      startTime: startCur.getTime() + 43_200_000,
      efficiencyScore: 0.72,
      estimatedCostUsd: 0.84,
      testRunCount: 10,
      testPassCount: 9,
    }));

    const summary = analyzer.generateWeekSummary('2026-W16');

    expect(summary).toContain('Week 2026-W16');
    expect(summary).toContain('avg efficiency 0.72');
    expect(summary).toContain('total cost $0.84');
    // Efficiency went up → ↑
    expect(summary).toContain('\u2191');
    // Cost went down → ↑ (improvement)
    expect(summary).toContain('vs prev');
  });

  // ---------------------------------------------------------------------------
  // emitWeeklySummaryEvent
  // ---------------------------------------------------------------------------

  it('emitWeeklySummaryEvent emits expected metric names per developer', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });

    const { start } = getWeekDateRange('2026-W16');
    store.saveSession(makeSummary({
      sessionId: 'emit-alice',
      developer: 'alice',
      startTime: start.getTime() + 43_200_000,
      efficiencyScore: 0.8,
      estimatedCostUsd: 0.50,
      testRunCount: 5,
      testPassCount: 4,
    }));
    store.saveSession(makeSummary({
      sessionId: 'emit-bob',
      developer: 'bob',
      startTime: start.getTime() + 43_201_000,
      efficiencyScore: 0.6,
      estimatedCostUsd: 0.30,
      testRunCount: 3,
      testPassCount: 3,
    }));

    const recorded: Array<{ name: string; value: number; attrs?: Record<string, string | number> }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    analyzer.emitWeeklySummaryEvent('2026-W16', aggregator);

    const metricNames = recorded.map((r) => r.name);
    expect(metricNames).toContain('ai.trend.efficiency_score_weekly');
    expect(metricNames).toContain('ai.trend.cost_weekly');
    expect(metricNames).toContain('ai.trend.task_success_rate_weekly');

    // Should have metrics for both developers
    const developers = recorded.map((r) => r.attrs?.developer);
    expect(developers).toContain('alice');
    expect(developers).toContain('bob');
  });
});

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

describe('percentChange', () => {
  it('correctly computes positive and negative changes', () => {
    // 50 → 75 = +50%
    expect(percentChange(50, 75)).toBe(50);
    // 100 → 80 = -20%
    expect(percentChange(100, 80)).toBe(-20);
    // 0 → anything = 0 (avoid division by zero)
    expect(percentChange(0, 42)).toBe(0);
  });
});

describe('significantChange', () => {
  it('detects significant outlier in otherwise stable series', () => {
    // 5 values around 0.7, then a jump to 0.9
    const values = [0.70, 0.71, 0.69, 0.72, 0.68, 0.90];
    expect(significantChange(values)).toBe(true);
  });

  it('does not flag minor variation as significant', () => {
    const values = [0.70, 0.71, 0.69, 0.72, 0.68, 0.71];
    expect(significantChange(values)).toBe(false);
  });
});

describe('movingAverage', () => {
  it('smooths correctly with window size 3', () => {
    const values = [2, 4, 6, 8, 10];
    const result = movingAverage(values, 3);

    // i=0: avg(2) = 2
    // i=1: avg(2,4) = 3
    // i=2: avg(2,4,6) = 4
    // i=3: avg(4,6,8) = 6
    // i=4: avg(6,8,10) = 8
    expect(result).toEqual([2, 3, 4, 6, 8]);
  });

  it('returns empty array for empty input', () => {
    expect(movingAverage([], 3)).toEqual([]);
  });
});

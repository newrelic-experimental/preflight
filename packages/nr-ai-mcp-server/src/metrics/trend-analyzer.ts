/**
 * Cross-Session Trend Analysis — computes longitudinal metrics from stored
 * session data for weekly trends, comparisons, and text summaries.
 *
 * Operates on `FullSessionSummary[]` loaded from `SessionStore`, grouping
 * by ISO week to compute efficiency, cost, task success, tool call, and
 * anti-pattern trends over time.
 */

import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { createLogger } from '@nr-ai-observatory/shared';
import type { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { getIsoWeekId, getWeekDateRange } from '../storage/weekly-summary.js';

const logger = createLogger('trend-analyzer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeeklyDataPoint {
  readonly week: string;
  readonly value: number;
}

export interface AntiPatternWeeklyPoint {
  readonly week: string;
  readonly counts: Record<string, number>;
}

export interface TrendData {
  readonly weeklyEfficiencyTrend: WeeklyDataPoint[];
  readonly weeklyCostTrend: WeeklyDataPoint[];
  readonly weeklyTaskSuccessTrend: WeeklyDataPoint[];
  readonly weeklyToolCallTrend: WeeklyDataPoint[];
  readonly weeklyAntiPatternTrend: AntiPatternWeeklyPoint[];
}

export interface WeekComparison {
  readonly weekA: string;
  readonly weekB: string;
  readonly efficiencyDelta: number;
  readonly efficiencyPctChange: number;
  readonly costDelta: number;
  readonly costPctChange: number;
  readonly taskSuccessDelta: number;
  readonly taskSuccessPctChange: number;
  readonly toolCallDelta: number;
  readonly toolCallPctChange: number;
}

export interface DeveloperComparison {
  readonly developer: string;
  readonly week: string;
  readonly developerEfficiency: number | null;
  readonly teamEfficiency: number | null;
  readonly developerCost: number;
  readonly teamCost: number;
  readonly developerTaskSuccess: number;
  readonly teamTaskSuccess: number;
}

export interface ModelComparison {
  readonly modelA: string;
  readonly modelB: string;
  readonly modelACost: number;
  readonly modelBCost: number;
  readonly modelAEfficiency: number | null;
  readonly modelBEfficiency: number | null;
  readonly modelASessionCount: number;
  readonly modelBSessionCount: number;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/**
 * Simple moving average over a series of values.
 * For indices where the full window is not available, uses whatever
 * values are available (partial window at the start).
 */
export function movingAverage(values: number[], windowSize: number): number[] {
  if (values.length === 0 || windowSize <= 0) return [];

  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) {
      sum += values[j]!;
    }
    result.push(round(sum / (i - start + 1), 4));
  }
  return result;
}

/**
 * Percentage change from old to new value.
 * Returns 0 if oldValue is 0 (avoids division by zero).
 */
export function percentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return round(((newValue - oldValue) / Math.abs(oldValue)) * 100, 1);
}

/**
 * Detects whether the last value in the array is a significant outlier.
 * Uses z-score: computes mean and std of all values except the last,
 * then checks if the last value is beyond `threshold` standard deviations.
 */
export function significantChange(values: number[], threshold = 2.0): boolean {
  if (values.length < 3) return false;

  const previous = values.slice(0, -1);
  const last = values[values.length - 1]!;

  let sum = 0;
  for (const v of previous) sum += v;
  const mean = sum / previous.length;

  let sqDiffSum = 0;
  for (const v of previous) sqDiffSum += (v - mean) ** 2;
  const stdDev = Math.sqrt(sqDiffSum / previous.length);

  if (stdDev === 0) return last !== mean;

  const zScore = Math.abs(last - mean) / stdDev;
  return zScore >= threshold;
}

// ---------------------------------------------------------------------------
// Weekly aggregation helpers
// ---------------------------------------------------------------------------

interface WeekAggregates {
  efficiency: number | null;
  cost: number;
  taskSuccess: number;
  toolCallsPerTask: number;
  antiPatterns: Record<string, number>;
}

function aggregateWeek(sessions: FullSessionSummary[]): WeekAggregates {
  let totalCost = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let totalToolCalls = 0;
  let totalTasks = 0;
  let efficiencySum = 0;
  let efficiencyCount = 0;
  const antiPatterns: Record<string, number> = {};

  for (const s of sessions) {
    totalCost += s.estimatedCostUsd ?? 0;
    totalTestsRun += s.testRunCount;
    totalTestsPassed += s.testPassCount;
    totalToolCalls += s.toolCallCount;
    totalTasks += s.taskCount;

    if (s.efficiencyScore !== null) {
      efficiencySum += s.efficiencyScore;
      efficiencyCount++;
    }

    for (const ap of s.antiPatterns) {
      antiPatterns[ap.type] = (antiPatterns[ap.type] ?? 0) + ap.count;
    }
  }

  return {
    efficiency: efficiencyCount > 0 ? round(efficiencySum / efficiencyCount, 3) : null,
    cost: round(totalCost, 4),
    taskSuccess: totalTestsRun > 0 ? round(totalTestsPassed / totalTestsRun, 3) : 1,
    toolCallsPerTask: totalTasks > 0 ? round(totalToolCalls / totalTasks, 1) : 0,
    antiPatterns,
  };
}

function groupByWeek(sessions: FullSessionSummary[]): Map<string, FullSessionSummary[]> {
  const groups = new Map<string, FullSessionSummary[]>();
  for (const s of sessions) {
    const week = getIsoWeekId(new Date(s.startTime));
    const list = groups.get(week) ?? [];
    list.push(s);
    groups.set(week, list);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// TrendAnalyzer
// ---------------------------------------------------------------------------

export class TrendAnalyzer {
  private readonly sessionStore: SessionStore;

  constructor(options: { sessionStore: SessionStore }) {
    this.sessionStore = options.sessionStore;
  }

  computeTrends(options?: { since?: Date; developer?: string }): TrendData {
    const sessions = this.sessionStore.loadAllSessions({
      since: options?.since,
      developer: options?.developer,
    });

    const weekGroups = groupByWeek(sessions);
    const sortedWeeks = [...weekGroups.keys()].sort();

    const weeklyEfficiencyTrend: WeeklyDataPoint[] = [];
    const weeklyCostTrend: WeeklyDataPoint[] = [];
    const weeklyTaskSuccessTrend: WeeklyDataPoint[] = [];
    const weeklyToolCallTrend: WeeklyDataPoint[] = [];
    const weeklyAntiPatternTrend: AntiPatternWeeklyPoint[] = [];

    for (const week of sortedWeeks) {
      const agg = aggregateWeek(weekGroups.get(week)!);

      if (agg.efficiency !== null) {
        weeklyEfficiencyTrend.push({ week, value: agg.efficiency });
      }
      weeklyCostTrend.push({ week, value: agg.cost });
      weeklyTaskSuccessTrend.push({ week, value: agg.taskSuccess });
      weeklyToolCallTrend.push({ week, value: agg.toolCallsPerTask });
      weeklyAntiPatternTrend.push({ week, counts: agg.antiPatterns });
    }

    return {
      weeklyEfficiencyTrend,
      weeklyCostTrend,
      weeklyTaskSuccessTrend,
      weeklyToolCallTrend,
      weeklyAntiPatternTrend,
    };
  }

  compareWeeks(weekA: string, weekB: string): WeekComparison {
    const aggA = this.loadWeekAggregate(weekA);
    const aggB = this.loadWeekAggregate(weekB);

    return {
      weekA,
      weekB,
      efficiencyDelta: round((aggB.efficiency ?? 0) - (aggA.efficiency ?? 0), 3),
      efficiencyPctChange: percentChange(aggA.efficiency ?? 0, aggB.efficiency ?? 0),
      costDelta: round(aggB.cost - aggA.cost, 4),
      costPctChange: percentChange(aggA.cost, aggB.cost),
      taskSuccessDelta: round(aggB.taskSuccess - aggA.taskSuccess, 3),
      taskSuccessPctChange: percentChange(aggA.taskSuccess, aggB.taskSuccess),
      toolCallDelta: round(aggB.toolCallsPerTask - aggA.toolCallsPerTask, 1),
      toolCallPctChange: percentChange(aggA.toolCallsPerTask, aggB.toolCallsPerTask),
    };
  }

  compareDeveloperToTeam(developer: string, weekId: string): DeveloperComparison {
    const { start, end } = getWeekDateRange(weekId);
    const allSessions = this.sessionStore.loadAllSessions({ since: start });
    const weekSessions = allSessions.filter(
      (s) => s.startTime >= start.getTime() && s.startTime <= end.getTime(),
    );

    const devSessions = weekSessions.filter((s) => s.developer === developer);
    const teamSessions = weekSessions;

    const devAgg = aggregateWeek(devSessions);
    const teamAgg = aggregateWeek(teamSessions);

    return {
      developer,
      week: weekId,
      developerEfficiency: devAgg.efficiency,
      teamEfficiency: teamAgg.efficiency,
      developerCost: devAgg.cost,
      teamCost: teamAgg.cost,
      developerTaskSuccess: devAgg.taskSuccess,
      teamTaskSuccess: teamAgg.taskSuccess,
    };
  }

  detectModelMigrationImpact(modelA: string, modelB: string): ModelComparison {
    const allSessions = this.sessionStore.loadAllSessions();

    const sessionsA = allSessions.filter(
      (s) => s.model !== null && s.model.includes(modelA),
    );
    const sessionsB = allSessions.filter(
      (s) => s.model !== null && s.model.includes(modelB),
    );

    const aggA = aggregateWeek(sessionsA);
    const aggB = aggregateWeek(sessionsB);

    // Per-session average cost
    const avgCostA = sessionsA.length > 0 ? round(aggA.cost / sessionsA.length, 4) : 0;
    const avgCostB = sessionsB.length > 0 ? round(aggB.cost / sessionsB.length, 4) : 0;

    return {
      modelA,
      modelB,
      modelACost: avgCostA,
      modelBCost: avgCostB,
      modelAEfficiency: aggA.efficiency,
      modelBEfficiency: aggB.efficiency,
      modelASessionCount: sessionsA.length,
      modelBSessionCount: sessionsB.length,
    };
  }

  generateWeekSummary(weekId: string): string {
    const agg = this.loadWeekAggregate(weekId);

    // Try to load previous week for comparison
    const prevWeekId = getPreviousWeekId(weekId);
    const prevAgg = this.loadWeekAggregate(prevWeekId);
    const hasPrev = prevAgg.cost > 0 || prevAgg.efficiency !== null;

    const parts: string[] = [`Week ${weekId}:`];

    // Efficiency
    if (agg.efficiency !== null) {
      let effStr = `avg efficiency ${agg.efficiency}`;
      if (hasPrev && prevAgg.efficiency !== null) {
        const pct = percentChange(prevAgg.efficiency, agg.efficiency);
        const arrow = pct >= 0 ? '\u2191' : '\u2193';
        effStr += ` (${arrow}${Math.abs(pct)}% vs prev)`;
      }
      parts.push(effStr);
    }

    // Cost
    {
      let costStr = `total cost $${agg.cost}`;
      if (hasPrev && prevAgg.cost > 0) {
        const pct = percentChange(prevAgg.cost, agg.cost);
        // Lower cost = improvement, so flip arrow
        const arrow = pct <= 0 ? '\u2191' : '\u2193';
        costStr += ` (${arrow}${Math.abs(pct)}% vs prev)`;
      }
      parts.push(costStr);
    }

    // Task success
    {
      const rate = round(agg.taskSuccess * 100, 1);
      let successStr = `task success ${rate}%`;
      if (hasPrev) {
        const deltaPp = round((agg.taskSuccess - prevAgg.taskSuccess) * 100, 1);
        const arrow = deltaPp >= 0 ? '\u2191' : '\u2193';
        successStr += ` (${arrow}${Math.abs(deltaPp)}pp vs prev)`;
      }
      parts.push(successStr);
    }

    return parts.join(', ');
  }

  emitWeeklySummaryEvent(weekId: string, aggregator: MetricAggregator): void {
    const { start, end } = getWeekDateRange(weekId);
    const allSessions = this.sessionStore.loadAllSessions({ since: start });
    const weekSessions = allSessions.filter(
      (s) => s.startTime >= start.getTime() && s.startTime <= end.getTime(),
    );

    // Group by developer
    const byDeveloper = new Map<string, FullSessionSummary[]>();
    for (const s of weekSessions) {
      const list = byDeveloper.get(s.developer) ?? [];
      list.push(s);
      byDeveloper.set(s.developer, list);
    }

    for (const [developer, sessions] of byDeveloper) {
      const agg = aggregateWeek(sessions);
      const attrs = { developer, week: weekId };

      if (agg.efficiency !== null) {
        aggregator.record('ai.trend.efficiency_score_weekly', agg.efficiency, attrs);
      }
      aggregator.record('ai.trend.cost_weekly', agg.cost, attrs);
      aggregator.record('ai.trend.task_success_rate_weekly', agg.taskSuccess, attrs);
    }

    logger.debug('Weekly trend metrics emitted', { weekId, developers: byDeveloper.size });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private loadWeekAggregate(weekId: string): WeekAggregates {
    const { start, end } = getWeekDateRange(weekId);
    const allSessions = this.sessionStore.loadAllSessions({ since: start });
    const weekSessions = allSessions.filter(
      (s) => s.startTime >= start.getTime() && s.startTime <= end.getTime(),
    );
    return aggregateWeek(weekSessions);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function getPreviousWeekId(weekId: string): string {
  const { start } = getWeekDateRange(weekId);
  const prevDate = new Date(start.getTime() - 86_400_000); // go back 1 day into previous week
  return getIsoWeekId(prevDate);
}

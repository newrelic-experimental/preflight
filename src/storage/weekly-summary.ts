/**
 * Weekly Summary Generation — aggregates session data into weekly reports.
 *
 * `WeeklySummaryGenerator` loads all sessions from a given ISO week,
 * computes aggregate stats (total cost, tool usage, task completion, etc.),
 * and writes a summary file to `weekly_summaries/{weekId}.json`.
 *
 * ISO week helpers use Monday as the first day of the week.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/index.js';
import type { SessionStore } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

const logger = createLogger('weekly-summary');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeveloperWeeklyStats {
  readonly sessionCount: number;
  readonly totalCostUsd: number;
  readonly avgEfficiencyScore: number | null;
  readonly totalToolCalls: number;
  readonly toolBreakdown: Record<string, number>;
  readonly totalTasksCompleted: number;
  readonly taskSuccessRate: number | null;
  readonly antiPatternCounts: Record<string, number>;
}

export interface WeeklySummary {
  readonly week: string;
  readonly generatedAt: number;
  readonly developers: string[];
  readonly sessionCount: number;
  readonly totalCostUsd: number;
  readonly avgCostPerSession: number;
  readonly avgEfficiencyScore: number | null;
  readonly totalToolCalls: number;
  readonly toolBreakdown: Record<string, number>;
  readonly totalTasksCompleted: number;
  readonly taskSuccessRate: number | null;
  readonly antiPatternCounts: Record<string, number>;
  readonly perDeveloper: Record<string, DeveloperWeeklyStats>;
}

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ISO week identifier for a date (e.g., "2026-W16").
 * ISO weeks start on Monday.
 */
export function getIsoWeekId(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Compute the date range for an ISO week.
 * Returns Monday 00:00:00 UTC to Sunday 23:59:59.999 UTC.
 */
export function getWeekDateRange(weekId: string): { start: Date; end: Date } {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid week ID: ${weekId}`);

  const year = parseInt(match[1]!, 10);
  const week = parseInt(match[2]!, 10);

  // Jan 4 is always in week 1 of the ISO year
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayNum = jan4.getUTCDay() || 7;
  // Monday of week 1
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (dayNum - 1));

  // Monday of target week
  const targetMonday = new Date(week1Monday.getTime());
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  // Exclusive upper bound: Monday 00:00:00.000 of the following week.
  // Use half-open interval [start, end) to avoid the 23:59:59.999 boundary edge case.
  const nextMonday = new Date(targetMonday.getTime());
  nextMonday.setUTCDate(targetMonday.getUTCDate() + 7);

  return { start: targetMonday, end: nextMonday };
}

// ---------------------------------------------------------------------------
// WeeklySummaryGenerator
// ---------------------------------------------------------------------------

export class WeeklySummaryGenerator {
  private readonly summariesDir: string;
  private readonly sessionStore: SessionStore;

  constructor(options: { storagePath: string; sessionStore: SessionStore }) {
    this.summariesDir = join(options.storagePath, 'weekly_summaries');
    this.sessionStore = options.sessionStore;
  }

  generate(weekId: string): WeeklySummary {
    // defense-in-depth — reject non-conforming weekIds before filepath construction
    if (!/^\d{4}-W\d{2}$/.test(weekId)) {
      throw new Error(`Invalid weekId format: "${weekId}". Expected YYYY-Wnn.`);
    }
    const { start, end } = getWeekDateRange(weekId);

    // Widen the filename pre-filter by one day to avoid excluding sessions that started
    // near midnight UTC on the week boundary — the strict startTime filter below is
    // the authoritative range guard.
    const allSessions = this.sessionStore.loadAllSessions({
      since: new Date(start.getTime() - 86_400_000),
    });
    const weekSessions = allSessions.filter(
      (s) => s.startTime >= start.getTime() && s.startTime < end.getTime(),
    );

    const summary = aggregateSessions(weekId, weekSessions);

    if (!existsSync(this.summariesDir)) {
      mkdirSync(this.summariesDir, { recursive: true, mode: 0o700 });
    }

    const filepath = join(this.summariesDir, `${weekId}.json`);
    try {
      writeFileSync(filepath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
      logger.debug('Weekly summary generated', { weekId, sessions: weekSessions.length });
    } catch (err) {
      logger.error('Failed to write weekly summary to disk', { weekId, error: String(err) });
      // Return the in-memory summary even if the write fails so callers still get data
    }

    return summary;
  }

  getLatest(): WeeklySummary | null {
    if (!existsSync(this.summariesDir)) return null;

    // Only include zero-padded filenames (YYYY-Wnn.json); older non-padded
    // files (e.g. 2026-W9.json) sort incorrectly and are excluded.
    const files = readdirSync(this.summariesDir)
      .filter((f) => /^\d{4}-W\d{2}\.json$/.test(f))
      .sort();

    if (files.length === 0) return null;

    const latestFile = files[files.length - 1]!;
    try {
      const raw = readFileSync(join(this.summariesDir, latestFile), 'utf-8');
      return JSON.parse(raw) as WeeklySummary;
    } catch {
      logger.warn('Failed to read latest weekly summary', { file: latestFile });
      return null;
    }
  }

  checkAndGenerateLastWeek(): WeeklySummary | null {
    const lastWeekDate = new Date(Date.now() - 7 * 86_400_000);
    const lastWeekId = getIsoWeekId(lastWeekDate);

    const filepath = join(this.summariesDir, `${lastWeekId}.json`);
    if (existsSync(filepath)) {
      return null;
    }

    return this.generate(lastWeekId);
  }

  loadRecentWeeks(count: number): WeeklySummary[] {
    if (!existsSync(this.summariesDir)) return [];

    const files = readdirSync(this.summariesDir)
      .filter((f) => /^\d{4}-W\d{2}\.json$/.test(f))
      .sort()
      .reverse() // newest first
      .slice(0, count);

    const results: WeeklySummary[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.summariesDir, file), 'utf-8');
        results.push(JSON.parse(raw) as WeeklySummary);
      } catch {
        logger.warn('Skipping unreadable weekly summary', { file });
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateSessions(weekId: string, sessions: FullSessionSummary[]): WeeklySummary {
  const perDeveloper = new Map<string, FullSessionSummary[]>();

  for (const session of sessions) {
    const existing = perDeveloper.get(session.developer) ?? [];
    existing.push(session);
    perDeveloper.set(session.developer, existing);
  }

  let totalCostUsd = 0;
  let totalToolCalls = 0;
  let totalTasksCompleted = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let efficiencySum = 0;
  let efficiencyCount = 0;
  // null-proto accumulators — prevent prototype pollution from disk-sourced keys
  const toolBreakdown = Object.create(null) as Record<string, number>;
  const antiPatternCounts = Object.create(null) as Record<string, number>;

  for (const session of sessions) {
    totalCostUsd += session.estimatedCostUsd ?? 0;
    totalToolCalls += session.toolCallCount;
    totalTasksCompleted += session.taskCount;
    totalTestsRun += session.testRunCount;
    totalTestsPassed += session.testPassCount;

    if (session.efficiencyScore !== null) {
      efficiencySum += session.efficiencyScore;
      efficiencyCount++;
    }

    for (const [tool, count] of Object.entries(session.toolBreakdown)) {
      toolBreakdown[tool] = (toolBreakdown[tool] ?? 0) + count;
    }

    for (const ap of session.antiPatterns) {
      antiPatternCounts[ap.type] = (antiPatternCounts[ap.type] ?? 0) + ap.count;
    }
  }

  const devStats: Record<string, DeveloperWeeklyStats> = {};
  for (const [developer, devSessions] of perDeveloper) {
    devStats[developer] = aggregateDeveloperSessions(devSessions);
  }

  return {
    week: weekId,
    generatedAt: Date.now(),
    developers: [...perDeveloper.keys()].sort(),
    sessionCount: sessions.length,
    totalCostUsd: round(totalCostUsd, 4),
    avgCostPerSession: sessions.length > 0 ? round(totalCostUsd / sessions.length, 4) : 0,
    avgEfficiencyScore: efficiencyCount > 0 ? round(efficiencySum / efficiencyCount, 3) : null,
    totalToolCalls,
    toolBreakdown,
    totalTasksCompleted,
    taskSuccessRate:
      totalTestsRun > 0 ? round(Math.min(1, totalTestsPassed / totalTestsRun), 3) : null,
    antiPatternCounts,
    perDeveloper: devStats,
  };
}

function aggregateDeveloperSessions(sessions: FullSessionSummary[]): DeveloperWeeklyStats {
  let totalCostUsd = 0;
  let totalToolCalls = 0;
  let totalTasksCompleted = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let efficiencySum = 0;
  let efficiencyCount = 0;
  // null-proto accumulators — prevent prototype pollution from disk-sourced keys
  const toolBreakdown = Object.create(null) as Record<string, number>;
  const antiPatternCounts = Object.create(null) as Record<string, number>;

  for (const session of sessions) {
    totalCostUsd += session.estimatedCostUsd ?? 0;
    totalToolCalls += session.toolCallCount;
    totalTasksCompleted += session.taskCount;
    totalTestsRun += session.testRunCount;
    totalTestsPassed += session.testPassCount;

    if (session.efficiencyScore !== null) {
      efficiencySum += session.efficiencyScore;
      efficiencyCount++;
    }

    for (const [tool, count] of Object.entries(session.toolBreakdown)) {
      toolBreakdown[tool] = (toolBreakdown[tool] ?? 0) + count;
    }

    for (const ap of session.antiPatterns) {
      antiPatternCounts[ap.type] = (antiPatternCounts[ap.type] ?? 0) + ap.count;
    }
  }

  return {
    sessionCount: sessions.length,
    totalCostUsd: round(totalCostUsd, 4),
    avgEfficiencyScore: efficiencyCount > 0 ? round(efficiencySum / efficiencyCount, 3) : null,
    totalToolCalls,
    toolBreakdown,
    totalTasksCompleted,
    taskSuccessRate:
      totalTestsRun > 0 ? round(Math.min(1, totalTestsPassed / totalTestsRun), 3) : null,
    antiPatternCounts,
  };
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

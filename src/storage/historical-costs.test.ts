import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localDateKey } from '../lib/date.js';
import { BudgetTracker } from '../metrics/budget-tracker.js';
import type { BudgetThresholdEvent } from '../metrics/budget-tracker.js';
import { computeHistoricalCosts } from './historical-costs.js';
import { todayCostOfSummary } from '../metrics/cost-tracker-seed.js';
import { SessionStore } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

// Local-time constructors keep the fixtures correct in any host timezone,
// because the today/yesterday boundary is the host's local midnight.
const local = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
const REF_TS = local(15, 12);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// loadAllSessions() keeps a session when the UTC date in its filename is on or
// after the UTC date seven days before refTs, so the window starts at UTC
// midnight of that date rather than at refTs - 7 days.
const WINDOW_START = Date.parse(new Date(REF_TS - 7 * DAY).toISOString().slice(0, 10));

let tmpDir: string;
let store: SessionStore;
let stderrSpy: ReturnType<typeof jest.spyOn>;

function save(sessionId: string, startTime: number, endTime: number, costUsd: number | null): void {
  store.saveSession({
    sessionId,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    estimatedCostUsd: costUsd,
    toolCallCount: 1,
  } as unknown as FullSessionSummary);
}

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(
    tmpdir(),
    `nr-historical-costs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
  store = new SessionStore({ storagePath: tmpDir });
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeHistoricalCosts', () => {
  it('counts a session from yesterday toward the week only', () => {
    save('yesterday', local(14, 10), local(14, 11), 1);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 1,
    });
  });

  it('counts a session from earlier today toward the day and the week', () => {
    save('today', local(15, 8), local(15, 9), 2);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it('pro-rates a session that spans midnight into the day, and counts all of it for the week', () => {
    save('overnight', local(14, 23), local(15, 1), 4);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 4,
    });
  });

  it('counts a session from the first day of the window toward the week', () => {
    save('first-day', WINDOW_START, WINDOW_START + HOUR, 3);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 3,
    });
  });

  it('ignores a session from the day before the window', () => {
    save('day-before', WINDOW_START - HOUR, WINDOW_START, 8);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });

  it('excludes the current session so the caller does not double-count it', () => {
    save('current', local(15, 8), local(15, 9), 16);
    save('today', local(15, 10), local(15, 11), 2);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it('leaves nothing out when there is no current session', () => {
    save('today', local(15, 10), local(15, 11), 2);

    expect(computeHistoricalCosts(store, null, REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it("counts a substitute summary in place of a session's current file", () => {
    save('guess', local(15, 8), local(15, 9), 16);
    const before = { ...store.loadSession('guess')!, estimatedCostUsd: 4 };

    const substitute = (summary: FullSessionSummary | null) =>
      computeHistoricalCosts(store, null, REF_TS, { sessionId: 'guess', summary });

    expect(substitute(before)).toEqual({ priorDailyCostUsd: 4, priorWeeklyCostUsd: 4 });
    expect(substitute(null)).toEqual({ priorDailyCostUsd: 0, priorWeeklyCostUsd: 0 });
  });

  it('skips sessions with no cost estimate', () => {
    save('unpriced', local(15, 8), local(15, 9), null);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });

  it('sums every kind of session together', () => {
    save('yesterday', local(14, 10), local(14, 11), 1);
    save('today', local(15, 8), local(15, 9), 2);
    save('overnight', local(14, 23), local(15, 1), 4);
    save('old', WINDOW_START - HOUR, WINDOW_START, 8);
    save('current', local(15, 10), local(15, 11), 16);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 4,
      priorWeeklyCostUsd: 7,
    });
  });

  describe('sessions with a per-day cost map', () => {
    interface Placed {
      readonly startTime: number;
      readonly endTime: number;
      readonly estimatedCostUsd: number;
      readonly costByDayUsd?: Record<string, number>;
      readonly timeline?: ReadonlyArray<{ timestamp: number; toolName: string }>;
      readonly toolCallCount?: number;
      readonly modifiedAt?: number;
    }

    const place = (sessionId: string, fields: Placed): void => {
      const { modifiedAt = REF_TS - HOUR, ...record } = fields;
      const date = new Date(record.startTime).toISOString().slice(0, 10);
      const path = resolve(tmpDir, 'sessions', `${date}_${sessionId}.json`);
      writeFileSync(path, JSON.stringify({ sessionId, toolCallCount: 1, ...record }));
      utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
    };
    const baselines = () => computeHistoricalCosts(store, 'current', REF_TS);
    const day = (n: number): string => localDateKey(local(n, 12));
    const FIRST_DAY = day(8);

    it('counts 0 for a day-map-less session with no attributable activity, as Spend Today does', () => {
      const idle = {
        startTime: local(14, 22),
        endTime: local(15, 2),
        estimatedCostUsd: 8,
        toolCallCount: 0,
      };
      place('idle', idle);

      expect(todayCostOfSummary(idle, localDateKey(REF_TS), REF_TS).costUsd).toBe(0);
      expect(baselines().priorDailyCostUsd).toBe(0);
      expect(baselines().priorWeeklyCostUsd).toBe(8);
    });

    it('counts only the days of the window for a session resumed from before it', () => {
      place('resumed', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: REF_TS - HOUR,
        estimatedCostUsd: 100,
        costByDayUsd: {
          [localDateKey(WINDOW_START - 3 * DAY)]: 60,
          [localDateKey(local(7, 12))]: 21,
          [FIRST_DAY]: 4,
          [day(12)]: 10,
          [day(15)]: 6,
        },
      });

      expect(baselines()).toEqual({ priorDailyCostUsd: 6, priorWeeklyCostUsd: 20 });
    });

    it('counts a day of the window from its first day and not the day before', () => {
      place('edge', {
        startTime: WINDOW_START - 2 * DAY,
        endTime: REF_TS - HOUR,
        estimatedCostUsd: 9,
        costByDayUsd: { [localDateKey(local(7, 12))]: 5, [FIRST_DAY]: 1 },
      });

      expect(baselines().priorWeeklyCostUsd).toBe(1);
    });

    it('ignores a session from before the window that was not modified inside it', () => {
      place('stale', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: WINDOW_START - 3 * DAY + HOUR,
        estimatedCostUsd: 50,
        costByDayUsd: { [day(14)]: 50 },
        modifiedAt: WINDOW_START - 2 * DAY,
      });

      expect(baselines()).toEqual({ priorDailyCostUsd: 0, priorWeeklyCostUsd: 0 });
    });

    it('takes the day from the day map instead of pro-rating a session that spans midnight', () => {
      place('overnight', {
        startTime: local(14, 23),
        endTime: local(15, 1),
        estimatedCostUsd: 10,
        costByDayUsd: { [day(14)]: 9, [day(15)]: 1 },
        timeline: [
          { timestamp: local(14, 23), toolName: 'Read' },
          { timestamp: local(15, 0), toolName: 'Read' },
        ],
      });

      expect(baselines()).toEqual({ priorDailyCostUsd: 1, priorWeeklyCostUsd: 10 });
    });

    it('counts nothing for the day when the day map has no entry for it', () => {
      place('yesterday-only', {
        startTime: local(14, 10),
        endTime: local(15, 1),
        estimatedCostUsd: 3,
        costByDayUsd: { [day(14)]: 3 },
      });

      expect(baselines()).toEqual({ priorDailyCostUsd: 0, priorWeeklyCostUsd: 3 });
    });

    it('counts a session from before the window with no day map as nothing, even with activity today', () => {
      place('legacy', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: local(15, 9),
        estimatedCostUsd: 70,
        timeline: [
          { timestamp: local(15, 8), toolName: 'Read' },
          { timestamp: local(15, 9), toolName: 'Edit' },
        ],
      });

      expect(baselines()).toEqual({ priorDailyCostUsd: 0, priorWeeklyCostUsd: 0 });
    });

    it('keeps the window and the day on calendar days when the hour after midnight follows a clock change', () => {
      const ref = new Date(2026, 2, 30, 0, 30).getTime();
      const key = (offsetDays: number): string => {
        const date = new Date(2026, 2, 30 - offsetDays, 12);
        return localDateKey(date.getTime());
      };
      place('resumed-over-dst', {
        startTime: Date.UTC(2026, 2, 1),
        endTime: ref - HOUR,
        estimatedCostUsd: 100,
        modifiedAt: ref - HOUR,
        costByDayUsd: { [key(8)]: 40, [key(7)]: 5, [key(1)]: 2, [key(0)]: 3 },
      });

      expect(computeHistoricalCosts(store, 'current', ref)).toEqual({
        priorDailyCostUsd: 3,
        priorWeeklyCostUsd: 10,
      });
    });

    it('fires the weekly budget alert for spend a resumed session made inside the window', () => {
      place('resumed', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: REF_TS - HOUR,
        estimatedCostUsd: 500,
        costByDayUsd: { [localDateKey(WINDOW_START - 3 * DAY)]: 450, [day(12)]: 60 },
      });
      const events: BudgetThresholdEvent[] = [];
      const budget = new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: null,
        weeklyBudgetUsd: 100,
        onThreshold: (event) => events.push(event),
      });

      const { priorDailyCostUsd, priorWeeklyCostUsd } = baselines();
      budget.updateCost(0, priorDailyCostUsd, priorWeeklyCostUsd);

      expect(events.map((e) => [e.period, e.thresholdPct, e.spentUsd])).toEqual([
        ['weekly', 50, 60],
      ]);
    });

    it('never counts more for the day than for the week', () => {
      place('legacy', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: local(15, 9),
        estimatedCostUsd: 70,
        timeline: [{ timestamp: local(15, 8), toolName: 'Read' }],
      });
      place('mapped', {
        startTime: WINDOW_START - 3 * DAY,
        endTime: local(15, 9),
        estimatedCostUsd: 8,
        costByDayUsd: { [day(15)]: 2 },
      });

      const { priorDailyCostUsd, priorWeeklyCostUsd } = baselines();
      expect(priorDailyCostUsd).toBe(2);
      expect(priorWeeklyCostUsd).toBe(2);
    });
  });

  it('falls back to zero when the session store cannot be read', () => {
    const broken = {
      loadAllSessions: () => {
        throw new Error('unreadable');
      },
    };

    expect(computeHistoricalCosts(broken, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });
});

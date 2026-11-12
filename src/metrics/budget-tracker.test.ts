import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { BudgetTracker } from './budget-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('BudgetTracker', () => {
  it('returns null status when no budgets configured', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: null,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    const s = t.getStatus();
    expect(s.session.budgetUsd).toBeNull();
    expect(s.session.pctUsed).toBeNull();
    expect(s.session.exceeded).toBe(false);
  });

  it('tracks pctUsed correctly', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(5, 0, 0);
    expect(t.getStatus().session.pctUsed).toBeCloseTo(50);
  });

  it('fires 50% threshold callback once', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(5, 0, 0);
    t.updateCost(5.1, 0, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
  });

  it('fires 80% and 100% thresholds independently', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(6, 0, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
    t.updateCost(8, 0, 0);
    expect(events).toHaveLength(2);
    expect((events[1] as { thresholdPct: number }).thresholdPct).toBe(80);
    t.updateCost(10, 0, 0);
    expect(events).toHaveLength(3);
    expect((events[2] as { thresholdPct: number }).thresholdPct).toBe(100);
  });

  it('marks exceeded when spent > budget', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 5,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(6, 0, 0);
    expect(t.getStatus().session.exceeded).toBe(true);
    expect(t.getStatus().session.remainingUsd).toBe(0);
  });

  it('resetSession clears session spend and re-arms thresholds', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(6, 0, 0);
    t.resetSession();
    t.updateCost(6, 0, 0);
    expect(events).toHaveLength(2);
  });

  it('tracks daily and weekly budgets independently', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 100,
      dailyBudgetUsd: 10,
      weeklyBudgetUsd: 50,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(5, 15, 60);
    const periods = (events as Array<{ period: string }>).map((e) => e.period);
    expect(periods).toContain('daily');
    expect(periods).toContain('weekly');
    expect(periods.filter((p) => p === 'daily')).toHaveLength(3);
    expect(periods.filter((p) => p === 'weekly')).toHaveLength(3);
  });

  it('calculates remaining budget correctly', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 20,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(7, 0, 0);
    const status = t.getStatus().session;
    expect(status.remainingUsd).toBeCloseTo(13);
    expect(status.pctUsed).toBeCloseTo(35);
  });

  it('re-arms daily thresholds after midnight', () => {
    jest.useFakeTimers();
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: null,
      dailyBudgetUsd: 10,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });

    const initialDate = new Date('2026-05-27T10:00:00Z');
    jest.setSystemTime(initialDate);

    // Fire 50% threshold on day 1
    t.updateCost(0, 5, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { period: string; thresholdPct: number }).period).toBe('daily');
    expect((events[0] as { period: string; thresholdPct: number }).thresholdPct).toBe(50);

    // Advance to next day without firing again
    jest.setSystemTime(new Date('2026-05-27T20:00:00Z'));
    t.updateCost(0, 6, 0);
    expect(events).toHaveLength(1);

    // Advance past midnight to next day
    jest.setSystemTime(new Date('2026-05-28T10:00:00Z'));
    // Reset daily spent to simulate new day, keep session spending
    t.updateCost(0, 5, 0);
    expect(events).toHaveLength(2);
    expect((events[1] as { period: string }).period).toBe('daily');

    jest.useRealTimers();
  });

  it('re-arms weekly thresholds after week rollover', () => {
    jest.useFakeTimers();
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: null,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: 50,
      onThreshold: (e) => events.push(e),
    });

    const initialDate = new Date('2026-05-27T10:00:00Z');
    jest.setSystemTime(initialDate);

    // Fire 50% threshold on week 1
    t.updateCost(0, 0, 25);
    expect(events).toHaveLength(1);
    expect((events[0] as { period: string }).period).toBe('weekly');

    // Advance within same week
    jest.setSystemTime(new Date('2026-05-29T10:00:00Z'));
    t.updateCost(0, 0, 30);
    expect(events).toHaveLength(1);

    // Advance to next week (Mon = week start)
    jest.setSystemTime(new Date('2026-06-02T10:00:00Z'));
    t.updateCost(0, 0, 25);
    expect(events).toHaveLength(2);
    expect((events[1] as { period: string }).period).toBe('weekly');

    jest.useRealTimers();
  });

  it('seedFiredThresholdsFromSessionTotal marks thresholds already implied by a restored total as fired, without emitting alerts', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });

    // Simulate CostTracker.seedFromPersisted() having just restored an 85%-spent total.
    t.seedFiredThresholdsFromSessionTotal(8.5);
    expect(events).toHaveLength(0); // no alert emitted for pre-existing spend

    // A tiny bit of NEW spend should not re-fire the 50%/80% thresholds already seeded.
    t.updateCost(8.6, 0, 0);
    expect(events).toHaveLength(0);

    // Crossing 100% for the first time (session-scoped) should still fire.
    t.updateCost(10.1, 0, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(100);
  });

  it('seedFiredThresholdsFromSessionTotal is a no-op when there is no session budget configured', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: null,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    expect(() => t.seedFiredThresholdsFromSessionTotal(1000)).not.toThrow();
    expect(t.getStatus().session.pctUsed).toBeNull();
  });

  it('seedFiredThresholdsFromSessionTotal below every threshold marks nothing as fired', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.seedFiredThresholdsFromSessionTotal(1); // 10% — below the 50% floor
    t.updateCost(5.1, 0, 0); // now crosses 50% for the first time
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
  });

  describe('seedPeriodSpend', () => {
    const makeRestarted = (events: unknown[]) =>
      new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: 10,
        weeklyBudgetUsd: 50,
        onThreshold: (e) => events.push(e),
      });

    it('reports the recorded daily and weekly spend before any cost event', () => {
      const t = makeRestarted([]);
      t.seedPeriodSpend(6, 30);
      const status = t.getStatus();
      expect(status.daily.spentUsd).toBe(6);
      expect(status.daily.pctUsed).toBe(60);
      expect(status.weekly.spentUsd).toBe(30);
      expect(status.weekly.remainingUsd).toBe(20);
      expect(status.session.spentUsd).toBe(0);
    });

    it('does not alert on spend recorded before the restart', () => {
      const events: unknown[] = [];
      const t = makeRestarted(events);
      t.seedPeriodSpend(8.5, 45);
      expect(events).toHaveLength(0);
      expect(t.getStatus().alerts).toHaveLength(0);
    });

    it('treats spend exactly at a threshold as crossed', () => {
      const fired: string[] = [];
      const tracker = new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: 10,
        weeklyBudgetUsd: 50,
        onThreshold: (e) => fired.push(`${e.period}_${e.thresholdPct}`),
      });
      tracker.seedPeriodSpend(5, 25);
      tracker.updateCost(0, 5, 25);
      expect(fired).toEqual([]);
    });

    it('fires no threshold twice across a restart, and still fires a newly crossed one', () => {
      const firedBefore: Array<{ period: string; thresholdPct: number }> = [];
      const before = new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: 10,
        weeklyBudgetUsd: 50,
        onThreshold: (e) => firedBefore.push(e),
      });
      before.updateCost(0, 8.5, 45);
      expect(firedBefore.map((e) => `${e.period}_${e.thresholdPct}`)).toEqual([
        'daily_50',
        'daily_80',
        'weekly_50',
        'weekly_80',
      ]);

      const firedAfter: Array<{ period: string; thresholdPct: number }> = [];
      const after = new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: 10,
        weeklyBudgetUsd: 50,
        onThreshold: (e) => firedAfter.push(e),
      });
      after.seedPeriodSpend(8.5, 45);
      after.updateCost(0, 8.6, 45.5);
      expect(firedAfter).toHaveLength(0);

      after.updateCost(0, 10.2, 45.5);
      expect(firedAfter.map((e) => `${e.period}_${e.thresholdPct}`)).toEqual(['daily_100']);
    });

    it('is a no-op for a period with no budget', () => {
      const t = new BudgetTracker({
        sessionBudgetUsd: null,
        dailyBudgetUsd: null,
        weeklyBudgetUsd: null,
      });
      expect(() => t.seedPeriodSpend(1000, 5000)).not.toThrow();
      expect(t.getStatus().daily.pctUsed).toBeNull();
    });
  });
});

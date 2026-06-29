import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LocalAlertEngine, type AlertSnapshot } from './local-alert-engine.js';
import type { LocalAlertRule } from './local-alert-rule.js';
import type { AlertEvent } from '../dashboard/live-event-bus.js';
import type { OsNotifier } from './os-notifier.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    timestamp: 1700000000000,
    cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 },
    efficiency: { score: null },
    antiPatterns: [],
    latency: [],
    toolFailures: [],
    ...overrides,
  };
}

function makeBudgetRule(overrides: Partial<LocalAlertRule> = {}): LocalAlertRule {
  return {
    id: 'session-budget',
    name: 'Session budget',
    type: 'budget.session',
    severity: 'warning',
    enabled: true,
    threshold: 80,
    operator: 'above',
    deduplicateSeconds: 300,
    channels: ['banner'],
    ...overrides,
  } as LocalAlertRule;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalAlertEngine — empty rule set', () => {
  it('returns [] when no rules are loaded', () => {
    const engine = new LocalAlertEngine();
    expect(engine.evaluate(makeSnapshot(), 1700000000000)).toEqual([]);
  });

  it('does not invoke onAlert when there are no rules', () => {
    const engine = new LocalAlertEngine();
    const seen: AlertEvent[] = [];
    engine.setOnAlert((e) => seen.push(e));
    engine.evaluate(makeSnapshot(), 1700000000000);
    expect(seen).toEqual([]);
  });
});

describe('LocalAlertEngine — budget rules', () => {
  it('emits a firing event when a matching budget threshold arrives', () => {
    const engine = new LocalAlertEngine();
    const rule = makeBudgetRule({ threshold: 80 });
    engine.loadRules([rule]);
    const seen: AlertEvent[] = [];
    engine.setOnAlert((e) => seen.push(e));

    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');
    expect(events[0]!.id).toBe('session-budget');
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.value).toBe(80);
    expect(events[0]!.threshold).toBe(80);
    expect(seen).toEqual(events);
  });

  it('does not emit when budgetThresholds is empty', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule()]);
    expect(engine.evaluate(makeSnapshot(), 1700000000000)).toEqual([]);
  });

  it('does not emit when the period does not match', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ id: 'daily', type: 'budget.daily' })]);
    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    expect(events).toEqual([]);
  });

  it('does not emit when thresholdPct is below the rule threshold', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 100 })]);
    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    expect(events).toEqual([]);
  });

  it('does not re-fire for the same threshold within the same period', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ deduplicateSeconds: 1 })]);
    const snap = makeSnapshot({
      budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
    });
    const t = 1700000000000;
    expect(engine.evaluate(snap, t)).toHaveLength(1);
    expect(engine.evaluate(snap, t + 1000)).toHaveLength(0);
    expect(engine.evaluate(snap, t + 5000)).toHaveLength(0);
  });

  it('fires a higher threshold even after a lower one in the same period', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([
      makeBudgetRule({ id: 'session-80', threshold: 80 }),
      makeBudgetRule({ id: 'session-100', threshold: 100, severity: 'critical' }),
    ]);
    const t = 1700000000000;
    // 80% threshold arrives first
    let events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t,
    );
    expect(events.map((e) => e.id)).toEqual(['session-80']);
    // 100% threshold arrives later — the 100% rule should fire even though
    // the 80% rule has already been firing. (BudgetTracker dedupes per
    // (period, level), but the 100% rule is its own rule.)
    events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 100, spentUsd: 5.2, budgetUsd: 5 }],
      }),
      t + 1000,
    );
    expect(events.map((e) => e.id)).toEqual(['session-100']);
    expect(events[0]!.severity).toBe('critical');
  });

  it('runs multiple rules independently', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([
      makeBudgetRule({ id: 'rule-a', threshold: 50 }),
      makeBudgetRule({ id: 'rule-b', threshold: 80 }),
    ]);
    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    // Both rules satisfied (80 >= 50 and 80 >= 80) → both fire.
    expect(events.map((e) => e.id).sort()).toEqual(['rule-a', 'rule-b']);
  });

  it('skips disabled rules', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ enabled: false })]);
    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    expect(events).toEqual([]);
  });

  it('captures onAlert callback errors and keeps evaluating other rules', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([
      makeBudgetRule({ id: 'rule-a', threshold: 50 }),
      makeBudgetRule({ id: 'rule-b', threshold: 80 }),
    ]);
    let calls = 0;
    engine.setOnAlert(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    const events = engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('emits cleared when session cost drops below firing spentUsd (session reset)', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 80 })]);
    const seen: AlertEvent[] = [];
    engine.setOnAlert((e) => seen.push(e));

    const t0 = 1700000000000;
    // Fire at 80% with $4 spent.
    let events = engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');

    // New Claude Code session starts: CostTracker resets, sessionUsd drops to 0,
    // BudgetTracker stops emitting any threshold breach.
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('cleared');
    expect(events[0]!.id).toBe('session-budget');
    expect(engine.getFiringRuleIds()).toEqual([]);
  });

  it('does not re-fire after clearing when no threshold matches', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 80 })]);

    const t0 = 1700000000000;
    engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );
    // Session resets → cleared.
    engine.evaluate(makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }), t0 + 1000);
    // Subsequent tick with no threshold breach should produce no events.
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }),
      t0 + 2000,
    );
    expect(events).toEqual([]);
  });

  // loadRules() preserves state for rules
  // whose id is unchanged. A hot-reload between fire and clear must not
  // wipe `firedSpentUsd`, otherwise the next snapshot with sessionUsd=0
  // would silently keep the rule firing.
  it('preserves firedSpentUsd across hot-reload so the clear path still fires', () => {
    const engine = new LocalAlertEngine();
    const rule = makeBudgetRule({ threshold: 80 });
    engine.loadRules([rule]);

    const t0 = 1700000000000;
    let events = engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');

    // Hot-reload: rules.json changed (e.g. user edited the threshold)
    // but the rule id is unchanged, so engine state is preserved.
    const reloaded = makeBudgetRule({ threshold: 80, name: 'Renamed' });
    engine.loadRules([reloaded]);
    expect(engine.getFiringRuleIds()).toEqual(['session-budget']);

    // Session resets — sessionUsd drops to 0, below the preserved
    // firedSpentUsd of 4 → rule clears.
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('cleared');
    expect(engine.getFiringRuleIds()).toEqual([]);
  });

  it('does not spuriously clear when same-session cost equals firedSpentUsd (no false positive)', () => {
    // sessionUsd can only increase within a session. If cost stays exactly at
    // firedSpentUsd (no new spend since the fire), the rule must NOT clear.
    // The sessionReset check uses strict < so same-session equality doesn't trigger.
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 80 })]);

    const t0 = 1700000000000;
    // Fire at $4 (firedSpentUsd = 4)
    engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );

    // Next tick: same session, still $4, BudgetTracker deduped and didn't re-emit
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events).toEqual([]);
    expect(engine.getFiringRuleIds()).toEqual(['session-budget']);
  });

  it('re-fires in the new session after a clear', () => {
    // After a session-reset clear, the engine is back to 'idle'. A new threshold
    // crossing must fire a new event and set up fresh period tracking so subsequent
    // duplicate crossings within the same new period are deduped correctly.
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 80, deduplicateSeconds: 300 })]);

    const t0 = 1700000000000;
    engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );

    // Session resets → clears
    engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }),
      t0 + 10_000,
    );

    // New session crosses threshold — re-fire expected
    const refireEvents = engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0 + 30_000,
    );
    expect(refireEvents).toHaveLength(1);
    expect(refireEvents[0]!.state).toBe('firing');

    // Immediate duplicate crossing in the same new period must be deduped
    const dupeEvents = engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0 + 30_001,
    );
    expect(dupeEvents).toHaveLength(0);
  });

  it('does not clear session rule while session cost stays above firing spentUsd', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ threshold: 80 })]);

    const t0 = 1700000000000;
    engine.evaluate(
      makeSnapshot({
        cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 },
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t0,
    );
    // BudgetTracker dedupes within a period — no thresholds emitted on next tick,
    // but cost is unchanged. Rule must stay firing (no flapping).
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events).toEqual([]);
    expect(engine.getFiringRuleIds()).toEqual(['session-budget']);
  });
});

describe('LocalAlertEngine — clock + state housekeeping', () => {
  it('uses the injected clock for now()', () => {
    const engine = new LocalAlertEngine({ clock: () => 42 });
    expect(engine.now()).toBe(42);
  });

  it('drops state for rules that disappear on reload', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeBudgetRule({ id: 'rule-a' })]);
    engine.evaluate(
      makeSnapshot({
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      1700000000000,
    );
    expect(engine.getFiringRuleIds()).toEqual(['rule-a']);
    engine.loadRules([makeBudgetRule({ id: 'rule-b' })]);
    expect(engine.getFiringRuleIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — non-budget rule types
// ---------------------------------------------------------------------------

describe('LocalAlertEngine — cost.window rule', () => {
  it('fires when sessionUsd exceeds threshold and clears when it drops', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'session-cost',
      name: 'Session cost > $5',
      type: 'cost.window',
      severity: 'warning',
      enabled: true,
      threshold: 5,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 3600,
      costPeriod: 'session',
      channels: ['banner'],
    };
    engine.loadRules([rule]);

    const t0 = 1700000000000;
    let events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 } }),
      t0,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');
    expect(events[0]!.value).toBe(6);

    // Same condition next cycle — no new event.
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 7, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events).toEqual([]);

    // Cost drops below threshold — clear.
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 4, todayUsd: 0, weekUsd: 0 } }),
      t0 + 2000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('cleared');
  });

  it('reads todayUsd when costPeriod is "today"', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'today-cost',
      name: 'Today cost > $20',
      type: 'cost.window',
      severity: 'critical',
      enabled: true,
      threshold: 20,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 3600,
      costPeriod: 'today',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 5, todayUsd: 25, weekUsd: 25 } }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(25);
  });
});

describe('LocalAlertEngine — efficiency.below rule', () => {
  function makeEffRule(overrides: Partial<LocalAlertRule> = {}): LocalAlertRule {
    return {
      id: 'low-efficiency',
      name: 'Efficiency below 0.4',
      type: 'efficiency.below',
      severity: 'warning',
      enabled: true,
      threshold: 0.4,
      operator: 'below',
      deduplicateSeconds: 0,
      windowSeconds: 30 * 60,
      channels: ['banner'],
      ...overrides,
    } as LocalAlertRule;
  }

  it('does not fire if condition has not been sustained for windowSeconds', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeEffRule()]);
    const t0 = 1700000000000;
    expect(engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0)).toEqual([]);
    expect(
      engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0 + 5 * 60 * 1000),
    ).toEqual([]);
  });

  it('fires once condition has been sustained past windowSeconds', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeEffRule()]);
    const t0 = 1700000000000;
    engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0);
    const events = engine.evaluate(
      makeSnapshot({ efficiency: { score: 0.2 } }),
      t0 + 30 * 60 * 1000 + 1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');
  });

  it('resets the sustained-below window when condition becomes false', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeEffRule()]);
    const t0 = 1700000000000;
    engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0);
    // Score recovers — resets firstBelowAt
    engine.evaluate(makeSnapshot({ efficiency: { score: 0.5 } }), t0 + 10 * 60 * 1000);
    // Score drops again — sustained window starts fresh, won't fire yet.
    expect(
      engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0 + 20 * 60 * 1000),
    ).toEqual([]);
    expect(
      engine.evaluate(makeSnapshot({ efficiency: { score: 0.2 } }), t0 + 30 * 60 * 1000),
    ).toEqual([]);
  });

  it('skips evaluation entirely when efficiency score is null', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeEffRule()]);
    expect(engine.evaluate(makeSnapshot({ efficiency: { score: null } }), 1700000000000)).toEqual(
      [],
    );
  });
});

describe('LocalAlertEngine — antipattern.count rule', () => {
  it('fires when stuck-loop count exceeds threshold for matching window', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'stuck-loops',
      name: 'Too many stuck loops',
      type: 'antipattern.count',
      severity: 'warning',
      enabled: true,
      threshold: 3,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      patternType: 'stuck_loop',
      channels: ['banner'],
    };
    engine.loadRules([rule]);

    const events = engine.evaluate(
      makeSnapshot({
        antiPatterns: [{ type: 'stuck_loop', count: 4, windowMs: 300_000 }],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('firing');
    expect(events[0]!.value).toBe(4);
  });

  it('does not fire when matching entry uses a different windowMs', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'stuck-loops',
      name: 'Too many stuck loops',
      type: 'antipattern.count',
      severity: 'warning',
      enabled: true,
      threshold: 3,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      patternType: 'stuck_loop',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    expect(
      engine.evaluate(
        makeSnapshot({
          antiPatterns: [{ type: 'stuck_loop', count: 4, windowMs: 60_000 }],
        }),
        1700000000000,
      ),
    ).toEqual([]);
  });

  it('uses "*" key when no patternType is configured', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'any-pattern',
      name: 'Any anti-pattern',
      type: 'antipattern.count',
      severity: 'warning',
      enabled: true,
      threshold: 5,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 600,
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({
        antiPatterns: [{ type: '*', count: 6, windowMs: 600_000 }],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
  });
});

describe('LocalAlertEngine — latency.percentile rule', () => {
  it('fires when p95 for a specific tool exceeds threshold', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'bash-latency',
      name: 'Bash latency too high',
      type: 'latency.percentile',
      severity: 'warning',
      enabled: true,
      threshold: 1000,
      operator: 'above',
      deduplicateSeconds: 0,
      percentile: 95,
      tool: 'Bash',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({
        latency: [
          { tool: 'Bash', p50Ms: 200, p95Ms: 1500, p99Ms: 2000 },
          { tool: 'Read', p50Ms: 20, p95Ms: 50, p99Ms: 75 },
        ],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(1500);
  });

  it('uses max p95 across all tools when no tool filter is set', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'any-latency',
      name: 'Any tool slow',
      type: 'latency.percentile',
      severity: 'warning',
      enabled: true,
      threshold: 100,
      operator: 'above',
      deduplicateSeconds: 0,
      percentile: 95,
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({
        latency: [
          { tool: 'Bash', p50Ms: 20, p95Ms: 50, p99Ms: 75 },
          { tool: 'Read', p50Ms: 100, p95Ms: 250, p99Ms: 300 },
        ],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(250);
  });

  it('honors rule.percentile (50/95/99) when picking the value', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'p99-bash',
      name: 'Bash p99 latency',
      type: 'latency.percentile',
      severity: 'warning',
      enabled: true,
      threshold: 1000,
      operator: 'above',
      deduplicateSeconds: 0,
      percentile: 99,
      tool: 'Bash',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({
        latency: [{ tool: 'Bash', p50Ms: 100, p95Ms: 800, p99Ms: 1500 }],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(1500);
  });
});

describe('LocalAlertEngine — tool.failure rule', () => {
  it('fires when failure rate exceeds threshold for matching window', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'bash-failures',
      name: 'Bash failure spike',
      type: 'tool.failure',
      severity: 'warning',
      enabled: true,
      threshold: 20,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      tool: 'Bash',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    const events = engine.evaluate(
      makeSnapshot({
        toolFailures: [{ tool: 'Bash', failurePct: 33, windowMs: 300_000 }],
      }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(33);
  });

  it('does not fire when no matching toolFailures entry exists', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'bash-failures',
      name: 'Bash failure spike',
      type: 'tool.failure',
      severity: 'warning',
      enabled: true,
      threshold: 20,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      tool: 'Bash',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    expect(
      engine.evaluate(
        makeSnapshot({
          toolFailures: [{ tool: 'Read', failurePct: 90, windowMs: 300_000 }],
        }),
        1700000000000,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('LocalAlertEngine — deduplication', () => {
  function makeRule(): LocalAlertRule {
    return {
      id: 'session-cost',
      name: 'Session cost > $5',
      type: 'cost.window',
      severity: 'warning',
      enabled: true,
      threshold: 5,
      operator: 'above',
      deduplicateSeconds: 60,
      windowSeconds: 3600,
      costPeriod: 'session',
      channels: ['banner'],
    } as LocalAlertRule;
  }

  it('suppresses re-fire within dedupe window after a clear', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeRule()]);
    const t0 = 1700000000000;

    // Fire
    let events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      t0,
    );
    expect(events.map((e) => e.state)).toEqual(['firing']);

    // Clear at t0 + 1s
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 1, todayUsd: 0, weekUsd: 0 } }),
      t0 + 1000,
    );
    expect(events.map((e) => e.state)).toEqual(['cleared']);

    // Condition triggers again 30 s later — within 60 s dedupe window — suppressed.
    events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      t0 + 31 * 1000,
    );
    expect(events).toEqual([]);
  });

  it('allows re-fire after the dedupe window has elapsed', () => {
    const engine = new LocalAlertEngine();
    engine.loadRules([makeRule()]);
    const t0 = 1700000000000;
    engine.evaluate(makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }), t0);
    engine.evaluate(makeSnapshot({ cost: { sessionUsd: 1, todayUsd: 0, weekUsd: 0 } }), t0 + 1000);
    // 70 s after clear — past dedupe — should fire again.
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      t0 + 71 * 1000,
    );
    expect(events.map((e) => e.state)).toEqual(['firing']);
  });
});

// ---------------------------------------------------------------------------
// getRequiredWindows
// ---------------------------------------------------------------------------

describe('LocalAlertEngine — getRequiredWindows', () => {
  it('returns one entry per (kind, key, windowMs) for antipattern + tool-failure rules', () => {
    const engine = new LocalAlertEngine();
    const stuckLoop: LocalAlertRule = {
      id: 'stuck-loop',
      name: 'Stuck loops',
      type: 'antipattern.count',
      severity: 'warning',
      enabled: true,
      threshold: 3,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      patternType: 'stuck_loop',
      channels: ['banner'],
    };
    const anyPattern: LocalAlertRule = {
      ...stuckLoop,
      id: 'any-pattern',
      patternType: undefined,
      windowSeconds: 600,
    } as LocalAlertRule;
    const bashFailures: LocalAlertRule = {
      id: 'bash-failures',
      name: 'Bash failure spike',
      type: 'tool.failure',
      severity: 'warning',
      enabled: true,
      threshold: 20,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      tool: 'Bash',
      channels: ['banner'],
    };
    engine.loadRules([stuckLoop, anyPattern, bashFailures]);

    const windows = engine.getRequiredWindows();
    expect(windows).toContainEqual({
      kind: 'antipattern',
      key: 'stuck_loop',
      windowMs: 300_000,
    });
    expect(windows).toContainEqual({
      kind: 'antipattern',
      key: '*',
      windowMs: 600_000,
    });
    expect(windows).toContainEqual({
      kind: 'tool-failure',
      key: 'Bash',
      windowMs: 300_000,
    });
  });

  it('omits disabled rules', () => {
    const engine = new LocalAlertEngine();
    const rule: LocalAlertRule = {
      id: 'stuck-loop',
      name: 'Stuck loops',
      type: 'antipattern.count',
      severity: 'warning',
      enabled: false,
      threshold: 3,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 300,
      patternType: 'stuck_loop',
      channels: ['banner'],
    };
    engine.loadRules([rule]);
    expect(engine.getRequiredWindows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OS notification wiring (Phase 4 — task 22)
// ---------------------------------------------------------------------------

describe('LocalAlertEngine — OS notifications', () => {
  function makeNotifier(): { notifier: OsNotifier; calls: Array<{ title: string; body: string }> } {
    const calls: Array<{ title: string; body: string }> = [];
    const notify = jest.fn(async (input: { title: string; body: string }) => {
      calls.push({ title: input.title, body: input.body });
    });
    const notifier = { notify } as unknown as OsNotifier;
    return { notifier, calls };
  }

  function makeCostRule(channels: ('banner' | 'os')[]): LocalAlertRule {
    return {
      id: 'session-cost',
      name: 'Session cost > $5',
      type: 'cost.window',
      severity: 'warning',
      enabled: true,
      threshold: 5,
      operator: 'above',
      deduplicateSeconds: 0,
      windowSeconds: 3600,
      costPeriod: 'session',
      channels,
    } as LocalAlertRule;
  }

  it('fires the notifier for firing events when both the master flag and rule channel are on', () => {
    const { notifier, calls } = makeNotifier();
    const engine = new LocalAlertEngine({
      osNotifier: notifier,
      osNotificationsEnabled: true,
    });
    engine.loadRules([makeCostRule(['banner', 'os'])]);
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      1700000000000,
    );
    expect(events.map((e) => e.state)).toEqual(['firing']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe('Session cost > $5');
    expect(calls[0]!.body).toContain('$5');
  });

  it('does NOT fire when osNotificationsEnabled is false', () => {
    const { notifier, calls } = makeNotifier();
    const engine = new LocalAlertEngine({
      osNotifier: notifier,
      osNotificationsEnabled: false,
    });
    engine.loadRules([makeCostRule(['banner', 'os'])]);
    engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      1700000000000,
    );
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire when the rule's channels list does not include 'os'", () => {
    const { notifier, calls } = makeNotifier();
    const engine = new LocalAlertEngine({
      osNotifier: notifier,
      osNotificationsEnabled: true,
    });
    engine.loadRules([makeCostRule(['banner'])]);
    engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      1700000000000,
    );
    expect(calls).toHaveLength(0);
  });

  it('does NOT fire for cleared events even when both flags align', () => {
    const { notifier, calls } = makeNotifier();
    const engine = new LocalAlertEngine({
      osNotifier: notifier,
      osNotificationsEnabled: true,
    });
    engine.loadRules([makeCostRule(['banner', 'os'])]);
    const t = 1700000000000;
    // Fire first (one notification expected)
    engine.evaluate(makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }), t);
    expect(calls).toHaveLength(1);
    // Clear — no additional notification
    engine.evaluate(makeSnapshot({ cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 } }), t + 1000);
    expect(calls).toHaveLength(1);
  });

  it('is a no-op when no notifier is wired in', () => {
    const engine = new LocalAlertEngine({ osNotificationsEnabled: true });
    engine.loadRules([makeCostRule(['os'])]);
    // Should not throw or warn
    const events = engine.evaluate(
      makeSnapshot({ cost: { sessionUsd: 10, todayUsd: 0, weekUsd: 0 } }),
      1700000000000,
    );
    expect(events).toHaveLength(1);
  });
});

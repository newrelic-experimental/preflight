import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LiveEventBus, type AlertEvent } from '../dashboard/live-event-bus.js';
import { BudgetTracker } from '../metrics/budget-tracker.js';
import { LocalAlertEngine, type AlertSnapshot } from './local-alert-engine.js';
import type { LocalAlertRule } from './local-alert-rule.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('Local alerts — Phase 1 acceptance', () => {
  it('drives a budget threshold through tracker → engine → bus end-to-end', () => {
    const bus = new LiveEventBus();
    const engine = new LocalAlertEngine();

    const rule: LocalAlertRule = {
      id: 'session-budget-80',
      name: 'Session budget 80%',
      type: 'budget.session',
      severity: 'warning',
      enabled: true,
      threshold: 80,
      operator: 'above',
      deduplicateSeconds: 1,
      channels: ['banner'],
    };
    engine.loadRules([rule]);

    // Engine drains alerts onto the bus + (in production) the JSONL log.
    engine.setOnAlert((event) => {
      bus.emit('alert', event);
    });

    // Real BudgetTracker — $1 session budget, callback wired through engine.
    const tracker = new BudgetTracker({
      sessionBudgetUsd: 1,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });

    tracker.setOnThreshold((event) => {
      engine.evaluate(
        {
          timestamp: event.timestamp,
          cost: { sessionUsd: event.spentUsd, todayUsd: 0, weekUsd: 0 },
          efficiency: { score: null },
          antiPatterns: [],
          latency: [],
          toolFailures: [],
          budgetThresholds: [
            {
              period: event.period,
              thresholdPct: event.thresholdPct,
              spentUsd: event.spentUsd,
              budgetUsd: event.budgetUsd,
            },
          ],
        },
        Date.now(),
      );
    });

    const received: AlertEvent[] = [];
    bus.on('alert', (event) => received.push(event));

    // Trigger the 80% threshold ($0.85 of $1.00).
    tracker.updateCost(0.85, 0, 0);

    // BudgetTracker fires 50% AND 80% (both crossed by 0.85). The rule has
    // threshold 80, so only the 80% threshold satisfies it.
    const firingFor80 = received.filter(
      (e) => e.id === 'session-budget-80' && e.state === 'firing',
    );
    expect(firingFor80).toHaveLength(1);
    expect(firingFor80[0]!.severity).toBe('warning');
    expect(firingFor80[0]!.value).toBe(80);
    expect(firingFor80[0]!.threshold).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 acceptance — drive the full starter rule set through evaluate()
// ---------------------------------------------------------------------------

const STARTER_RULES: LocalAlertRule[] = [
  // 1. Cost window — session
  {
    id: 'session-cost-spike',
    name: 'Session cost spike',
    type: 'cost.window',
    severity: 'warning',
    enabled: true,
    threshold: 5,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
    windowSeconds: 3600,
    costPeriod: 'session',
  },
  // 2. Efficiency below
  {
    id: 'low-efficiency',
    name: 'Efficiency below 0.4',
    type: 'efficiency.below',
    severity: 'warning',
    enabled: true,
    threshold: 0.4,
    operator: 'below',
    deduplicateSeconds: 0,
    channels: ['banner'],
    windowSeconds: 30 * 60,
  },
  // 3. Stuck-loop count
  {
    id: 'stuck-loop-rate',
    name: 'Stuck loops > 3 per 5 min',
    type: 'antipattern.count',
    severity: 'critical',
    enabled: true,
    threshold: 3,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
    windowSeconds: 300,
    patternType: 'stuck_loop',
  },
  // 4. Any anti-pattern count
  {
    id: 'any-pattern-rate',
    name: 'Any pattern > 10 in 10 min',
    type: 'antipattern.count',
    severity: 'warning',
    enabled: true,
    threshold: 10,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
    windowSeconds: 600,
  },
  // 5. Latency.percentile
  {
    id: 'bash-latency',
    name: 'Bash p95 > 2 s',
    type: 'latency.percentile',
    severity: 'warning',
    enabled: true,
    threshold: 2000,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
    percentile: 95,
    tool: 'Bash',
  },
  // 6. Budget.session
  {
    id: 'session-cost-budget',
    name: 'Session budget 80%',
    type: 'budget.session',
    severity: 'warning',
    enabled: true,
    threshold: 80,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
  },
  // 7. Budget.daily
  {
    id: 'daily-cost-budget',
    name: 'Daily budget 80%',
    type: 'budget.daily',
    severity: 'warning',
    enabled: true,
    threshold: 80,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
  },
  // 8. Tool.failure
  {
    id: 'bash-failures',
    name: 'Bash failure spike',
    type: 'tool.failure',
    severity: 'warning',
    enabled: true,
    threshold: 20,
    operator: 'above',
    deduplicateSeconds: 0,
    channels: ['banner'],
    windowSeconds: 300,
    tool: 'Bash',
  },
];

function emptySnapshot(timestamp: number, overrides: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    timestamp,
    cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 },
    efficiency: { score: null },
    antiPatterns: [],
    latency: [],
    toolFailures: [],
    ...overrides,
  };
}

describe('Local alerts — Phase 2 acceptance (full starter rule set)', () => {
  it('drives a sequence of synthetic snapshots and emits expected fire/clear events', () => {
    const bus = new LiveEventBus();
    const engine = new LocalAlertEngine();
    engine.loadRules(STARTER_RULES);
    engine.setOnAlert((event) => {
      bus.emit('alert', event);
    });

    const received: AlertEvent[] = [];
    bus.on('alert', (e) => received.push(e));

    let t = 1700000000000;

    // Tick 1: cost window crossed.
    engine.evaluate(emptySnapshot(t, { cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 } }), t);
    expect(
      received.filter((e) => e.id === 'session-cost-spike' && e.state === 'firing'),
    ).toHaveLength(1);

    // Tick 2: stuck-loop rule fires AND tool failure rule fires AND
    // latency rule fires. The cost-window rule is still firing — no
    // additional event.
    t += 30_000;
    engine.evaluate(
      emptySnapshot(t, {
        cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 },
        antiPatterns: [
          { type: 'stuck_loop', count: 4, windowMs: 300_000 },
          { type: '*', count: 12, windowMs: 600_000 },
        ],
        latency: [{ tool: 'Bash', p50Ms: 200, p95Ms: 2500, p99Ms: 3000 }],
        toolFailures: [{ tool: 'Bash', failurePct: 25, windowMs: 300_000 }],
      }),
      t,
    );
    expect(received.filter((e) => e.id === 'stuck-loop-rate' && e.state === 'firing')).toHaveLength(
      1,
    );
    expect(
      received.filter((e) => e.id === 'any-pattern-rate' && e.state === 'firing'),
    ).toHaveLength(1);
    expect(received.filter((e) => e.id === 'bash-latency' && e.state === 'firing')).toHaveLength(1);
    expect(received.filter((e) => e.id === 'bash-failures' && e.state === 'firing')).toHaveLength(
      1,
    );

    // Tick 3: budget threshold crossed for session at 80%.
    t += 30_000;
    engine.evaluate(
      emptySnapshot(t, {
        cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 },
        antiPatterns: [
          { type: 'stuck_loop', count: 4, windowMs: 300_000 },
          { type: '*', count: 12, windowMs: 600_000 },
        ],
        latency: [{ tool: 'Bash', p50Ms: 200, p95Ms: 2500, p99Ms: 3000 }],
        toolFailures: [{ tool: 'Bash', failurePct: 25, windowMs: 300_000 }],
        budgetThresholds: [{ period: 'session', thresholdPct: 80, spentUsd: 4, budgetUsd: 5 }],
      }),
      t,
    );
    expect(
      received.filter((e) => e.id === 'session-cost-budget' && e.state === 'firing'),
    ).toHaveLength(1);

    // Tick 4: efficiency below threshold but not yet sustained — no fire.
    t += 30_000;
    engine.evaluate(
      emptySnapshot(t, {
        cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 },
        efficiency: { score: 0.2 },
        antiPatterns: [
          { type: 'stuck_loop', count: 4, windowMs: 300_000 },
          { type: '*', count: 12, windowMs: 600_000 },
        ],
        latency: [{ tool: 'Bash', p50Ms: 200, p95Ms: 2500, p99Ms: 3000 }],
        toolFailures: [{ tool: 'Bash', failurePct: 25, windowMs: 300_000 }],
      }),
      t,
    );
    expect(received.filter((e) => e.id === 'low-efficiency')).toHaveLength(0);

    // Tick 5: 31 minutes later, efficiency still below — finally fires.
    t += 31 * 60 * 1000;
    engine.evaluate(
      emptySnapshot(t, {
        cost: { sessionUsd: 6, todayUsd: 0, weekUsd: 0 },
        efficiency: { score: 0.2 },
        antiPatterns: [
          { type: 'stuck_loop', count: 4, windowMs: 300_000 },
          { type: '*', count: 12, windowMs: 600_000 },
        ],
        latency: [{ tool: 'Bash', p50Ms: 200, p95Ms: 2500, p99Ms: 3000 }],
        toolFailures: [{ tool: 'Bash', failurePct: 25, windowMs: 300_000 }],
      }),
      t,
    );
    expect(received.filter((e) => e.id === 'low-efficiency' && e.state === 'firing')).toHaveLength(
      1,
    );

    // Tick 6: snapshot supplies values that resolve every firing threshold
    // rule. The session-cost-budget rule ALSO clears here because
    // sessionUsd drops to 0 (below the firing spentUsd of 4), which the
    // engine treats as a session reset (CostTracker reset on new Claude
    // Code session). Daily/weekly rules still rely on calendar period rollover,
    // but session can reset mid-process so it must clear by cost drop.
    t += 30_000;
    engine.evaluate(
      emptySnapshot(t, {
        efficiency: { score: 0.9 },
        antiPatterns: [
          { type: 'stuck_loop', count: 0, windowMs: 300_000 },
          { type: '*', count: 0, windowMs: 600_000 },
        ],
        latency: [{ tool: 'Bash', p50Ms: 20, p95Ms: 50, p99Ms: 75 }],
        toolFailures: [{ tool: 'Bash', failurePct: 0, windowMs: 300_000 }],
      }),
      t,
    );
    const clearedIds = new Set(received.filter((e) => e.state === 'cleared').map((e) => e.id));
    expect(clearedIds).toEqual(
      new Set([
        'session-cost-spike',
        'stuck-loop-rate',
        'any-pattern-rate',
        'bash-latency',
        'bash-failures',
        'low-efficiency',
        'session-cost-budget',
      ]),
    );
  });
});

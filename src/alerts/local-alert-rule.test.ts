import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { localAlertRuleSchema, parseLocalAlertRules } from './local-alert-rule.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('localAlertRuleSchema — valid rules', () => {
  it('accepts a cost.window rule with required fields', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'session-cost-spike',
      name: 'Session cost spike',
      type: 'cost.window',
      severity: 'warning',
      threshold: 10,
      windowSeconds: 3600,
    });
    expect(parsed.type).toBe('cost.window');
    if (parsed.type === 'cost.window') {
      expect(parsed.windowSeconds).toBe(3600);
      // costPeriod default is 'session' — the snapshot collector only
      // populates sessionUsd, so a rule that omits costPeriod defaults to
      // the only working period.
      expect(parsed.costPeriod).toBe('session');
    }
    expect(parsed.enabled).toBe(true); // default
    expect(parsed.operator).toBe('above'); // default
    expect(parsed.deduplicateSeconds).toBe(300); // default
    expect(parsed.channels).toEqual(['banner']); // default
  });

  it('accepts an efficiency.below rule', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'low-efficiency',
      name: 'Low efficiency',
      type: 'efficiency.below',
      severity: 'info',
      threshold: 40,
      windowSeconds: 1800,
      operator: 'below',
    });
    expect(parsed.type).toBe('efficiency.below');
    expect(parsed.operator).toBe('below');
  });

  it('accepts an antipattern.count rule with patternType filter', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'stuck-loops',
      name: 'Stuck loops',
      type: 'antipattern.count',
      severity: 'warning',
      threshold: 3,
      windowSeconds: 300,
      patternType: 'stuck_loop',
    });
    expect(parsed.type).toBe('antipattern.count');
    if (parsed.type === 'antipattern.count') {
      expect(parsed.patternType).toBe('stuck_loop');
    }
  });

  it('accepts an antipattern.count rule without patternType (any type)', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'any-pattern-rate',
      name: 'Any pattern rate',
      type: 'antipattern.count',
      severity: 'info',
      threshold: 10,
      windowSeconds: 600,
    });
    expect(parsed.type).toBe('antipattern.count');
    if (parsed.type === 'antipattern.count') {
      expect(parsed.patternType).toBeUndefined();
    }
  });

  it('accepts a latency.percentile rule', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'slow-edits',
      name: 'Slow edits',
      type: 'latency.percentile',
      severity: 'warning',
      threshold: 5000,
      percentile: 95,
      tool: 'Edit',
    });
    expect(parsed.type).toBe('latency.percentile');
    if (parsed.type === 'latency.percentile') {
      expect(parsed.percentile).toBe(95);
      expect(parsed.tool).toBe('Edit');
    }
  });

  it('accepts each budget.* rule type', () => {
    const session = localAlertRuleSchema.parse({
      id: 'session-budget',
      name: 'Session budget',
      type: 'budget.session',
      severity: 'warning',
      threshold: 80,
    });
    const daily = localAlertRuleSchema.parse({
      id: 'daily-budget',
      name: 'Daily budget',
      type: 'budget.daily',
      severity: 'critical',
      threshold: 100,
    });
    const weekly = localAlertRuleSchema.parse({
      id: 'weekly-budget',
      name: 'Weekly budget',
      type: 'budget.weekly',
      severity: 'info',
      threshold: 50,
    });
    expect(session.type).toBe('budget.session');
    expect(daily.type).toBe('budget.daily');
    expect(weekly.type).toBe('budget.weekly');
  });

  it('accepts a tool.failure rule', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'edit-failures',
      name: 'Edit failures',
      type: 'tool.failure',
      severity: 'warning',
      threshold: 25,
      windowSeconds: 600,
      tool: 'Edit',
    });
    expect(parsed.type).toBe('tool.failure');
    if (parsed.type === 'tool.failure') {
      expect(parsed.tool).toBe('Edit');
    }
  });

  it('honors custom channels and deduplicateSeconds', () => {
    const parsed = localAlertRuleSchema.parse({
      id: 'critical-cost',
      name: 'Critical cost',
      type: 'budget.session',
      severity: 'critical',
      threshold: 100,
      channels: ['banner', 'os'],
      deduplicateSeconds: 60,
    });
    expect(parsed.channels).toEqual(['banner', 'os']);
    expect(parsed.deduplicateSeconds).toBe(60);
  });
});

describe('parseLocalAlertRules — bulk parsing', () => {
  it('returns all valid rules and collects invalid ones (5 invalid cases)', () => {
    const inputs: unknown[] = [
      // valid
      {
        id: 'session-cost-spike',
        name: 'Session cost spike',
        type: 'cost.window',
        severity: 'warning',
        threshold: 10,
        windowSeconds: 3600,
      },
      // invalid #1: unknown rule type
      {
        id: 'unknown',
        name: 'Unknown',
        type: 'totally.unknown',
        severity: 'warning',
        threshold: 1,
      },
      // invalid #2: id contains an illegal character
      {
        id: 'bad id!',
        name: 'Bad id',
        type: 'budget.session',
        severity: 'warning',
        threshold: 80,
      },
      // invalid #3: missing required field windowSeconds for efficiency.below
      {
        id: 'eff',
        name: 'Eff',
        type: 'efficiency.below',
        severity: 'warning',
        threshold: 40,
      },
      // invalid #4: percentile not in {50,95,99}
      {
        id: 'p70',
        name: 'p70',
        type: 'latency.percentile',
        severity: 'info',
        threshold: 1000,
        percentile: 70,
      },
      // invalid #5: severity is not a valid value
      {
        id: 'session-budget',
        name: 'Session budget',
        type: 'budget.session',
        severity: 'fatal',
        threshold: 80,
      },
    ];

    const { valid, invalid } = parseLocalAlertRules(inputs);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.id).toBe('session-cost-spike');
    expect(invalid).toHaveLength(5);
    for (const entry of invalid) {
      expect(typeof entry.error).toBe('string');
      expect(entry.error.length).toBeGreaterThan(0);
    }
  });

  it('accepts a single rule object (not just an array)', () => {
    const { valid, invalid } = parseLocalAlertRules({
      id: 'single',
      name: 'Single',
      type: 'budget.session',
      severity: 'warning',
      threshold: 80,
    });
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it('returns empty arrays for an empty input list', () => {
    const { valid, invalid } = parseLocalAlertRules([]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  // two rules sharing an `id` both pass schema validation, but the
  // LocalAlertEngine keys state by id, so the second silently shadowed
  // the first. Drop duplicates here, keeping the first occurrence and
  // surfacing the rest as `invalid`.
  it('drops duplicate rule ids — keeps the first occurrence', () => {
    const { valid, invalid } = parseLocalAlertRules([
      {
        id: 'shared',
        name: 'First',
        type: 'budget.session',
        severity: 'warning',
        threshold: 50,
      },
      {
        id: 'shared',
        name: 'Second (different threshold)',
        type: 'budget.session',
        severity: 'critical',
        threshold: 80,
      },
      {
        id: 'distinct',
        name: 'Distinct',
        type: 'budget.session',
        severity: 'warning',
        threshold: 50,
      },
    ]);
    expect(valid).toHaveLength(2);
    expect(valid.map((r) => r.id)).toEqual(['shared', 'distinct']);
    // First-wins: keep the warning/threshold=50 rule, not the critical/80 one.
    expect(valid[0]!.name).toBe('First');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.error).toMatch(/duplicate rule id 'shared'/);
  });

  it('logs a warning when a duplicate rule id is dropped', () => {
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    parseLocalAlertRules([
      {
        id: 'dup',
        name: 'A',
        type: 'budget.session',
        severity: 'warning',
        threshold: 50,
      },
      {
        id: 'dup',
        name: 'B',
        type: 'budget.session',
        severity: 'warning',
        threshold: 50,
      },
    ]);
    const captured = warnSpy.mock.calls.map((args) => String(args[0])).join('');
    warnSpy.mockRestore();
    expect(captured).toContain('duplicate alert rule id');
    expect(captured).toContain('"id":"dup"');
  });
});

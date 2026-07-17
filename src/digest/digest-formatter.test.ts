import { describe, it, expect } from '@jest/globals';
import type { WeeklySummary } from '../storage/weekly-summary.js';
import { formatSlackDigest } from './digest-formatter.js';

function makeWeeklySummary(overrides: Partial<WeeklySummary> = {}): WeeklySummary {
  return {
    week: '2026-W18',
    generatedAt: Date.now(),
    developers: [],
    sessionCount: 0,
    totalCostUsd: 0,
    avgCostPerSession: 0,
    avgEfficiencyScore: null,
    totalToolCalls: 0,
    toolBreakdown: {},
    totalTasksCompleted: 0,
    taskSuccessRate: null,
    antiPatternCounts: {},
    perDeveloper: {},
    ...overrides,
  };
}

describe('formatSlackDigest', () => {
  it('produces a blocks array', () => {
    const payload = formatSlackDigest(
      makeWeeklySummary({ totalCostUsd: 1.23, avgEfficiencyScore: 72, sessionCount: 5 }),
    );
    expect(Array.isArray(payload.blocks)).toBe(true);
  });

  it('includes total cost in a field', () => {
    const payload = formatSlackDigest(makeWeeklySummary({ totalCostUsd: 2.5, sessionCount: 3 }));
    const text = JSON.stringify(payload);
    expect(text).toContain('2.5000');
  });

  it('displays efficiency score scaled to 0–100 (raw score is [0,1])', () => {
    const payload = formatSlackDigest(makeWeeklySummary({ avgEfficiencyScore: 0.8 }));
    const text = JSON.stringify(payload);
    expect(text).toContain('80.0/100');
    expect(text).not.toContain('0.8/100');
  });

  it('handles null efficiency score gracefully', () => {
    const payload = formatSlackDigest(makeWeeklySummary({ avgEfficiencyScore: null }));
    expect(JSON.stringify(payload)).not.toContain('undefined');
  });

  it('picks the most frequent anti-pattern', () => {
    const payload = formatSlackDigest(
      makeWeeklySummary({ antiPatternCounts: { thrashing: 5, re_read: 2 } }),
    );
    expect(JSON.stringify(payload)).toContain('thrashing');
  });

  it('falls back to "none" for the top anti-pattern when antiPatternCounts is empty', () => {
    const payload = formatSlackDigest(makeWeeklySummary({ antiPatternCounts: {} }));
    expect(JSON.stringify(payload)).toContain('`none`');
  });

  it('sanitizes backticks and newlines in the top anti-pattern label before embedding it in a Slack code span', () => {
    const payload = formatSlackDigest(
      makeWeeklySummary({ antiPatternCounts: { 'evil`pattern\ninjected': 5 } }),
    );
    const text = JSON.stringify(payload);
    expect(text).not.toContain('evil`pattern');
    expect(text).toContain('evil_pattern_injected');
  });
});

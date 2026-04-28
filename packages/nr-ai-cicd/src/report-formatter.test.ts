import { formatReport } from './report-formatter.js';
import type { SessionMetrics, BaselineMetrics } from './metrics-fetcher.js';

function makeCurrentMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    totalCostUsd: 1.23,
    efficiencyScore: 72,
    sessionCount: 3,
    topAntiPatterns: [{ type: 'thrashing', count: 2 }],
    modelBreakdown: [{ model: 'claude-sonnet-4-6', costUsd: 1.23 }],
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    avgDailyCostUsd: 0.8,
    avgEfficiencyScore: 65,
    ...overrides,
  };
}

describe('formatReport', () => {
  it('produces a markdown string with a heading', () => {
    const report = formatReport(makeCurrentMetrics(), makeBaseline(), 24, 'alice');
    expect(report).toContain('## 🤖 AI Coding Assistant Report');
    expect(report).toContain('alice');
  });

  it('includes cost in the table', () => {
    const report = formatReport(makeCurrentMetrics({ totalCostUsd: 2.5 }), makeBaseline(), 24, 'bob');
    expect(report).toContain('$2.5000');
  });

  it('includes efficiency score with green emoji for high scores', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 75 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🟢');
  });

  it('uses yellow emoji for mid-range efficiency', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 50 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🟡');
  });

  it('uses red emoji for low efficiency', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 20 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🔴');
  });

  it('handles null efficiency score', () => {
    const report = formatReport(
      makeCurrentMetrics({ efficiencyScore: null }),
      makeBaseline({ avgEfficiencyScore: null }),
      24,
      'x',
    );
    expect(report).not.toContain('undefined');
  });

  it('lists anti-patterns when present', () => {
    const report = formatReport(makeCurrentMetrics(), makeBaseline(), 24, 'x');
    expect(report).toContain('thrashing');
    expect(report).toContain('2×');
  });

  it('omits anti-patterns section when none detected', () => {
    const report = formatReport(
      makeCurrentMetrics({ topAntiPatterns: [] }),
      makeBaseline(),
      24,
      'x',
    );
    expect(report).not.toContain('Anti-patterns');
  });

  it('includes model breakdown table when models present', () => {
    const report = formatReport(makeCurrentMetrics(), makeBaseline(), 24, 'x');
    expect(report).toContain('### Model usage');
    expect(report).toContain('claude-sonnet-4-6');
  });

  it('omits model usage section when empty', () => {
    const report = formatReport(
      makeCurrentMetrics({ modelBreakdown: [] }),
      makeBaseline(),
      24,
      'x',
    );
    expect(report).not.toContain('Model usage');
  });

  it('shows delta as — when baseline is zero', () => {
    const report = formatReport(
      makeCurrentMetrics({ totalCostUsd: 1.0 }),
      makeBaseline({ avgDailyCostUsd: 0 }),
      24,
      'x',
    );
    expect(report).toContain('—');
  });

  it('shows positive delta percentage when cost exceeds baseline', () => {
    const report = formatReport(
      makeCurrentMetrics({ totalCostUsd: 2.0 }),
      makeBaseline({ avgDailyCostUsd: 1.0 }),
      24,
      'x',
    );
    expect(report).toContain('+100.0%');
  });

  it('shows negative delta percentage when cost is below baseline', () => {
    const report = formatReport(
      makeCurrentMetrics({ totalCostUsd: 0.5 }),
      makeBaseline({ avgDailyCostUsd: 1.0 }),
      24,
      'x',
    );
    expect(report).toContain('-50.0%');
  });
});

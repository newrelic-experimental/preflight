import { InstructionDriftTracker, hashPrompt } from './instruction-drift-tracker.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

describe('hashPrompt', () => {
  it('returns a 16-char hex string', () => {
    const hash = hashPrompt('some system prompt text');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(hashPrompt('hello')).toBe(hashPrompt('hello'));
  });

  it('differs for different inputs', () => {
    expect(hashPrompt('prompt A')).not.toBe(hashPrompt('prompt B'));
  });
});

describe('InstructionDriftTracker', () => {
  it('sets prompt and returns hash', () => {
    const tracker = new InstructionDriftTracker();
    const hash = tracker.setPrompt('You are a helpful assistant.');
    expect(hash).toHaveLength(16);

    const metrics = tracker.getMetrics();
    expect(metrics.currentPromptHash).toBe(hash);
  });

  it('records session outcomes grouped by prompt hash', () => {
    const tracker = new InstructionDriftTracker();
    tracker.setPrompt('prompt v1');

    tracker.recordSessionOutcome({
      sessionId: 's1',
      successRate: 0.8,
      totalTokens: 10000,
      thrashingIncidents: 1,
      taskCount: 3,
      avgEfficiency: 0.7,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.uniquePromptVariants).toBe(1);
    expect(metrics.variantStats[0].sessionCount).toBe(1);
    expect(metrics.variantStats[0].avgSuccessRate).toBe(0.8);
  });

  it('tracks multiple prompt variants', () => {
    const tracker = new InstructionDriftTracker({ minSessionsForComparison: 1 });
    tracker.setPrompt('prompt v1');
    tracker.recordSessionOutcome({
      sessionId: 's1',
      successRate: 0.9,
      totalTokens: 8000,
      thrashingIncidents: 0,
      taskCount: 2,
      avgEfficiency: 0.8,
    });

    tracker.setPrompt('prompt v2');
    tracker.recordSessionOutcome({
      sessionId: 's2',
      successRate: 0.5,
      totalTokens: 15000,
      thrashingIncidents: 3,
      taskCount: 2,
      avgEfficiency: 0.4,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.uniquePromptVariants).toBe(2);
  });

  it('computes correlation when prompt changes with sufficient data', () => {
    const tracker = new InstructionDriftTracker({ minSessionsForComparison: 2 });
    tracker.setPrompt('prompt v1');

    // Build up enough sessions for v1
    for (let i = 0; i < 3; i++) {
      tracker.recordSessionOutcome({
        sessionId: `s${i}`,
        successRate: 0.9,
        totalTokens: 5000,
        thrashingIncidents: 0,
        taskCount: 2,
        avgEfficiency: 0.8,
      });
    }

    // Change to v2
    tracker.setPrompt('prompt v2');
    tracker.recordSessionOutcome({
      sessionId: 's10',
      successRate: 0.4,
      totalTokens: 20000,
      thrashingIncidents: 5,
      taskCount: 2,
      avgEfficiency: 0.3,
    });

    // Change to v3 (will compute v2→v3 correlation but v2 only has 1 session < min)
    tracker.setPrompt('prompt v3');

    const metrics = tracker.getMetrics();
    // v1→v2 correlation should exist with degraded verdict (if v2 has enough data)
    // Since v2 had only 1 session and minSessionsForComparison=2, it may compute from v1's data
    expect(metrics.recentCorrelations.length).toBeGreaterThanOrEqual(1);
  });

  it('marks degraded when success rate drops significantly', () => {
    const tracker = new InstructionDriftTracker({ minSessionsForComparison: 2 });

    // Pre-load records for both variants so correlation has data
    const goodHash = hashPrompt('good prompt');
    const badHash = hashPrompt('bad prompt');

    tracker.loadRecords([
      {
        sessionId: 'g0',
        promptHash: goodHash,
        timestamp: 1000,
        successRate: 0.95,
        totalTokens: 5000,
        thrashingIncidents: 0,
        taskCount: 3,
        avgEfficiency: 0.85,
      },
      {
        sessionId: 'g1',
        promptHash: goodHash,
        timestamp: 2000,
        successRate: 0.95,
        totalTokens: 5000,
        thrashingIncidents: 0,
        taskCount: 3,
        avgEfficiency: 0.85,
      },
      {
        sessionId: 'g2',
        promptHash: goodHash,
        timestamp: 3000,
        successRate: 0.95,
        totalTokens: 5000,
        thrashingIncidents: 0,
        taskCount: 3,
        avgEfficiency: 0.85,
      },
      {
        sessionId: 'b0',
        promptHash: badHash,
        timestamp: 4000,
        successRate: 0.3,
        totalTokens: 20000,
        thrashingIncidents: 4,
        taskCount: 2,
        avgEfficiency: 0.3,
      },
      {
        sessionId: 'b1',
        promptHash: badHash,
        timestamp: 5000,
        successRate: 0.3,
        totalTokens: 20000,
        thrashingIncidents: 4,
        taskCount: 2,
        avgEfficiency: 0.3,
      },
      {
        sessionId: 'b2',
        promptHash: badHash,
        timestamp: 6000,
        successRate: 0.3,
        totalTokens: 20000,
        thrashingIncidents: 4,
        taskCount: 2,
        avgEfficiency: 0.3,
      },
    ]);

    // Set to good first, then transition to bad — triggers correlation
    tracker.setPromptHash(goodHash);
    tracker.setPromptHash(badHash);

    const metrics = tracker.getMetrics();
    const degraded = metrics.recentCorrelations.find((c) => c.verdict === 'degraded');
    expect(degraded).toBeDefined();
    expect(degraded!.successRateDelta).toBeLessThan(0);
  });

  it('returns insufficient_data when not enough sessions', () => {
    const tracker = new InstructionDriftTracker({ minSessionsForComparison: 5 });
    tracker.setPrompt('v1');
    tracker.recordSessionOutcome({
      sessionId: 's1',
      successRate: 0.9,
      totalTokens: 5000,
      thrashingIncidents: 0,
      taskCount: 2,
      avgEfficiency: 0.8,
    });
    tracker.setPrompt('v2');

    const metrics = tracker.getMetrics();
    expect(metrics.recentCorrelations[0]?.verdict).toBe('insufficient_data');
  });

  it('loadRecords populates history', () => {
    const tracker = new InstructionDriftTracker();
    const hash = hashPrompt('loaded prompt');
    tracker.setPromptHash(hash);
    tracker.loadRecords([
      {
        sessionId: 'r1',
        promptHash: hash,
        timestamp: 1000,
        successRate: 0.9,
        totalTokens: 5000,
        thrashingIncidents: 0,
        taskCount: 2,
        avgEfficiency: 0.8,
      },
    ]);

    expect(tracker.getRecords()).toHaveLength(1);
    expect(tracker.getMetrics().currentVariantSessionCount).toBe(1);
  });

  it('reset clears all state', () => {
    const tracker = new InstructionDriftTracker();
    tracker.setPrompt('test');
    tracker.recordSessionOutcome({
      sessionId: 's1',
      successRate: 0.9,
      totalTokens: 5000,
      thrashingIncidents: 0,
      taskCount: 2,
      avgEfficiency: 0.8,
    });

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();
    expect(metrics.currentPromptHash).toBeNull();
    expect(metrics.uniquePromptVariants).toBe(0);
  });

  it('promptHash getter reflects the current prompt hash', () => {
    const tracker = new InstructionDriftTracker();
    expect(tracker.promptHash).toBeNull();

    tracker.setPromptHash('abc123');
    expect(tracker.promptHash).toBe('abc123');

    tracker.setPromptHash('def456');
    expect(tracker.promptHash).toBe('def456');
  });
});

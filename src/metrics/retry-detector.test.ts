import { RetryDetector, normalizedLevenshteinSimilarity } from './retry-detector.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => stderrSpy.mockClear());

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: `tu-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    inputSizeBytes: 200,
    outputSizeBytes: 300,
    ...overrides,
  };
}

describe('normalizedLevenshteinSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(normalizedLevenshteinSimilarity('abc', 'abc')).toBe(1);
  });

  it('returns 0 for completely different strings of same length', () => {
    // 'aaa' vs 'bbb' → distance 3, max 3 → similarity 0
    expect(normalizedLevenshteinSimilarity('aaa', 'bbb')).toBe(0);
  });

  it('returns value between 0 and 1 for partially similar strings', () => {
    const sim = normalizedLevenshteinSimilarity('kitten', 'sitting');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('handles empty strings', () => {
    expect(normalizedLevenshteinSimilarity('', '')).toBe(1);
    expect(normalizedLevenshteinSimilarity('abc', '')).toBe(0);
  });
});

describe('RetryDetector', () => {
  it('does not alert below threshold', () => {
    const detector = new RetryDetector();
    const alert = detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    expect(alert).toBeNull();
    detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    expect(detector.getMetrics().totalAlertsEmitted).toBe(0);
  });

  it('alerts when same tool fails 3+ times in 5 consecutive turns', () => {
    const alerts: unknown[] = [];
    const detector = new RetryDetector({ onAlert: (a) => alerts.push(a) });

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, command: 'npm test' }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, command: 'npm test' }));
    const result = detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, command: 'npm test' }));

    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('Bash');
    expect(result!.occurrences).toBe(3);
    expect(alerts).toHaveLength(1);
  });

  it('alerts when inputs are highly similar even if some succeed', () => {
    const detector = new RetryDetector({ similarityThreshold: 0.8 });

    detector.recordToolCall(makeRecord({ toolName: 'Edit', success: true, filePath: '/a/b.ts', command: 'fix bug line 10' }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit', success: true, filePath: '/a/b.ts', command: 'fix bug line 11' }));
    const result = detector.recordToolCall(makeRecord({ toolName: 'Edit', success: true, filePath: '/a/b.ts', command: 'fix bug line 12' }));

    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('does not alert when tools are different', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));

    expect(detector.getMetrics().totalAlertsEmitted).toBe(0);
  });

  it('estimates tokens wasted from input/output sizes', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }));
    const alert = detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }));

    expect(alert).not.toBeNull();
    // 3 calls × (400 + 600) bytes / 4 bytes per token = 750
    expect(alert!.tokensWastedEstimate).toBe(750);
  });

  it('does not fire duplicate alerts for the same window position', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));

    // 4th call in same streak — should not re-fire for same dedup key
    const result = detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    // A new window position may trigger a new alert (4 calls in last 5)
    // but total should be limited
    expect(detector.getMetrics().totalAlertsEmitted).toBeLessThanOrEqual(2);
    void result;
  });

  it('reset clears all state', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));

    detector.reset('new-session');
    const metrics = detector.getMetrics();
    expect(metrics.alerts).toHaveLength(0);
    expect(metrics.totalTokensWasted).toBe(0);
    expect(metrics.totalAlertsEmitted).toBe(0);
  });

  it('respects custom window size', () => {
    const detector = new RetryDetector({ windowSize: 3, minOccurrences: 3 });

    detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit', success: true })); // breaks the window
    detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    // Only 2 Read calls in last 3 turns
    const result = detector.recordToolCall(makeRecord({ toolName: 'Read', success: false }));
    // Window of 3: [Edit, Read, Read] → only 2 Read calls
    expect(result).toBeNull();
  });

  it('fires multiple alerts for separate thrashing episodes', () => {
    const alerts: unknown[] = [];
    const detector = new RetryDetector({ onAlert: (a) => alerts.push(a) });

    // First thrashing episode
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    expect(alerts).toHaveLength(1);

    // Interlude of successful calls to shift the window
    for (let i = 0; i < 10; i++) {
      detector.recordToolCall(makeRecord({ toolName: 'Read', success: true }));
    }

    // Second thrashing episode
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    expect(alerts.length).toBeGreaterThan(1);
  });

  it('emitMetrics records expected metrics', () => {
    const aggregator = { record: jest.fn() };
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));

    detector.emitMetrics(aggregator as never);
    expect(aggregator.record).toHaveBeenCalledWith('ai.retry.alerts_total', 1);
    expect(aggregator.record).toHaveBeenCalledWith('ai.retry.tokens_wasted', expect.any(Number));
  });

  it('emitMetrics does nothing when no alerts', () => {
    const aggregator = { record: jest.fn() };
    const detector = new RetryDetector();
    detector.emitMetrics(aggregator as never);
    expect(aggregator.record).not.toHaveBeenCalled();
  });
});

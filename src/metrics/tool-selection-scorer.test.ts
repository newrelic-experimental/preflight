import { ToolSelectionScorer, toToolSelectionSummary } from './tool-selection-scorer.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

let idCounter = 0;
function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: `id-${++idCounter}`,
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: `tu-${idCounter}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    inputSizeBytes: 200,
    outputSizeBytes: 300,
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
});

describe('ToolSelectionScorer', () => {
  it('returns perfect score for empty session', () => {
    const scorer = new ToolSelectionScorer();
    const metrics = scorer.scoreSession([]);
    expect(metrics.score).toBe(1);
    expect(metrics.totalCalls).toBe(0);
  });

  it('returns perfect score for well-behaved session', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts', outputSizeBytes: 500 }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBe(1);
    expect(metrics.penalizedCalls).toBe(0);
  });

  it('penalizes redundant reads of same file', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBeLessThan(1);
    // First 2 reads are free; 3rd and 4th are penalized
    expect(metrics.redundantReadCount).toBe(2);
  });

  it('penalizes repeated failures of same tool', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [
      makeRecord({ toolName: 'Bash', success: false }),
      makeRecord({ toolName: 'Bash', success: false }),
      makeRecord({ toolName: 'Bash', success: false }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBeLessThan(1);
    expect(metrics.repeatedFailureCount).toBe(2);
  });

  it('penalizes large unused outputs from non-terminal tools', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      // Read produces large output but file is never Edit'd or referenced
      makeRecord({
        toolName: 'Read',
        filePath: '/unused.ts',
        outputSizeBytes: 5000,
        inputSizeBytes: 100,
      }),
      makeRecord({
        toolName: 'Read',
        filePath: '/other.ts',
        outputSizeBytes: 100,
        inputSizeBytes: 50,
      }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(1);
    expect(metrics.score).toBeLessThan(1);
  });

  it('does not penalize terminal tools (Edit/Bash/Agent) for unused output', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts', outputSizeBytes: 5000 }),
      makeRecord({ toolName: 'Bash', outputSizeBytes: 5000 }),
      makeRecord({ toolName: 'Agent', outputSizeBytes: 10000 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
    expect(metrics.score).toBe(1);
  });

  it('does not penalize large Read output when file is subsequently edited', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({
        toolName: 'Read',
        filePath: '/fix.ts',
        outputSizeBytes: 5000,
        inputSizeBytes: 100,
      }),
      makeRecord({ toolName: 'Edit', inputSizeBytes: 2000, filePath: '/fix.ts' }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });

  it('does not penalize Read followed by Edit of same file', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts', outputSizeBytes: 3000 }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts', inputSizeBytes: 100 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });

  it('identifies worst offenders sorted by penalty', () => {
    const scorer = new ToolSelectionScorer({ worstOffenderCount: 2 });
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }), // 3rd read = penalized
      makeRecord({ toolName: 'Bash', success: false }),
      makeRecord({ toolName: 'Bash', success: false }),
      makeRecord({ toolName: 'Bash', success: false }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.worstOffenders).toHaveLength(2);
    expect(metrics.worstOffenders[0].penaltyScore).toBeGreaterThanOrEqual(
      metrics.worstOffenders[1].penaltyScore,
    );
  });

  it('score has a floor at 0.3 even for terrible sessions', () => {
    const scorer = new ToolSelectionScorer();
    const calls: ToolCallRecord[] = [];
    // Many redundant reads + repeated failures. Total penalty is capped at 0.7.
    for (let i = 0; i < 31; i++) {
      calls.push(makeRecord({ toolName: 'Read', filePath: '/same.ts' }));
    }
    for (let i = 0; i < 10; i++) {
      calls.push(makeRecord({ toolName: 'Bash', success: false }));
    }

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBe(0.3);
  });

  it('penalizes large output not followed by any referencing call', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts', outputSizeBytes: 3000 }),
      makeRecord({ toolName: 'Read', filePath: '/b.ts', outputSizeBytes: 100, inputSizeBytes: 50 }),
      makeRecord({ toolName: 'Read', filePath: '/c.ts', outputSizeBytes: 100, inputSizeBytes: 50 }),
      makeRecord({ toolName: 'Read', filePath: '/d.ts', outputSizeBytes: 100, inputSizeBytes: 50 }),
      makeRecord({ toolName: 'Read', filePath: '/e.ts', outputSizeBytes: 100, inputSizeBytes: 50 }),
      makeRecord({ toolName: 'Read', filePath: '/f.ts', outputSizeBytes: 100, inputSizeBytes: 50 }),
    ];

    const metrics = scorer.scoreSession(calls);
    // /a.ts was Read but never Edited, and subsequent calls have tiny inputs
    expect(metrics.unusedOutputCount).toBe(1);
  });

  it('large Bash input following a Read does not falsely mark the Read as referenced', () => {
    // A Bash call with a large script (>500 bytes) after a Read should NOT be treated as
    // evidence that the Read output was incorporated. Without the fix, the size heuristic
    // returns true and unusedOutputCount stays at 0 (false negative penalty).
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/config.ts', outputSizeBytes: 3000 }),
      // Large Bash script — unrelated to the Read above
      makeRecord({ toolName: 'Bash', inputSizeBytes: 2000, outputSizeBytes: 200 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(1);
  });

  it('does not penalize failed calls even with large output', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [makeRecord({ toolName: 'Bash', success: false, outputSizeBytes: 5000 })];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });
});

describe('toToolSelectionSummary', () => {
  it('drops penalties and worstOffenders, keeps the 6 scalar fields', () => {
    const scorer = new ToolSelectionScorer();
    const metrics = scorer.scoreSession([]);
    const summary = toToolSelectionSummary({
      ...metrics,
      penalties: [
        {
          callId: 'x',
          toolName: 'Read',
          reason: 'redundant_read',
          penaltyScore: 0.03,
          detail: 'd',
        },
      ],
      worstOffenders: [],
    });
    expect(summary).toEqual({
      score: 1,
      totalCalls: 0,
      penalizedCalls: 0,
      redundantReadCount: 0,
      repeatedFailureCount: 0,
      unusedOutputCount: 0,
    });
    expect(summary).not.toHaveProperty('penalties');
    expect(summary).not.toHaveProperty('worstOffenders');
  });
});

describe('ToolSelectionScorer.combineSummaries', () => {
  it('returns the trivial empty result for an empty summary list', () => {
    const scorer = new ToolSelectionScorer();
    expect(scorer.combineSummaries([])).toEqual({
      score: 1,
      totalCalls: 0,
      penalizedCalls: 0,
      penalties: [],
      worstOffenders: [],
      redundantReadCount: 0,
      repeatedFailureCount: 0,
      unusedOutputCount: 0,
    });
  });

  it('matches scoring the concatenated call list directly (below the 0.7 penalty cap)', () => {
    const scorer = new ToolSelectionScorer();
    // Session A: 2 redundant reads of the same file (3rd+ read, no edit between).
    const callsA = [
      {
        id: 'a1',
        sessionId: 's-a',
        toolName: 'Read',
        toolUseId: 'a1',
        timestamp: 1,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
      {
        id: 'a2',
        sessionId: 's-a',
        toolName: 'Read',
        toolUseId: 'a2',
        timestamp: 2,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
      {
        id: 'a3',
        sessionId: 's-a',
        toolName: 'Read',
        toolUseId: 'a3',
        timestamp: 3,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
      {
        id: 'a4',
        sessionId: 's-a',
        toolName: 'Read',
        toolUseId: 'a4',
        timestamp: 4,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
    ];
    // Session B: one repeated Bash failure.
    const callsB = [
      {
        id: 'b1',
        sessionId: 's-b',
        toolName: 'Bash',
        toolUseId: 'b1',
        timestamp: 10,
        durationMs: 5,
        success: false,
      },
      {
        id: 'b2',
        sessionId: 's-b',
        toolName: 'Bash',
        toolUseId: 'b2',
        timestamp: 11,
        durationMs: 5,
        success: false,
      },
    ];

    const summaryA = toToolSelectionSummary(scorer.scoreSession(callsA));
    const summaryB = toToolSelectionSummary(scorer.scoreSession(callsB));
    const combined = scorer.combineSummaries([summaryA, summaryB]);
    const direct = scorer.scoreSession([...callsA, ...callsB]);

    expect(combined.score).toBe(direct.score);
    expect(combined.totalCalls).toBe(direct.totalCalls);
    expect(combined.penalizedCalls).toBe(direct.penalizedCalls);
    expect(combined.redundantReadCount).toBe(direct.redundantReadCount);
    expect(combined.repeatedFailureCount).toBe(direct.repeatedFailureCount);
    expect(combined.unusedOutputCount).toBe(direct.unusedOutputCount);
    expect(combined.penalties).toEqual([]);
    expect(combined.worstOffenders).toEqual([]);
  });
});

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

  describe('agent partitioning', () => {
    it('does not penalize 3 different agents each reading the same file once', () => {
      const scorer = new ToolSelectionScorer();
      const calls = [
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-1' }),
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-2' }),
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-3' }),
      ];

      const metrics = scorer.scoreSession(calls);
      expect(metrics.redundantReadCount).toBe(0);
      expect(metrics.score).toBe(1);
    });

    it('still penalizes redundant reads within a single agent amid other agents', () => {
      const scorer = new ToolSelectionScorer();
      const calls = [
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-1' }),
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-2' }),
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-1' }),
        makeRecord({ toolName: 'Read', filePath: '/a.ts', agentId: 'agent-1' }),
      ];

      const metrics = scorer.scoreSession(calls);
      // agent-1 read /a.ts 3 times — 3rd read (index 2 within its own group) is penalized
      expect(metrics.redundantReadCount).toBe(1);
    });

    it('does not penalize 2 different agents each failing the same tool once, interleaved', () => {
      const scorer = new ToolSelectionScorer();
      const calls = [
        makeRecord({ toolName: 'Bash', success: false, agentId: 'agent-1' }),
        makeRecord({ toolName: 'Bash', success: false, agentId: 'agent-2' }),
      ];

      const metrics = scorer.scoreSession(calls);
      expect(metrics.repeatedFailureCount).toBe(0);
      expect(metrics.score).toBe(1);
    });

    it('still penalizes one agent failing the same tool consecutively amid other agents', () => {
      const scorer = new ToolSelectionScorer();
      const calls = [
        makeRecord({ toolName: 'Bash', success: false, agentId: 'agent-1' }),
        makeRecord({ toolName: 'Read', filePath: '/x.ts', agentId: 'agent-2' }),
        makeRecord({ toolName: 'Bash', success: false, agentId: 'agent-1' }),
        makeRecord({ toolName: 'Bash', success: false, agentId: 'agent-1' }),
      ];

      const metrics = scorer.scoreSession(calls);
      expect(metrics.repeatedFailureCount).toBe(2);
    });
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
    // 15 consecutive Bash failures (14 penalized) in a 15-call session — at
    // exactly the reference size, normalization is a no-op, so this is the
    // same absolute-penalty math as before the #605 fix: 14 * 0.08 = 1.12,
    // capped at 0.7.
    for (let i = 0; i < 15; i++) {
      calls.push(makeRecord({ toolName: 'Bash', success: false }));
    }

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBe(0.3);
  });

  it('normalizes penalty by session size: same defect count punishes a large session far less than a small one', () => {
    const scorer = new ToolSelectionScorer();
    const buildSession = (totalCalls: number): ToolCallRecord[] => {
      const calls: ToolCallRecord[] = [];
      // 12 reads of the same file -> first 2 free, 10 penalized redundant reads.
      for (let i = 0; i < 12; i++) {
        calls.push(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      }
      // Pad with unrelated successful Bash calls to reach the target session size.
      while (calls.length < totalCalls) {
        calls.push(makeRecord({ toolName: 'Bash', command: 'echo ok' }));
      }
      return calls;
    };

    const small = scorer.scoreSession(buildSession(15));
    const large = scorer.scoreSession(buildSession(1000));

    expect(small.redundantReadCount).toBe(10);
    expect(large.redundantReadCount).toBe(10);
    // 15 calls is the reference session size, so behavior there is unchanged
    // from the pre-normalization absolute penalty (10 * 0.03 = 0.3 -> 0.7).
    expect(small.score).toBe(0.7);
    // The same 10 redundant reads in a 1000-call session should barely register.
    expect(large.score).toBeGreaterThan(0.99);
  });

  it('does not amplify penalty for sessions below the reference size', () => {
    const scorer = new ToolSelectionScorer();
    // 4-call session, 2 penalized redundant reads (0.03 each = 0.06 raw).
    // Below the 15-call reference size, so this must score exactly as the
    // raw penalty implies (0.94) — NOT scaled up to (0.06/4)*15=0.225,
    // which would punish small sessions harder than before, the same
    // unfairness #605 was filed about, just in the opposite direction.
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.score).toBe(0.94);
  });

  it('supports a custom referenceSessionSize', () => {
    const buildSession = (totalCalls: number): ToolCallRecord[] => {
      const calls: ToolCallRecord[] = [];
      for (let i = 0; i < 12; i++) {
        calls.push(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      }
      while (calls.length < totalCalls) {
        calls.push(makeRecord({ toolName: 'Bash', command: 'echo ok' }));
      }
      return calls;
    };
    const calls = buildSession(200);

    const defaultScore = new ToolSelectionScorer().scoreSession(calls).score;
    const largerReferenceScore = new ToolSelectionScorer({
      referenceSessionSize: 100,
    }).scoreSession(calls).score;

    // A larger referenceSessionSize dilutes less at the same totalCalls, so
    // the resulting score should be lower (more penalty applied).
    expect(largerReferenceScore).toBeLessThan(defaultScore);
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

  it('does not penalize discovery/search tools (Grep, Glob, WebFetch, WebSearch) for large output', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'Grep', outputSizeBytes: 5000 }),
      makeRecord({ toolName: 'Glob', outputSizeBytes: 5000 }),
      makeRecord({ toolName: 'WebFetch', outputSizeBytes: 5000 }),
      makeRecord({ toolName: 'WebSearch', outputSizeBytes: 5000 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
    expect(metrics.score).toBe(1);
  });

  it('does not penalize mcp__-prefixed tools for large output', () => {
    const scorer = new ToolSelectionScorer({ unusedOutputSizeThreshold: 1000 });
    const calls = [
      makeRecord({ toolName: 'mcp__codegraph__codegraph_explore', outputSizeBytes: 20000 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });

  it('does not penalize an mcp__-prefixed tool at the default threshold, unbounded by its size', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [
      makeRecord({ toolName: 'mcp__codegraph__codegraph_explore', outputSizeBytes: 25000 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });

  it('does not penalize an ordinary investigation Read under the default threshold', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [
      makeRecord({ toolName: 'Read', filePath: '/investigate.ts', outputSizeBytes: 8000 }),
    ];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(0);
  });

  it('still penalizes an unreferenced Read once output exceeds the default threshold', () => {
    const scorer = new ToolSelectionScorer();
    const calls = [makeRecord({ toolName: 'Read', filePath: '/huge.ts', outputSizeBytes: 25000 })];

    const metrics = scorer.scoreSession(calls);
    expect(metrics.unusedOutputCount).toBe(1);
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

  it('scores a busy day with many calls far better than a quiet day with the same defect count', () => {
    const scorer = new ToolSelectionScorer();
    const quietDay = {
      score: 0,
      totalCalls: 20,
      penalizedCalls: 10,
      redundantReadCount: 10,
      repeatedFailureCount: 0,
      unusedOutputCount: 0,
    };
    const busyDay = { ...quietDay, totalCalls: 2000 };

    const quiet = scorer.combineSummaries([quietDay]);
    const busy = scorer.combineSummaries([busyDay]);

    expect(quiet.score).toBeLessThan(busy.score);
    expect(busy.score).toBeGreaterThan(0.99);
  });
});

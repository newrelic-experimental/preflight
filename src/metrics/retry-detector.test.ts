import { RetryDetector, normalizedLevenshteinSimilarity } from './retry-detector.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

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
    const result = detector.recordToolCall(
      makeRecord({ toolName: 'Bash', success: false, command: 'npm test' }),
    );

    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('Bash');
    expect(result!.occurrences).toBe(3);
    expect(alerts).toHaveLength(1);
  });

  it('alerts when inputs are highly similar even if some succeed', () => {
    const detector = new RetryDetector({ similarityThreshold: 0.8 });

    detector.recordToolCall(
      makeRecord({
        toolName: 'Edit',
        success: true,
        filePath: '/a/b.ts',
        command: 'fix bug line 10',
      }),
    );
    detector.recordToolCall(
      makeRecord({
        toolName: 'Edit',
        success: true,
        filePath: '/a/b.ts',
        command: 'fix bug line 11',
      }),
    );
    const result = detector.recordToolCall(
      makeRecord({
        toolName: 'Edit',
        success: true,
        filePath: '/a/b.ts',
        command: 'fix bug line 12',
      }),
    );

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

  it('estimates tokens wasted from only the repeats, not the whole group', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(
      makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }),
    );
    detector.recordToolCall(
      makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }),
    );
    const alert = detector.recordToolCall(
      makeRecord({ toolName: 'Bash', success: false, inputSizeBytes: 400, outputSizeBytes: 600 }),
    );

    expect(alert).not.toBeNull();
    // The first call is necessary work, not waste — only the 2 repeats are
    // charged: 2 calls × (400 + 600) bytes / 4 bytes per token = 500.
    expect(alert!.tokensWastedEstimate).toBe(500);
  });

  it('does not re-fire for the exact same offending call group when an unrelated call arrives', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    expect(detector.getMetrics().totalAlertsEmitted).toBe(1);

    // A call to a different tool shifts the window but leaves the same 3
    // Bash calls as the offending group — this must not re-count them.
    detector.recordToolCall(makeRecord({ toolName: 'Read', success: true }));
    expect(detector.getMetrics().totalAlertsEmitted).toBe(1);
  });

  it('fires again once a genuinely new occurrence joins the offending group', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    expect(detector.getMetrics().totalAlertsEmitted).toBe(1);

    // A 4th failing Bash call is genuinely new information, worth its own alert.
    detector.recordToolCall(makeRecord({ toolName: 'Bash', success: false }));
    expect(detector.getMetrics().totalAlertsEmitted).toBe(2);
  });

  it('does not flag genuinely different calls of a tool with no metadata extractor', () => {
    // A tool outside extractInputMeta()'s switch (e.g. PowerShell, WebFetch,
    // a third-party MCP tool) carries no tool-specific fields, so every call
    // used to serialize identically regardless of how different the real
    // inputs were.
    const detector = new RetryDetector();

    detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'aaaa1111bbbb2222' }),
    );
    detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'cccc3333dddd4444' }),
    );
    const result = detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'eeee5555ffff6666' }),
    );

    expect(result).toBeNull();
    expect(detector.getMetrics().totalAlertsEmitted).toBe(0);
  });

  it('does not flag distinct PowerShell calls whose shared session metadata dominates the serialized envelope', () => {
    // Reproduces a real false positive: every field below except
    // command/bashLeading/commandDescription/inputHash is identical across
    // all 4 calls, same as a real session's PowerShell calls sharing one
    // cwd/transcriptPath/permissionMode and near-constant classifier fields
    // from extractInputMeta().
    const detector = new RetryDetector();
    const constant = {
      toolName: 'PowerShell',
      success: true,
      cwd: 'C:\\Users\\dev\\preflight_test',
      transcriptPath:
        'C:\\Users\\dev\\.claude\\projects\\C--Users-dev-preflight-test\\d5be26f9-abcd.jsonl',
      permissionMode: 'auto',
      isTestCommand: false,
      isBuildCommand: false,
      isLintCommand: false,
      bashCategory: 'shell-other',
      bashDestructive: false,
      bashNetwork: false,
      commandTimeout: 600000,
    };
    const calls = [
      {
        command: 'Get-Date -Format o',
        bashLeading: 'Get-Date',
        commandDescription: 'Get current date/time',
        inputHash: 'a1b2c3d4e5f60718',
      },
      {
        command: '$PSVersionTable.PSVersion.ToString()',
        bashLeading: '$PSVersionTable.PSVersion.ToString',
        commandDescription: 'Get PowerShell version',
        inputHash: 'b2c3d4e5f6071829',
      },
      {
        command: '(Get-ChildItem -Path $PWD -File | Measure-Object).Count',
        bashLeading: 'Get-ChildItem',
        commandDescription: 'Count files in cwd',
        inputHash: 'c3d4e5f60718293a',
      },
      {
        command: '[System.Environment]::OSVersion.VersionString',
        bashLeading: '[System.Environment]::OSVersion.VersionString',
        commandDescription: 'Get OS version',
        inputHash: 'd4e5f60718293a4b',
      },
    ];

    let result = null;
    for (const call of calls) {
      result = detector.recordToolCall(makeRecord({ ...constant, ...call }));
    }

    expect(result).toBeNull();
    expect(detector.getMetrics().totalAlertsEmitted).toBe(0);
  });

  it('does not conflate two different sessions running the same command once cwd/transcriptPath are stripped', () => {
    const detector = new RetryDetector();
    const sessionA = {
      sessionId: 'session-a',
      cwd: '/Users/dev/repo-a',
      transcriptPath: '/tmp/a.jsonl',
    };
    const sessionB = {
      sessionId: 'session-b',
      cwd: '/Users/dev/repo-b',
      transcriptPath: '/tmp/b.jsonl',
    };

    detector.recordToolCall(
      makeRecord({ ...sessionA, toolName: 'Bash', command: 'npm test', success: true }),
    );
    detector.recordToolCall(
      makeRecord({ ...sessionB, toolName: 'Bash', command: 'npm test', success: true }),
    );
    const result = detector.recordToolCall(
      makeRecord({ ...sessionA, toolName: 'Bash', command: 'npm test', success: true }),
    );

    // Only 2 of these 3 calls belong to session-a — below minOccurrences (3)
    // once correctly scoped per session, even though all 3 share toolName
    // and identical command text with cwd/transcriptPath now stripped.
    expect(result).toBeNull();
    expect(detector.getMetrics().totalAlertsEmitted).toBe(0);
  });

  it('still detects genuine identical retries of a tool with no metadata extractor', () => {
    const detector = new RetryDetector();

    detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'aaaa1111bbbb2222' }),
    );
    detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'aaaa1111bbbb2222' }),
    );
    const result = detector.recordToolCall(
      makeRecord({ toolName: 'WebFetch', success: true, inputHash: 'aaaa1111bbbb2222' }),
    );

    expect(result).not.toBeNull();
    expect(result!.similarity).toBe(1);
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

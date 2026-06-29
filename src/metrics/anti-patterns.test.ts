import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AntiPatternDetector } from './anti-patterns.js';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Thrashing detection
// ---------------------------------------------------------------------------

describe('Thrashing detection', () => {
  it('detects Edit→test FAIL cycle repeated 3 times', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];

    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');

    expect(thrashing).toHaveLength(1);
    expect(thrashing[0].file).toBe('/a.ts');
    expect(thrashing[0].iterations).toBe(3);
  });

  it('does not detect when test passes', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }),
    ];

    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');
    expect(thrashing).toHaveLength(0);
  });

  it('resets cycle count after a passing test', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      // 2 fail cycles
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      // Pass resets count
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }),
      // 2 more fail cycles (below threshold of 3)
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];

    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');
    expect(thrashing).toHaveLength(0);
  });

  it('detects thrashing on flaky tests after pass without intermediate edits', () => {
    // Sequence: edit /a, test fail, test pass, test fail, test fail
    // With threshold=2, should detect after 2 consecutive fails (even after a pass)
    const detector = new AntiPatternDetector({ thrashThreshold: 2 });

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }), // Resets count
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }), // Restarts count (no Edit in between)
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }), // Count reaches 2, threshold met
    ];

    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');

    expect(thrashing).toHaveLength(1);
    expect(thrashing[0].file).toBe('/a.ts');
    expect(thrashing[0].iterations).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Re-reading detection
// ---------------------------------------------------------------------------

describe('Re-reading detection', () => {
  it('detects reading same file >3 times', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/c.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const reReading = result.patterns.filter((p) => p.type === 're_reading');

    expect(reReading).toHaveLength(1);
    expect(reReading[0].file).toBe('/a.ts');
    expect(reReading[0].readCount).toBe(4);
  });

  it('detects when file read exactly at threshold (3 times) (B-04)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const reReading = result.patterns.filter((p) => p.type === 're_reading');
    expect(reReading).toHaveLength(1);
    expect(reReading[0].readCount).toBe(3);
  });

  it('does not detect when file read fewer times than threshold (2 times)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const reReading = result.patterns.filter((p) => p.type === 're_reading');
    expect(reReading).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stuck loop detection
// ---------------------------------------------------------------------------

describe('Stuck loop detection', () => {
  it('detects same Bash command run 4 times consecutively', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');

    expect(stuck).toHaveLength(1);
    expect(stuck[0].command).toBe('npm test');
    expect(stuck[0].repeatCount).toBe(4);
  });

  it('does not detect when different commands interleave', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm run build' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck).toHaveLength(0);
  });

  it('non-Bash tool call is transparent — Bash(cmd)×2 → Read → Bash(cmd)×2 still fires', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck).toHaveLength(1);
    expect(stuck[0].command).toBe('npm test');
    expect(stuck[0].repeatCount).toBe(4);
  });

  it('attaches bashCategory to the stuck_loop pattern', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = Array.from({ length: 4 }, () =>
      makeRecord({
        toolName: 'Bash',
        command: 'npm test',
        bashCategory: 'test-runner',
      }),
    );

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck).toHaveLength(1);
    expect(stuck[0].bashCategory).toBe('test-runner');
  });

  it('uses category-specific suggestion when bashCategory is test-runner', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = Array.from({ length: 4 }, () =>
      makeRecord({
        toolName: 'Bash',
        command: 'npm test',
        bashCategory: 'test-runner',
      }),
    );

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck[0].suggestion).toMatch(/test/i);
    expect(stuck[0].suggestion).not.toMatch(/^The same command/);
  });

  it('uses category-specific suggestion for git stuck loops', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = Array.from({ length: 4 }, () =>
      makeRecord({
        toolName: 'Bash',
        command: 'git status',
        bashCategory: 'git',
      }),
    );

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck[0].suggestion).toMatch(/git/i);
  });

  it('falls back to generic suggestion when bashCategory is missing', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = Array.from({ length: 4 }, () =>
      makeRecord({ toolName: 'Bash', command: 'unknown-thing --flag' }),
    );

    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck[0].bashCategory).toBeUndefined();
    expect(stuck[0].suggestion).toBe(
      'The same command is being run repeatedly — try a different approach',
    );
  });
});

// ---------------------------------------------------------------------------
// Blind editing detection
// ---------------------------------------------------------------------------

describe('Blind editing detection', () => {
  it('detects 4 edits to same file without verification', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');

    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe('/a.ts');
    expect(blind[0].editCount).toBe(4);
  });

  it('detects exactly at threshold (3 edits) without verification (B-04)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');
    expect(blind).toHaveLength(1);
    expect(blind[0].editCount).toBe(3);
  });

  it('does not detect when verification happens between edits', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');
    expect(blind).toHaveLength(0);
  });

  it('build commands also count as verification', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isBuildCommand: true }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');
    // Each streak is 2 edits — below threshold of 3
    expect(blind).toHaveLength(0);
  });

  it('lint commands also count as verification', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isLintCommand: true }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');
    // First streak is 2 edits — below threshold of 3; lint resets it
    expect(blind).toHaveLength(0);
  });

  it('Read resets streak for the specific file only', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');

    // /a.ts: 2 edits (below threshold), then Read resets, then 1 edit → not flagged
    // /b.ts: 4 edits without verification → flagged
    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe('/b.ts');
  });

  it('passing test clears edit streaks but preserves already-flagged patterns', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }),
      // After passing test, streaks are reset — new edits start from 0
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');

    // /b.ts was flagged (4 edits >= threshold) before the test — preserved
    // /a.ts had 2 edits (below threshold) before test, then 2 after reset — not flagged
    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe('/b.ts');
  });

  it('Read after flagged blind edit preserves the detection', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      // 5 edits to /a.ts — flagged as blind editing
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      // Reading /a.ts resets the streak but should NOT erase the detection
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');

    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe('/a.ts');
    expect(blind[0].editCount).toBe(5);
  });

  it('failing test does NOT clear streaks', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];

    const result = detector.analyze(calls);
    const blind = result.patterns.filter((p) => p.type === 'blind_editing');

    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe('/a.ts');
  });
});

// ---------------------------------------------------------------------------
// Over-delegation detection
// ---------------------------------------------------------------------------

describe('Over-delegation detection', () => {
  it('detects 5 Agent calls', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [];
    for (let i = 0; i < 5; i++) {
      calls.push(makeRecord({ toolName: 'Agent', agentDescription: `task-${i}` }));
    }

    const result = detector.analyze(calls);
    const overDelegation = result.patterns.filter((p) => p.type === 'over_delegation');

    expect(overDelegation).toHaveLength(1);
    expect(overDelegation[0].agentCount).toBe(5);
  });

  it('detects exactly 3 Agent calls (at threshold, >= comparison)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [];
    for (let i = 0; i < 3; i++) {
      calls.push(makeRecord({ toolName: 'Agent' }));
    }

    const result = detector.analyze(calls);
    const overDelegation = result.patterns.filter((p) => p.type === 'over_delegation');
    expect(overDelegation).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// threshold boundary tests (threshold-1 / threshold / threshold+1)
// ---------------------------------------------------------------------------

describe('threshold boundary tests', () => {
  // ---- Thrashing ----

  it('thrashing: 2 cycles (threshold-1=2) does NOT fire', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];
    const result = detector.analyze(calls);
    expect(result.patterns.filter((p) => p.type === 'thrashing')).toHaveLength(0);
  });

  it('thrashing: 4 cycles (threshold+1=4) fires with iterations=4', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];
    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');
    expect(thrashing).toHaveLength(1);
    expect(thrashing[0].iterations).toBe(4);
  });

  it('thrashing: alternating edits to different files (2 cycles each) does NOT fire for either file', () => {
    const detector = new AntiPatternDetector();
    // Each file accumulates only 2 cycles; neither reaches the threshold of 3
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];
    const result = detector.analyze(calls);
    expect(result.patterns.filter((p) => p.type === 'thrashing')).toHaveLength(0);
  });

  // ---- Stuck loop ----

  it('stuck_loop: exactly 3 consecutive (at threshold) fires with repeatCount=3', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];
    const result = detector.analyze(calls);
    const stuck = result.patterns.filter((p) => p.type === 'stuck_loop');
    expect(stuck).toHaveLength(1);
    expect(stuck[0].repeatCount).toBe(3);
  });

  it('stuck_loop: 2 consecutive (threshold-1) does NOT fire', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
      makeRecord({ toolName: 'Bash', command: 'npm test' }),
    ];
    const result = detector.analyze(calls);
    expect(result.patterns.filter((p) => p.type === 'stuck_loop')).toHaveLength(0);
  });

  // ---- Blind editing ----

  it('blind_editing: 2 edits without verification (threshold-1) does NOT fire', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
    ];
    const result = detector.analyze(calls);
    expect(result.patterns.filter((p) => p.type === 'blind_editing')).toHaveLength(0);
  });

  // ---- Over-delegation ----

  it('over_delegation: 4 agents (first count that fires, since threshold is >3) fires with agentCount=4', () => {
    const detector = new AntiPatternDetector();
    const calls: ToolCallRecord[] = [];
    for (let i = 0; i < 4; i++) {
      calls.push(makeRecord({ toolName: 'Agent', agentDescription: `task-${i}` }));
    }
    const result = detector.analyze(calls);
    const over = result.patterns.filter((p) => p.type === 'over_delegation');
    expect(over).toHaveLength(1);
    expect(over[0].agentCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Efficiency metrics
// ---------------------------------------------------------------------------

describe('Efficiency metrics', () => {
  it('readEfficiency: 15 Read calls on 5 unique files -> 0.33', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [];
    const files = ['/a.ts', '/b.ts', '/c.ts', '/d.ts', '/e.ts'];
    for (let i = 0; i < 15; i++) {
      calls.push(makeRecord({ toolName: 'Read', filePath: files[i % 5] }));
    }

    const result = detector.analyze(calls);
    expect(result.readEfficiency).toBeCloseTo(0.33, 2);
  });

  it('readEfficiency is null when no Read calls', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [makeRecord({ toolName: 'Edit', filePath: '/a.ts' })];

    const result = detector.analyze(calls);
    expect(result.readEfficiency).toBeNull();
  });

  it('readEfficiency: 5 unique reads of 5 different files -> 1.0 (perfect)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/c.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/d.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/e.ts' }),
    ];

    const result = detector.analyze(calls);
    expect(result.readEfficiency).toBe(1.0);
  });

  it('readEfficiency: 5 reads of same file -> 0.2 (inefficient)', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result = detector.analyze(calls);
    expect(result.readEfficiency).toBe(0.2);
  });

  it('verifyRate: 8 edits, 3 followed by test -> 0.375', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      // 3 edits followed by test → 3 verified
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/c.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true }),
      // 5 more edits not followed by verification
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/c.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/d.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/e.ts' }),
    ];

    const result = detector.analyze(calls);
    expect(result.verifyRate).toBe(0.375); // 3/8
  });

  it('verifyRate is null when no edits', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [makeRecord({ toolName: 'Read', filePath: '/a.ts' })];

    const result = detector.analyze(calls);
    expect(result.verifyRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emitMetrics
// ---------------------------------------------------------------------------

describe('emitMetrics()', () => {
  it('records ai.anti_pattern.count with type attribute', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [];
    // Trigger over-delegation (5 agents)
    for (let i = 0; i < 5; i++) {
      calls.push(makeRecord({ toolName: 'Agent' }));
    }

    const result = detector.analyze(calls);

    const recorded: Array<{ name: string; value: number; attrs: Record<string, string | number> }> =
      [];
    const aggregator = {
      record(name: string, value: number, attrs: Record<string, string | number> = {}) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as import('../shared/index.js').MetricAggregator;

    detector.emitMetrics(aggregator, result.patterns);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].name).toBe('ai.anti_pattern.count');
    expect(recorded[0].value).toBe(1);
    expect(recorded[0].attrs.type).toBe('over_delegation');
  });
});

// ---------------------------------------------------------------------------
// Configurable thresholds
// ---------------------------------------------------------------------------

describe('Configurable thresholds', () => {
  it('lower threshold detects patterns sooner', () => {
    const detector = new AntiPatternDetector({
      thrashThreshold: 2,
      reReadThreshold: 2,
      stuckLoopThreshold: 2,
      blindEditThreshold: 2,
      overDelegationThreshold: 2,
    });

    // 2 thrash cycles — below default of 3 but at custom threshold of 2
    const calls: ToolCallRecord[] = [
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
    ];

    const result = detector.analyze(calls);
    const thrashing = result.patterns.filter((p) => p.type === 'thrashing');
    expect(thrashing).toHaveLength(1);
    expect(thrashing[0].iterations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('empty tool call array returns no patterns', () => {
    const detector = new AntiPatternDetector();

    const result = detector.analyze([]);

    expect(result.patterns).toHaveLength(0);
    expect(result.readEfficiency).toBeNull();
    expect(result.verifyRate).toBeNull();
  });

  it('multiple pattern types detected simultaneously', () => {
    const detector = new AntiPatternDetector();

    const calls: ToolCallRecord[] = [
      // Re-reading (4 reads of same file)
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      // Blind editing (4 edits without verification)
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      makeRecord({ toolName: 'Edit', filePath: '/b.ts' }),
      // Over-delegation (4 agents)
      makeRecord({ toolName: 'Agent' }),
      makeRecord({ toolName: 'Agent' }),
      makeRecord({ toolName: 'Agent' }),
      makeRecord({ toolName: 'Agent' }),
    ];

    const result = detector.analyze(calls);
    const types = result.patterns.map((p) => p.type);

    expect(types).toContain('re_reading');
    expect(types).toContain('blind_editing');
    expect(types).toContain('over_delegation');
  });

  it('getCurrentPatterns returns empty array before analyze is called', () => {
    const detector = new AntiPatternDetector();

    const patterns = detector.getCurrentPatterns();
    expect(patterns).toEqual([]);
  });

  it('getCurrentPatterns returns patterns from most recent analyze call', () => {
    const detector = new AntiPatternDetector();

    const calls1: ToolCallRecord[] = [
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
      makeRecord({ toolName: 'Read', filePath: '/a.ts' }),
    ];

    const result1 = detector.analyze(calls1);
    const patterns1 = detector.getCurrentPatterns();
    expect(patterns1).toEqual(result1.patterns);
    expect(patterns1.some((p) => p.type === 're_reading')).toBe(true);

    const calls2: ToolCallRecord[] = [];

    const result2 = detector.analyze(calls2);
    const patterns2 = detector.getCurrentPatterns();
    expect(patterns2).toEqual(result2.patterns);
    expect(patterns2).toHaveLength(0); // Empty call list produces no patterns
  });
});

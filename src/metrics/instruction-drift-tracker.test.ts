import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallRecord } from '../storage/types.js';
import { InstructionDriftTracker, hashPrompt } from './instruction-drift-tracker.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `nr-instruction-drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeReadRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    toolName: 'Read',
    toolUseId: `tu-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    ...overrides,
  } as ToolCallRecord;
}

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

describe('InstructionDriftTracker.recordToolCall (content-based hashing)', () => {
  it('detects a real content change even when inputHash is unchanged', () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'v1 content');

    const tracker = new InstructionDriftTracker();
    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath, inputHash: 'same-arg-hash' }));
    const hashAfterV1 = tracker.promptHash;
    expect(hashAfterV1).not.toBeNull();

    writeFileSync(claudeMdPath, 'v2 content, materially different');
    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath, inputHash: 'same-arg-hash' }));
    const hashAfterV2 = tracker.promptHash;

    expect(hashAfterV2).not.toBe(hashAfterV1);
  });

  it('does not report a change when content is unchanged, even if inputHash differs', () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'stable content');

    const tracker = new InstructionDriftTracker();
    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath, inputHash: 'hash-offset-0' }));
    const firstHash = tracker.promptHash;

    // Simulates re-reading the same unchanged file at a different offset/limit —
    // inputHash would differ under the old (buggy) args-based hashing.
    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath, inputHash: 'hash-offset-50' }));
    const secondHash = tracker.promptHash;

    expect(secondHash).toBe(firstHash);
  });

  it('does not throw and leaves promptHash unchanged when the file is unreadable', () => {
    const tracker = new InstructionDriftTracker();
    const missingPath = join(tmpDir, 'CLAUDE.md'); // never created — does not exist on disk

    expect(() => tracker.recordToolCall(makeReadRecord({ filePath: missingPath }))).not.toThrow();
    expect(tracker.promptHash).toBeNull();
  });

  it('preserves a previously-set promptHash when a later read fails', () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'known-good content');

    const tracker = new InstructionDriftTracker();
    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath }));
    const establishedHash = tracker.promptHash;
    expect(establishedHash).not.toBeNull();

    const missingPath = join(tmpDir, 'now-deleted-CLAUDE.md'); // never created

    expect(() => tracker.recordToolCall(makeReadRecord({ filePath: missingPath }))).not.toThrow();
    expect(tracker.promptHash).toBe(establishedHash);
  });

  it('ignores Read calls on files outside CLAUDE.md/.claude/', () => {
    const otherPath = join(tmpDir, 'some-source-file.ts');
    writeFileSync(otherPath, 'export const x = 1;');

    const tracker = new InstructionDriftTracker();
    tracker.recordToolCall(makeReadRecord({ filePath: otherPath }));

    expect(tracker.promptHash).toBeNull();
  });
});

describe('InstructionDriftTracker — configurable instruction file paths', () => {
  it('hashes a platform-specific instruction file when configured', () => {
    const cursorRulesPath = join(tmpDir, '.cursorrules');
    writeFileSync(cursorRulesPath, 'be terse');
    const tracker = new InstructionDriftTracker({ instructionFilePaths: ['.cursorrules'] });

    tracker.recordToolCall(makeReadRecord({ filePath: cursorRulesPath }));

    expect(tracker.promptHash).not.toBeNull();
  });

  it('still hashes CLAUDE.md even when a platform-specific path is configured', () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'be terse');
    const tracker = new InstructionDriftTracker({ instructionFilePaths: ['.cursorrules'] });

    tracker.recordToolCall(makeReadRecord({ filePath: claudeMdPath }));

    expect(tracker.promptHash).not.toBeNull();
  });
});

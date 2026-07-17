import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import { WeeklySummaryGenerator, getIsoWeekId, getWeekDateRange } from './weekly-summary.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(tmpdir(), `nr-weekly-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
  mkdirSync(resolve(tmpDir, 'weekly_summaries'), { recursive: true });
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}-${Math.random().toString(36).slice(2)}`,
    sessionName: null,
    repoName: null,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    model: 'claude-sonnet-4-20250514',
    toolBreakdown: { Read: 5, Edit: 3, Bash: 2 },
    filesRead: ['/src/index.ts'],
    filesModified: ['/src/index.ts'],
    linesAdded: 20,
    linesRemoved: 0,
    bashCommandCount: 2,
    testRunCount: 2,
    testPassCount: 2,
    buildRunCount: 1,
    buildPassCount: 1,
    estimatedCostUsd: 0.05,
    tokensInput: 5000,
    tokensOutput: 2000,
    tokensThinking: 1000,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: 0.75,
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: 1,
    toolSuccessRate: 1,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

// null-proto accumulator tests
describe('aggregateSessions prototype-pollution resistance', () => {
  it('handles __proto__ and constructor keys in toolBreakdown without pollution', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    const { start } = getWeekDateRange('2026-W16');
    store.saveSession(
      makeSummary({
        sessionId: 'proto-sess',
        startTime: start.getTime() + 1000,
        // keys that would shadow Object.prototype on a regular {} accumulator
        toolBreakdown: { __proto__: 1, constructor: 2, Read: 5 } as unknown as Record<
          string,
          number
        >,
      }),
    );

    const summary = generator.generate('2026-W16');

    // Regular tool key survives in the aggregated output
    expect(summary.toolBreakdown['Read']).toBe(5);
    // Object.prototype must be unmodified — no pollution of enumerable properties
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe('getWeekDateRange() nonexistent-week validation', () => {
  it('throws for "2025-W53" (2025 has no 53rd ISO week)', () => {
    expect(() => getWeekDateRange('2025-W53')).toThrow(/no such ISO week/);
  });

  it('throws for "2024-W53" and "2027-W53" (also no 53rd week)', () => {
    expect(() => getWeekDateRange('2024-W53')).toThrow(/no such ISO week/);
    expect(() => getWeekDateRange('2027-W53')).toThrow(/no such ISO week/);
  });

  it('does not throw for "2026-W53" (a genuine 53rd ISO week)', () => {
    expect(() => getWeekDateRange('2026-W53')).not.toThrow();
  });

  it('does not throw for ordinary weeks', () => {
    expect(() => getWeekDateRange('2026-W01')).not.toThrow();
    expect(() => getWeekDateRange('2026-W52')).not.toThrow();
  });
});

describe('WeeklySummaryGenerator', () => {
  it('generate() aggregates 5 sessions into correct weekly totals', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    // Use a known ISO week: 2026-W16 = Mon 2026-04-13 to Sun 2026-04-19
    const { start } = getWeekDateRange('2026-W16');
    const baseTime = start.getTime();

    for (let i = 0; i < 5; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `s${i}`,
          startTime: baseTime + i * 3_600_000, // spread across the week
          estimatedCostUsd: 0.1,
          toolCallCount: 10,
          taskCount: 2,
          testRunCount: 3,
          testPassCount: 2,
          efficiencyScore: 0.8,
          toolBreakdown: { Read: 4, Edit: 3, Bash: 3 },
          antiPatterns: [{ type: 'thrashing', count: 1 }],
        }),
      );
    }

    const summary = generator.generate('2026-W16');

    expect(summary.week).toBe('2026-W16');
    expect(summary.sessionCount).toBe(5);
    expect(summary.totalCostUsd).toBe(0.5);
    expect(summary.avgCostPerSession).toBe(0.1);
    expect(summary.avgEfficiencyScore).toBe(0.8);
    expect(summary.totalToolCalls).toBe(50);
    expect(summary.toolBreakdown).toEqual({ Read: 20, Edit: 15, Bash: 15 });
    expect(summary.totalTasksCompleted).toBe(10);
    // 10 passed / 15 run = 0.667
    expect(summary.taskSuccessRate).toBeCloseTo(0.667, 2);
    expect(summary.antiPatternCounts).toEqual({ thrashing: 5 });
  });

  it('per-developer breakdown correctly partitions metrics', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    const { start } = getWeekDateRange('2026-W16');
    const baseTime = start.getTime();

    // Alice: 2 sessions
    store.saveSession(
      makeSummary({
        sessionId: 'alice-1',
        developer: 'alice',
        startTime: baseTime + 1000,
        estimatedCostUsd: 0.1,
        toolCallCount: 8,
        taskCount: 1,
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'alice-2',
        developer: 'alice',
        startTime: baseTime + 2000,
        estimatedCostUsd: 0.2,
        toolCallCount: 12,
        taskCount: 2,
      }),
    );

    // Bob: 1 session
    store.saveSession(
      makeSummary({
        sessionId: 'bob-1',
        developer: 'bob',
        startTime: baseTime + 3000,
        estimatedCostUsd: 0.15,
        toolCallCount: 6,
        taskCount: 1,
      }),
    );

    const summary = generator.generate('2026-W16');

    expect(summary.developers).toEqual(['alice', 'bob']);
    expect(summary.sessionCount).toBe(3);

    const alice = summary.perDeveloper['alice']!;
    expect(alice.sessionCount).toBe(2);
    expect(alice.totalCostUsd).toBe(0.3);
    expect(alice.totalToolCalls).toBe(20);
    expect(alice.totalTasksCompleted).toBe(3);

    const bob = summary.perDeveloper['bob']!;
    expect(bob.sessionCount).toBe(1);
    expect(bob.totalCostUsd).toBe(0.15);
    expect(bob.totalToolCalls).toBe(6);
    expect(bob.totalTasksCompleted).toBe(1);
  });

  // defense-in-depth validation in generate()
  it('generate() throws for path-traversal weekId', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    expect(() => generator.generate('../../../etc/passwd')).toThrow(/Invalid weekId format/);
  });

  it('generate() throws for arbitrary string weekId', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    expect(() => generator.generate('not-a-week')).toThrow(/Invalid weekId format/);
  });

  it('generate() accepts valid YYYY-Wnn weekId', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const { start } = getWeekDateRange('2026-W16');
    store.saveSession(makeSummary({ sessionId: 'n03-sess', startTime: start.getTime() + 1000 }));
    expect(() => generator.generate('2026-W16')).not.toThrow();
  });

  it('generate() leaves no stray .tmp file behind after a successful write', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const { start } = getWeekDateRange('2026-W16');
    store.saveSession(makeSummary({ sessionId: 'n04-sess', startTime: start.getTime() + 1000 }));

    generator.generate('2026-W16');

    const summariesDir = join(tmpDir, 'weekly_summaries');
    const leftovers = readdirSync(summariesDir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('generate() called twice for the same week fully replaces the file (no corruption)', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const { start } = getWeekDateRange('2026-W16');

    store.saveSession(makeSummary({ sessionId: 'n05-a', startTime: start.getTime() + 1000 }));
    const first = generator.generate('2026-W16');
    expect(first.sessionCount).toBe(1);

    store.saveSession(makeSummary({ sessionId: 'n05-b', startTime: start.getTime() + 2000 }));
    const second = generator.generate('2026-W16');
    expect(second.sessionCount).toBe(2);

    const filepath = join(tmpDir, 'weekly_summaries', '2026-W16.json');
    const onDisk = JSON.parse(readFileSync(filepath, 'utf-8')) as { sessionCount: number };
    expect(onDisk.sessionCount).toBe(2);
  });

  it('auto-generation: generates last week summary if missing', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    // Save a session in last week's range
    const lastWeekDate = new Date();
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekId = getIsoWeekId(lastWeekDate);
    const { start } = getWeekDateRange(lastWeekId);

    store.saveSession(
      makeSummary({
        sessionId: 'last-week-sess',
        startTime: start.getTime() + 3_600_000,
      }),
    );

    const result = generator.checkAndGenerateLastWeek();

    expect(result).not.toBeNull();
    expect(result!.week).toBe(lastWeekId);
    expect(result!.sessionCount).toBe(1);
  });

  it('auto-generation: skips if summary already exists', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    const lastWeekDate = new Date();
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekId = getIsoWeekId(lastWeekDate);

    // Pre-create the summary file
    const filepath = join(tmpDir, 'weekly_summaries', `${lastWeekId}.json`);
    writeFileSync(filepath, JSON.stringify({ week: lastWeekId }) + '\n');

    const result = generator.checkAndGenerateLastWeek();
    expect(result).toBeNull();
  });

  it('getLatest() returns the most recent weekly summary', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    // Create summaries for W15 and W16
    for (const weekId of ['2026-W15', '2026-W16']) {
      const { start } = getWeekDateRange(weekId);
      store.saveSession(
        makeSummary({
          sessionId: `sess-${weekId}`,
          startTime: start.getTime() + 1000,
        }),
      );
      generator.generate(weekId);
    }

    const latest = generator.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.week).toBe('2026-W16');
  });

  it('getLatest() falls back to the next-most-recent valid summary when the latest file is corrupt', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    const { start } = getWeekDateRange('2026-W15');
    store.saveSession(makeSummary({ sessionId: 'valid-w15', startTime: start.getTime() + 1000 }));
    generator.generate('2026-W15');

    // W16 is lexicographically later but corrupt — simulates a crash-truncated write.
    const corruptPath = join(tmpDir, 'weekly_summaries', '2026-W16.json');
    writeFileSync(corruptPath, '{"week": "2026-W16", "sessionCount":');

    const latest = generator.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.week).toBe('2026-W15');
  });

  it('getLatest() returns null when every summary file is corrupt', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });

    writeFileSync(join(tmpDir, 'weekly_summaries', '2026-W16.json'), 'NOT VALID JSON');

    expect(generator.getLatest()).toBeNull();
  });

  it('generate() returns the in-memory summary (not a throw) when the disk write fails', () => {
    if (process.getuid?.() === 0) return; // root bypasses permission checks

    const store = new SessionStore({ storagePath: tmpDir });
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const { start } = getWeekDateRange('2026-W16');
    store.saveSession(
      makeSummary({ sessionId: 'write-fail-sess', startTime: start.getTime() + 1000 }),
    );

    const summariesDir = join(tmpDir, 'weekly_summaries');
    // Read-only directory: writeFileSync(tmpFilepath) can't create the new
    // tmp file inside it, forcing generate()'s write-failure fallback path.
    chmodSync(summariesDir, 0o500);

    try {
      const summary = generator.generate('2026-W16');

      expect(summary.week).toBe('2026-W16');
      expect(summary.sessionCount).toBe(1);

      const leftovers = readdirSync(summariesDir).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);

      const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(
        logged.some(
          (l: string) => l.includes('"error"') && l.includes('Failed to write weekly summary'),
        ),
      ).toBe(true);
    } finally {
      chmodSync(summariesDir, 0o700);
    }
  });
});

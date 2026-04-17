import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, buildSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
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
    sessionId: `sess-${now}`,
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
    testRunCount: 1,
    testPassCount: 1,
    buildRunCount: 1,
    buildPassCount: 1,
    estimatedCostUsd: 0.05,
    tokensInput: 5000,
    tokensOutput: 2000,
    tokensThinking: 1000,
    efficiencyScore: 0.75,
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: 1,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  it('saveSession writes JSON file with YYYY-MM-DD_sessionId.json naming', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const summary = makeSummary({
      sessionId: 'abc-123',
      startTime: new Date('2026-04-15T10:00:00Z').getTime(),
    });

    store.saveSession(summary);

    const files = readdirSync(resolve(tmpDir, 'sessions'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('2026-04-15_abc-123.json');
  });

  it('loadSession reads and parses a saved session', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const summary = makeSummary({ sessionId: 'load-test' });

    store.saveSession(summary);
    const loaded = store.loadSession('load-test');

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('load-test');
    expect(loaded!.developer).toBe('alice');
    expect(loaded!.model).toBe('claude-sonnet-4-20250514');
  });

  it('loadSession returns null for non-existent session', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    const loaded = store.loadSession('does-not-exist');
    expect(loaded).toBeNull();
  });

  it('listSessions filters by date range', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({
      sessionId: 'old',
      startTime: new Date('2026-04-01T10:00:00Z').getTime(),
    }));
    store.saveSession(makeSummary({
      sessionId: 'recent',
      startTime: new Date('2026-04-15T10:00:00Z').getTime(),
    }));

    const results = store.listSessions({ since: new Date('2026-04-10') });
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('recent');
  });

  it('listSessions filters by developer name', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 'alice-sess', developer: 'alice' }));
    store.saveSession(makeSummary({ sessionId: 'bob-sess', developer: 'bob' }));

    const results = store.listSessions({ developer: 'alice' });
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('alice-sess');
  });

  it('loadAllSessions returns all matching sessions', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 's1', startTime: Date.now() - 3000 }));
    store.saveSession(makeSummary({ sessionId: 's2', startTime: Date.now() - 1000 }));
    store.saveSession(makeSummary({ sessionId: 's3', startTime: Date.now() - 2000 }));

    const all = store.loadAllSessions();
    expect(all).toHaveLength(3);
    expect(all.map(s => s.sessionId)).toEqual(['s1', 's3', 's2']);
  });

  it('session file naming follows YYYY-MM-DD_sessionId.json pattern', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({
      sessionId: 'pattern-test',
      startTime: new Date('2026-01-15T12:00:00Z').getTime(),
    }));

    const files = readdirSync(resolve(tmpDir, 'sessions'));
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_pattern-test\.json$/);
  });
});

// ---------------------------------------------------------------------------
// buildSessionSummary
// ---------------------------------------------------------------------------

describe('buildSessionSummary', () => {
  it('pulls metrics from all trackers correctly', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 120_000,
        toolCallCount: 15,
        toolCallCountByTool: { Read: 5, Edit: 7, Bash: 3 },
        toolDurationMsByTool: {},
        toolSuccessRate: 0.9,
        toolSuccessRateByTool: {},
        toolErrorCount: 1,
        toolErrorsByType: {},
        uniqueFilesRead: 3,
        uniqueFilesWritten: 2,
        bashCommandsRun: 3,
        bashExitCodes: {},
        searchQueries: 0,
        toolCallTimeline: [],
      }),
    };

    const mockCostTracker = {
      getMetrics: () => ({
        sessionTotalCostUsd: 0.12,
        costByTask: null,
        costPerLineOfCode: null,
        costPerFileModified: null,
        model: 'claude-opus-4-20250514',
        totalInputTokens: 10_000,
        totalOutputTokens: 5_000,
        totalThinkingTokens: 2_000,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        reportCount: 3,
        estimationCount: 0,
        latestCostBreakdown: null,
      }),
    };

    const mockTaskDetector = {
      getMetrics: () => ({
        totalTasksCompleted: 2,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: 60_000,
        averageToolCallsPerTask: 7.5,
        completedTasks: [
          {
            taskId: 't1',
            startTime: 1700000000000,
            endTime: 1700000060000,
            durationMs: 60_000,
            toolCallCount: 8,
            toolCallsByType: { Read: 3, Edit: 4, Bash: 1 },
            filesRead: ['/src/a.ts', '/src/b.ts'],
            filesModified: ['/src/a.ts'],
            linesChanged: 25,
            bashCommandsRun: 1,
            testsRun: 1,
            testsPassed: 1,
            buildRun: 1,
            buildPassed: 1,
            estimatedCostUsd: 0.06,
            tokensUsed: 8_000,
            askedUserQuestions: 0,
            subAgentsSpawned: 1,
            toolCalls: [],
          },
          {
            taskId: 't2',
            startTime: 1700000060000,
            endTime: 1700000120000,
            durationMs: 60_000,
            toolCallCount: 7,
            toolCallsByType: { Read: 2, Edit: 3, Bash: 2 },
            filesRead: ['/src/b.ts', '/src/c.ts'],
            filesModified: ['/src/b.ts'],
            linesChanged: 15,
            bashCommandsRun: 2,
            testsRun: 2,
            testsPassed: 1,
            buildRun: 0,
            buildPassed: 0,
            estimatedCostUsd: 0.06,
            tokensUsed: 9_000,
            askedUserQuestions: 0,
            subAgentsSpawned: 0,
            toolCalls: [],
          },
        ],
      }),
    };

    const mockEfficiencyScorer = {
      getSessionAverage: () => ({
        score: 0.82,
        components: { speed: 0.7, correctness: 0.9, autonomy: 1, firstAttemptQuality: 0.7 },
        taskId: 'session-average',
        timestamp: Date.now(),
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as any,
      costTracker: mockCostTracker as any,
      taskDetector: mockTaskDetector as any,
      efficiencyScorer: mockEfficiencyScorer as any,
      developer: 'alice',
    });

    expect(summary.sessionId).toBe('test-session');
    expect(summary.developer).toBe('alice');
    expect(summary.model).toBe('claude-opus-4-20250514');
    expect(summary.toolCallCount).toBe(15);
    expect(summary.toolBreakdown).toEqual({ Read: 5, Edit: 7, Bash: 3 });
    expect(summary.filesRead).toEqual(['/src/a.ts', '/src/b.ts', '/src/c.ts']);
    expect(summary.filesModified).toEqual(['/src/a.ts', '/src/b.ts']);
    expect(summary.linesAdded).toBe(40); // 25 + 15
    expect(summary.bashCommandCount).toBe(3);
    expect(summary.testRunCount).toBe(3); // 1 + 2
    expect(summary.testPassCount).toBe(2); // 1 + 1
    expect(summary.buildRunCount).toBe(1); // 1 + 0
    expect(summary.buildPassCount).toBe(1); // 1 + 0
    expect(summary.estimatedCostUsd).toBe(0.12);
    expect(summary.tokensInput).toBe(10_000);
    expect(summary.tokensOutput).toBe(5_000);
    expect(summary.tokensThinking).toBe(2_000);
    expect(summary.efficiencyScore).toBe(0.82);
    expect(summary.taskCount).toBe(2);
    expect(summary.agentSpawns).toBe(1);
    expect(summary.outcome).toBe('completed');
  });

  it('handles missing optional trackers gracefully', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'minimal-session',
        sessionStartTime: Date.now() - 30_000,
        sessionDurationMs: 30_000,
        toolCallCount: 3,
        toolCallCountByTool: { Read: 2, Bash: 1 },
        toolDurationMsByTool: {},
        toolSuccessRate: 1,
        toolSuccessRateByTool: {},
        toolErrorCount: 0,
        toolErrorsByType: {},
        uniqueFilesRead: 2,
        uniqueFilesWritten: 0,
        bashCommandsRun: 1,
        bashExitCodes: {},
        searchQueries: 0,
        toolCallTimeline: [],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as any,
      developer: 'bob',
    });

    expect(summary.sessionId).toBe('minimal-session');
    expect(summary.developer).toBe('bob');
    expect(summary.model).toBeNull();
    expect(summary.estimatedCostUsd).toBeNull();
    expect(summary.tokensInput).toBe(0);
    expect(summary.tokensOutput).toBe(0);
    expect(summary.tokensThinking).toBe(0);
    expect(summary.efficiencyScore).toBeNull();
    expect(summary.taskCount).toBe(0);
    expect(summary.taskSuccessRate).toBe(1);
    expect(summary.antiPatterns).toEqual([]);
    expect(summary.filesRead).toEqual([]);
    expect(summary.filesModified).toEqual([]);
  });
});

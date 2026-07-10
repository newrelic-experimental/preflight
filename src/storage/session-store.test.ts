import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionStore,
  buildSessionSummary,
  deserializeFullSessionSummary,
  sessionSummaryToDriftRecord,
} from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import type { CostMetrics } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import type { SessionOutcomeRecord } from '../metrics/instruction-drift-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(
    tmpdir(),
    `nr-session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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
    sessionName: 'my-project',
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
    testRunCount: 1,
    testPassCount: 1,
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

describe('instructionPromptHash field', () => {
  it('buildSessionSummary sets instructionPromptHash from sources', () => {
    const sessionTracker = {
      getMetrics: () => ({
        sessionId: 'sess-1',
        sessionName: null,
        sessionStartTime: Date.now(),
        toolCallCount: 0,
        toolCallCountByTool: {},
        bashCommandsRun: 0,
        toolSuccessRate: null,
      }),
    } as unknown as SessionTracker;

    const summary = buildSessionSummary({
      sessionTracker,
      developer: 'dev1',
      instructionPromptHash: 'hash-abc',
    });

    expect(summary.instructionPromptHash).toBe('hash-abc');
  });

  it('buildSessionSummary defaults instructionPromptHash to null when not provided', () => {
    const sessionTracker = {
      getMetrics: () => ({
        sessionId: 'sess-2',
        sessionName: null,
        sessionStartTime: Date.now(),
        toolCallCount: 0,
        toolCallCountByTool: {},
        bashCommandsRun: 0,
        toolSuccessRate: null,
      }),
    } as unknown as SessionTracker;

    const summary = buildSessionSummary({ sessionTracker, developer: 'dev1' });

    expect(summary.instructionPromptHash).toBeNull();
  });

  it('deserializeFullSessionSummary round-trips instructionPromptHash', () => {
    const summary = makeSummary({ instructionPromptHash: 'hash-xyz' });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(summary)) as Record<string, unknown>,
    );
    expect(roundTripped.instructionPromptHash).toBe('hash-xyz');
  });

  it('deserializeFullSessionSummary defaults instructionPromptHash to null when field is missing (pre-fix session files)', () => {
    const summary = makeSummary();
    const raw = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    delete raw.instructionPromptHash;
    const roundTripped = deserializeFullSessionSummary(raw);
    expect(roundTripped.instructionPromptHash).toBeNull();
  });
});

describe('sessionSummaryToDriftRecord', () => {
  it('returns null when instructionPromptHash is null', () => {
    const summary = makeSummary({ instructionPromptHash: null });
    expect(sessionSummaryToDriftRecord(summary)).toBeNull();
  });

  it('maps a summary with a prompt hash into a SessionOutcomeRecord', () => {
    const summary = makeSummary({
      sessionId: 'sess-3',
      instructionPromptHash: 'hash-123',
      endTime: 1_700_000_000_000,
      taskSuccessRate: 0.8,
      tokensInput: 1000,
      tokensOutput: 500,
      taskCount: 4,
      efficiencyScore: 0.9,
      antiPatterns: [{ type: 'thrashing', count: 3 }],
    });

    const record = sessionSummaryToDriftRecord(summary) as SessionOutcomeRecord;

    expect(record).not.toBeNull();
    expect(record.sessionId).toBe('sess-3');
    expect(record.promptHash).toBe('hash-123');
    expect(record.timestamp).toBe(1_700_000_000_000);
    expect(record.successRate).toBe(0.8);
    expect(record.totalTokens).toBe(1500);
    expect(record.thrashingIncidents).toBe(3);
    expect(record.taskCount).toBe(4);
    expect(record.avgEfficiency).toBe(0.9);
  });

  it('defaults thrashingIncidents to 0 when no thrashing anti-pattern is present', () => {
    const summary = makeSummary({
      instructionPromptHash: 'hash-456',
      antiPatterns: [{ type: 're_reading', count: 2 }],
    });

    const record = sessionSummaryToDriftRecord(summary) as SessionOutcomeRecord;
    expect(record.thrashingIncidents).toBe(0);
  });
});

function makeSessionTracker(): SessionTracker {
  return {
    getMetrics: () => ({
      sessionId: 'test-session',
      sessionName: null,
      sessionStartTime: 1_700_000_000_000,
      sessionDurationMs: 0,
      toolCallCount: 0,
      toolCallCountByTool: {},
      toolDurationMsByTool: {},
      toolSuccessRate: 1,
      toolSuccessRateByTool: {},
      toolErrorCount: 0,
      toolErrorsByType: {},
      uniqueFilesRead: 0,
      uniqueFilesWritten: 0,
      bashCommandsRun: 0,
      bashExitCodes: {},
      searchQueries: 0,
      toolCallTimeline: [],
    }),
  } as unknown as SessionTracker;
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

  it('loadSession does not return a session whose ID is a prefix of the requested ID', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    store.saveSession(makeSummary({ sessionId: 'abc' }));

    // 'abcdef' shares 'abc' as a prefix — substring match would incorrectly return the 'abc' session
    const loaded = store.loadSession('abcdef');
    expect(loaded).toBeNull();
  });

  it('loadSession does not return a session whose ID contains the requested ID as a substring', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    store.saveSession(makeSummary({ sessionId: 'xabcx' }));

    const loaded = store.loadSession('abc');
    expect(loaded).toBeNull();
  });

  it('listSessions filters by date range', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(
      makeSummary({
        sessionId: 'old',
        startTime: new Date('2026-04-01T10:00:00Z').getTime(),
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'recent',
        startTime: new Date('2026-04-15T10:00:00Z').getTime(),
      }),
    );

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

  it('listSessions sorts same-day sessions deterministically by sessionId', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    // All three sessions share the same calendar date
    const sameDay = new Date('2026-04-15T10:00:00Z').getTime();
    store.saveSession(makeSummary({ sessionId: 'zzz-last', startTime: sameDay + 2000 }));
    store.saveSession(makeSummary({ sessionId: 'aaa-first', startTime: sameDay + 1000 }));
    store.saveSession(makeSummary({ sessionId: 'mmm-mid', startTime: sameDay }));

    const results = store.listSessions();
    const ids = results.map((r) => r.sessionId);
    expect(ids).toEqual(['aaa-first', 'mmm-mid', 'zzz-last']);

    // Second call must return the same order regardless of readdir ordering
    const results2 = store.listSessions();
    expect(results2.map((r) => r.sessionId)).toEqual(ids);
  });

  it('loadAllSessions returns all matching sessions', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 's1', startTime: Date.now() - 3000 }));
    store.saveSession(makeSummary({ sessionId: 's2', startTime: Date.now() - 1000 }));
    store.saveSession(makeSummary({ sessionId: 's3', startTime: Date.now() - 2000 }));

    const all = store.loadAllSessions();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.sessionId)).toEqual(['s1', 's3', 's2']);
  });

  it('saveSession rejects sessionId containing path traversal and writes no file', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: '../../etc/passwd' }));

    expect(readdirSync(resolve(tmpDir, 'sessions'))).toHaveLength(0);
  });

  it('saveSession rejects sessionId containing a forward slash', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 'a/b' }));

    expect(readdirSync(resolve(tmpDir, 'sessions'))).toHaveLength(0);
  });

  it('saveSession accepts a valid UUID-style sessionId', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }));

    const files = readdirSync(resolve(tmpDir, 'sessions'));
    expect(files).toHaveLength(1);
  });

  it('session file naming follows YYYY-MM-DD_sessionId.json pattern', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(
      makeSummary({
        sessionId: 'pattern-test',
        startTime: new Date('2026-01-15T12:00:00Z').getTime(),
      }),
    );

    const files = readdirSync(resolve(tmpDir, 'sessions'));
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_pattern-test\.json$/);
  });

  it('loadTodaySessions returns only sessions from today (local midnight)', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    // Use local midnight so the boundary is correct for any timezone
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    store.saveSession(
      makeSummary({
        sessionId: 'today-1',
        startTime: todayMs + 1000,
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'today-2',
        startTime: todayMs + 5000,
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'yesterday',
        startTime: todayMs - 86_400_000,
      }),
    );

    const sessions = store.loadTodaySessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(['today-1', 'today-2']);
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
      getCurrentTask: () => null,
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
            linesAdded: 20,
            linesRemoved: 5,
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
            linesAdded: 12,
            linesRemoved: 3,
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
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      costTracker: mockCostTracker as unknown as CostTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      efficiencyScorer: mockEfficiencyScorer as unknown as EfficiencyScorer,
      developer: 'alice',
    });

    expect(summary.sessionId).toBe('test-session');
    expect(summary.developer).toBe('alice');
    expect(summary.model).toBe('claude-opus-4-20250514');
    expect(summary.toolCallCount).toBe(15);
    expect(summary.toolBreakdown).toEqual({ Read: 5, Edit: 7, Bash: 3 });
    expect(summary.filesRead).toEqual(['/src/a.ts', '/src/b.ts', '/src/c.ts']);
    expect(summary.filesModified).toEqual(['/src/a.ts', '/src/b.ts']);
    expect(summary.linesAdded).toBe(32); // 20 + 12
    expect(summary.linesRemoved).toBe(8); // 5 + 3
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
    expect(summary.toolSuccessRate).toBe(0.9);
    expect(summary.outcome).toBe('completed');
  });

  it('includes active task data in the summary', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'active-task-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 60_000,
        toolCallCount: 5,
        toolCallCountByTool: { Read: 3, Edit: 2 },
        toolDurationMsByTool: {},
        toolSuccessRate: 1,
        toolSuccessRateByTool: {},
        toolErrorCount: 0,
        toolErrorsByType: {},
        uniqueFilesRead: 1,
        uniqueFilesWritten: 1,
        bashCommandsRun: 0,
        bashExitCodes: {},
        searchQueries: 0,
        toolCallTimeline: [],
      }),
    };

    const activeTask = {
      taskId: 'active-1',
      startTime: 1700000000000,
      endTime: 1700000060000,
      durationMs: 60_000,
      toolCallCount: 5,
      toolCallsByType: { Read: 3, Edit: 2 },
      filesRead: ['/src/active.ts'],
      filesModified: ['/src/active.ts'],
      linesChanged: 30,
      linesAdded: 25,
      linesRemoved: 5,
      bashCommandsRun: 0,
      testsRun: 2,
      testsPassed: 2,
      buildRun: 1,
      buildPassed: 1,
      estimatedCostUsd: 0.04,
      tokensUsed: 3000,
      askedUserQuestions: 0,
      subAgentsSpawned: 1,
      toolCalls: [],
    };

    const mockTaskDetector = {
      getMetrics: () => ({
        totalTasksCompleted: 0,
        currentTaskActive: true,
        currentTaskToolCalls: 5,
        averageTaskDurationMs: null,
        averageToolCallsPerTask: null,
        completedTasks: [],
      }),
      getCurrentTask: () => activeTask,
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      developer: 'alice',
    });

    expect(summary.filesRead).toEqual(['/src/active.ts']);
    expect(summary.filesModified).toEqual(['/src/active.ts']);
    expect(summary.linesAdded).toBe(25);
    expect(summary.linesRemoved).toBe(5);
    expect(summary.testRunCount).toBe(2);
    expect(summary.testPassCount).toBe(2);
    expect(summary.buildRunCount).toBe(1);
    expect(summary.buildPassCount).toBe(1);
    expect(summary.agentSpawns).toBe(1);
    expect(summary.taskCount).toBe(1);
  });

  it('includes cache token fields from CostTracker', () => {
    const sessionTracker = makeSessionTracker();
    const costTracker = new CostTracker();
    // recordTokenUsage with real cache tokens so fields are non-zero
    jest.spyOn(costTracker, 'getMetrics').mockReturnValue({
      sessionTotalCostUsd: 0.05,
      costByTask: null,
      costByModel: {},
      costPerLineOfCode: null,
      costPerFileModified: null,
      model: 'claude-sonnet-4-6',
      totalInputTokens: 3_000,
      totalOutputTokens: 1_000,
      totalThinkingTokens: 0,
      totalCacheReadTokens: 5_000,
      totalCacheCreationTokens: 1_500,
      cacheHitRate: 0.526,
      totalCacheSavingsUsd: 0.018,
      reportCount: 2,
      estimationCount: 0,
      latestCostBreakdown: null,
    } satisfies CostMetrics);
    const summary = buildSessionSummary({
      sessionTracker,
      costTracker,
      developer: 'dev',
    });
    expect(summary.tokensCacheRead).toBe(5_000);
    expect(summary.tokensCacheCreation).toBe(1_500);
    expect(summary.cacheSavingsUsd).toBe(0.018);
  });

  it('threads the platform field through when provided', () => {
    const summary = buildSessionSummary({
      sessionTracker: makeSessionTracker(),
      developer: 'dev',
      platform: 'cursor',
    });
    expect(summary.platform).toBe('cursor');
  });

  it('leaves platform undefined when not provided', () => {
    const summary = buildSessionSummary({
      sessionTracker: makeSessionTracker(),
      developer: 'dev',
    });
    expect(summary.platform).toBeUndefined();
  });

  it('deserializeFullSessionSummary round-trips cache fields', () => {
    const raw = {
      sessionId: 'sess-abc',
      sessionName: null,
      repoName: null,
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 10,
      developer: 'dev',
      model: null,
      toolBreakdown: {},
      filesRead: [],
      filesModified: [],
      linesAdded: 0,
      linesRemoved: 0,
      bashCommandCount: 0,
      testRunCount: 0,
      testPassCount: 0,
      buildRunCount: 0,
      buildPassCount: 0,
      estimatedCostUsd: null,
      tokensInput: 0,
      tokensOutput: 0,
      tokensThinking: 0,
      tokensCacheRead: 4_000,
      tokensCacheCreation: 800,
      cacheSavingsUsd: 0.009,
      efficiencyScore: null,
      antiPatterns: [],
      taskCount: 0,
      taskSuccessRate: null,
      toolSuccessRate: null,
      contextCompressions: 0,
      agentSpawns: 0,
      userMessages: 0,
      assistantMessages: 0,
      userCorrections: 0,
      outcome: 'unknown',
    };
    const result = deserializeFullSessionSummary(raw);
    expect(result.tokensCacheRead).toBe(4_000);
    expect(result.tokensCacheCreation).toBe(800);
    expect(result.cacheSavingsUsd).toBe(0.009);
  });

  it('deserializeFullSessionSummary defaults cache fields to 0 when missing', () => {
    const raw = {
      sessionId: 'sess-old',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.tokensCacheRead).toBe(0);
    expect(result.tokensCacheCreation).toBe(0);
    expect(result.cacheSavingsUsd).toBe(0);
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
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
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
    expect(summary.taskSuccessRate).toBeNull();
    expect(summary.antiPatterns).toEqual([]);
    expect(summary.filesRead).toEqual([]);
    expect(summary.filesModified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Corruption-recovery
// ---------------------------------------------------------------------------

describe('SessionStore corruption-recovery', () => {
  it('loadSession returns null and logs warning for malformed JSON', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    writeFileSync(join(sessionsDir, '2026-01-01_bad-json.json'), '{ invalid: json !!! }');

    const result = store.loadSession('bad-json');
    expect(result).toBeNull();

    const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged.some((l: string) => l.includes('"warn"') && l.includes('deserialize'))).toBe(
      true,
    );
  });

  it('loadSession returns null for an empty file', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    writeFileSync(join(sessionsDir, '2026-01-01_empty.json'), '');

    const result = store.loadSession('empty');
    expect(result).toBeNull();
  });

  it('loadSession returns null for a whitespace-only file', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    writeFileSync(join(sessionsDir, '2026-01-01_whitespace.json'), '   \n\t  ');

    const result = store.loadSession('whitespace');
    expect(result).toBeNull();
  });

  it('saveSession logs warning and does not throw on write permission error', () => {
    if (process.getuid?.() === 0) return; // root bypasses permission checks

    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    // Revoke write permission on the sessions directory
    chmodSync(sessionsDir, 0o555);

    try {
      expect(() => store.saveSession(makeSummary({ sessionId: 'perm-fail' }))).not.toThrow();

      const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(logged.some((l: string) => l.includes('"warn"') && l.includes('Failed to save'))).toBe(
        true,
      );
    } finally {
      // Restore permissions so afterEach cleanup can delete the directory
      chmodSync(sessionsDir, 0o700);
    }
  });

  it('two saveSession calls with the same sessionId result in last-write-wins', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const startTime = new Date('2026-03-01T00:00:00Z').getTime();

    store.saveSession(makeSummary({ sessionId: 'dup-id', developer: 'alice', startTime }));
    store.saveSession(makeSummary({ sessionId: 'dup-id', developer: 'bob', startTime }));

    const files = readdirSync(join(tmpDir, 'sessions'));
    expect(files).toHaveLength(1);

    const loaded = store.loadSession('dup-id');
    expect(loaded).not.toBeNull();
    expect(loaded!.developer).toBe('bob');
  });
});

// ---------------------------------------------------------------------------
// buildSessionSummary — timeline persistence
// ---------------------------------------------------------------------------

describe('buildSessionSummary timeline', () => {
  it('includes timeline from task tool calls', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'timeline-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 30_000,
        toolCallCount: 3,
        toolCallCountByTool: { Read: 1, Edit: 1, Bash: 1 },
        toolDurationMsByTool: {},
        toolSuccessRate: 1,
        toolSuccessRateByTool: {},
        toolErrorCount: 0,
        toolErrorsByType: {},
        uniqueFilesRead: 1,
        uniqueFilesWritten: 1,
        bashCommandsRun: 1,
        bashExitCodes: {},
        searchQueries: 0,
        toolCallTimeline: [],
      }),
    };

    const mockTaskDetector = {
      getCurrentTask: () => null,
      getMetrics: () => ({
        totalTasksCompleted: 1,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: 30_000,
        averageToolCallsPerTask: 3,
        completedTasks: [
          {
            taskId: 't1',
            startTime: 1700000000000,
            endTime: 1700000030000,
            durationMs: 30_000,
            toolCallCount: 3,
            toolCallsByType: { Read: 1, Edit: 1, Bash: 1 },
            filesRead: ['/src/index.ts'],
            filesModified: ['/src/index.ts'],
            linesChanged: 5,
            linesAdded: 5,
            linesRemoved: 0,
            bashCommandsRun: 1,
            testsRun: 1,
            testsPassed: 1,
            buildRun: 0,
            buildPassed: 0,
            estimatedCostUsd: 0.02,
            tokensUsed: 1000,
            askedUserQuestions: 0,
            subAgentsSpawned: 0,
            toolCalls: [
              {
                id: 'tc1',
                sessionId: 'timeline-session',
                toolName: 'Read',
                toolUseId: 'tu1',
                timestamp: 1700000001000,
                durationMs: 30,
                success: true,
                filePath: '/src/index.ts',
              },
              {
                id: 'tc2',
                sessionId: 'timeline-session',
                toolName: 'Edit',
                toolUseId: 'tu2',
                timestamp: 1700000010000,
                durationMs: 50,
                success: true,
                filePath: '/src/index.ts',
              },
              {
                id: 'tc3',
                sessionId: 'timeline-session',
                toolName: 'Bash',
                toolUseId: 'tu3',
                timestamp: 1700000020000,
                durationMs: 2000,
                success: true,
                command: 'npm test',
                isTestCommand: true,
              },
            ],
          },
        ],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      developer: 'alice',
    });

    expect(summary.timeline).toBeDefined();
    expect(summary.timeline).toHaveLength(3);
    expect(summary.timeline![0]!.toolName).toBe('Read');
    expect(summary.timeline![0]!.filePath).toBe('/src/index.ts');
    expect(summary.timeline![1]!.toolName).toBe('Edit');
    expect(summary.timeline![2]!.toolName).toBe('Bash');
    expect(summary.timeline![2]!.command).toBe('npm test');
    expect(summary.timeline![2]!.isTestCommand).toBe(true);
  });

  it('returns undefined timeline when no tool calls are present', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'empty-timeline',
        sessionStartTime: Date.now() - 30_000,
        sessionDurationMs: 30_000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: 1,
        toolSuccessRateByTool: {},
        toolErrorCount: 0,
        toolErrorsByType: {},
        uniqueFilesRead: 0,
        uniqueFilesWritten: 0,
        bashCommandsRun: 0,
        bashExitCodes: {},
        searchQueries: 0,
        toolCallTimeline: [],
      }),
    };

    const mockTaskDetector = {
      getCurrentTask: () => null,
      getMetrics: () => ({
        totalTasksCompleted: 0,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: null,
        averageToolCallsPerTask: null,
        completedTasks: [],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      developer: 'alice',
    });

    expect(summary.timeline).toBeUndefined();
  });

  it('deserialization handles sessions with and without timeline', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    // Session WITH timeline
    const withTimeline = {
      ...makeSummary({ sessionId: 'with-tl' }),
      timeline: [
        { timestamp: 1000, toolName: 'Read', durationMs: 30, success: true, filePath: '/a.ts' },
      ],
    };
    writeFileSync(
      join(sessionsDir, '2026-01-01_with-tl.json'),
      JSON.stringify(withTimeline) + '\n',
    );

    // Session WITHOUT timeline (legacy)
    const withoutTimeline = makeSummary({ sessionId: 'no-tl' });
    writeFileSync(
      join(sessionsDir, '2026-01-01_no-tl.json'),
      JSON.stringify(withoutTimeline) + '\n',
    );

    const loaded1 = store.loadSession('with-tl') as Record<string, unknown> | null;
    expect(loaded1).not.toBeNull();
    expect(Array.isArray(loaded1!['timeline'])).toBe(true);

    const loaded2 = store.loadSession('no-tl') as Record<string, unknown> | null;
    expect(loaded2).not.toBeNull();
    expect(loaded2!['timeline']).toBeUndefined();
  });
});

// deserializeSession — explicit field extraction
describe('SessionStore deserialization', () => {
  it('loads a session with prototype-shadowing toolBreakdown keys safely', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    const raw = JSON.stringify({
      sessionId: 'proto-test',
      startTime: 1000,
      endTime: 2000,
      durationMs: 1000,
      toolCallCount: 3,
      developer: 'alice',
      toolBreakdown: { __proto__: 1, constructor: 2, Read: 3 },
      antiPatterns: [],
      filesRead: [],
      filesModified: [],
    });
    writeFileSync(join(sessionsDir, '2026-01-01_proto-test.json'), raw + '\n');

    const session = store.loadSession('proto-test');
    expect(session).not.toBeNull();
    expect(session!.toolBreakdown['Read']).toBe(3);
    // Object.prototype must have no unexpected own enumerable properties from pollution
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('returns null for a session file with non-object JSON', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');
    writeFileSync(join(sessionsDir, '2026-01-01_bad-sess.json'), '"just a string"\n');

    const session = store.loadSession('bad-sess');
    expect(session).toBeNull();
  });

  it('applies defaults for missing optional fields', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const sessionsDir = join(tmpDir, 'sessions');

    const raw = JSON.stringify({
      sessionId: 'minimal',
      startTime: 1000,
      endTime: 2000,
      durationMs: 1000,
      toolCallCount: 0,
      developer: 'bob',
    });
    writeFileSync(join(sessionsDir, '2026-01-01_minimal.json'), raw + '\n');

    const session = store.loadSession('minimal');
    expect(session).not.toBeNull();
    expect(session!.toolCallCount).toBe(0);
    expect(session!.estimatedCostUsd).toBeNull();
    expect(session!.efficiencyScore).toBeNull();
    expect(session!.antiPatterns).toEqual([]);
    expect(session!.filesRead).toEqual([]);
    expect(session!.outcome).toBe('unknown');
  });
});

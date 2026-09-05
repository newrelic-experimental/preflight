import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionStore,
  buildSessionSummary,
  deserializeFullSessionSummary,
  mergeSummaries,
  sessionSummaryToDriftRecord,
} from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import type { CostMetrics } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import type { TranscriptMessageTracker } from '../metrics/transcript-message-tracker.js';
import type { SessionOutcomeRecord } from '../metrics/instruction-drift-tracker.js';
import { ToolSelectionScorer, toToolSelectionSummary } from '../metrics/tool-selection-scorer.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import { ZERO_QUALITY_PROXY_COUNTS } from '../metrics/quality-proxy-tracker.js';

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
    sessionNameSource: null,
    sessionIntent: null,
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
    subagentCostUsd: 0,
    tokensInput: 5000,
    tokensOutput: 2000,
    tokensThinking: 1000,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: 0.75,
    toolSelectionMetrics: null,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
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

  it('deserializeFullSessionSummary defaults instructionPromptHash to null when the field is missing', () => {
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
      antiPatterns: [
        { type: 'thrashing', file: 'a.ts' },
        { type: 'thrashing', file: 'b.ts' },
        { type: 'thrashing', file: 'c.ts' },
      ],
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
      antiPatterns: [{ type: 're_reading', file: 'x.ts' }],
    });

    const record = sessionSummaryToDriftRecord(summary) as SessionOutcomeRecord;
    expect(record.thrashingIncidents).toBe(0);
  });
});

describe('buildSessionSummary anti-patterns', () => {
  const mockSessionTracker = {
    getMetrics: () => ({
      sessionId: 'ap-session',
      sessionStartTime: 1_700_000_000_000,
      sessionDurationMs: 10_000,
      toolCallCount: 1,
      toolCallCountByTool: { Edit: 1 },
      toolDurationMsByTool: {},
      toolSuccessRate: 1,
      toolSuccessRateByTool: {},
      toolErrorCount: 0,
      toolErrorsByType: {},
      uniqueFilesRead: 0,
      uniqueFilesWritten: 1,
      bashCommandsRun: 0,
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
      averageTaskDurationMs: 10_000,
      averageToolCallsPerTask: 1,
      completedTasks: [
        {
          taskId: 't1',
          startTime: 1_700_000_000_000,
          endTime: 1_700_000_010_000,
          durationMs: 10_000,
          toolCallCount: 1,
          toolCallsByType: { Edit: 1 },
          filesRead: [],
          filesModified: ['/src/auth.ts'],
          linesChanged: 2,
          linesAdded: 2,
          linesRemoved: 0,
          bashCommandsRun: 0,
          testsRun: 0,
          testsPassed: 0,
          buildRun: 0,
          buildPassed: 0,
          estimatedCostUsd: 0.01,
          tokensUsed: 100,
          askedUserQuestions: 0,
          subAgentsSpawned: 0,
          toolCalls: [
            {
              id: 'tc1',
              sessionId: 'ap-session',
              toolName: 'Edit',
              toolUseId: 'tu1',
              timestamp: 1_700_000_001_000,
              durationMs: 20,
              success: true,
              filePath: '/src/auth.ts',
            },
          ],
        },
      ],
    }),
  };

  it('persists file and the real per-incident occurrence count', () => {
    const mockAntiPatternDetector = {
      analyze: () => ({
        readEfficiency: null,
        verifyRate: null,
        patterns: [
          {
            type: 'thrashing',
            file: '/src/auth.ts',
            iterations: 4,
            tokensWasted: 200,
            suggestion: 'Read the test failure output before editing again.',
          },
        ],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      antiPatternDetector: mockAntiPatternDetector as unknown as AntiPatternDetector,
      developer: 'alice',
    });

    expect(summary.antiPatterns).toEqual([
      { type: 'thrashing', file: '/src/auth.ts', iterations: 4 },
    ]);
  });

  it('keeps one row per incident when multiple incidents share a type', () => {
    const mockAntiPatternDetector = {
      analyze: () => ({
        readEfficiency: null,
        verifyRate: null,
        patterns: [
          {
            type: 'thrashing',
            file: '/src/auth.ts',
            iterations: 4,
            tokensWasted: 200,
            suggestion: 's1',
          },
          {
            type: 'thrashing',
            file: '/src/session.ts',
            iterations: 2,
            tokensWasted: 80,
            suggestion: 's2',
          },
        ],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      antiPatternDetector: mockAntiPatternDetector as unknown as AntiPatternDetector,
      developer: 'alice',
    });

    expect(summary.antiPatterns).toHaveLength(2);
    expect(summary.antiPatterns.map((p) => p.file)).toEqual(['/src/auth.ts', '/src/session.ts']);
  });

  it('round-trips file/iterations through JSON serialization', () => {
    const original = makeSummary({
      antiPatterns: [{ type: 're_reading', file: '/src/config.ts', readCount: 6 }],
    });
    const raw = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const roundTripped = deserializeFullSessionSummary(raw);

    expect(roundTripped.antiPatterns).toEqual([
      { type: 're_reading', file: '/src/config.ts', readCount: 6 },
    ]);
  });

  it('deserializes legacy {type, count} session files into `count` separate incidents of that type', () => {
    const raw = { sessionId: 'legacy-1', antiPatterns: [{ type: 'thrashing', count: 3 }] };
    const roundTripped = deserializeFullSessionSummary(raw);

    expect(roundTripped.antiPatterns).toEqual([
      { type: 'thrashing' },
      { type: 'thrashing' },
      { type: 'thrashing' },
    ]);
  });

  it('expands a legacy {type, count: 5} entry into 5 rows of that type, matching the historical aggregate', () => {
    const raw = { sessionId: 'legacy-2', antiPatterns: [{ type: 'thrashing', count: 5 }] };
    const roundTripped = deserializeFullSessionSummary(raw);

    expect(roundTripped.antiPatterns).toHaveLength(5);
    expect(roundTripped.antiPatterns.every((p) => p.type === 'thrashing')).toBe(true);
  });

  it('reads a modelBreakdown entry written before cache token fields existed with both cache counts at 0', () => {
    const raw = {
      sessionId: 'legacy-3',
      modelBreakdown: {
        'claude-sonnet-4-6': {
          requestCount: 4,
          totalInputTokens: 120,
          totalOutputTokens: 60,
          totalCostUsd: 0.3,
        },
      },
    };
    const roundTripped = deserializeFullSessionSummary(raw);

    expect(roundTripped.modelBreakdown).toEqual({
      'claude-sonnet-4-6': {
        requestCount: 4,
        totalInputTokens: 120,
        totalOutputTokens: 60,
        totalCostUsd: 0.3,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    });
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

  it('does not let an empty summary clobber a recorded session', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const startTime = new Date('2026-04-15T10:00:00Z').getTime();
    store.saveSession(makeSummary({ sessionId: 'clobber-me', startTime, toolCallCount: 12 }));

    // A short-lived process that adopted the same session id via the
    // session-by-cwd breadcrumb but saw no hook activity.
    store.saveSession(
      makeSummary({ sessionId: 'clobber-me', startTime, toolCallCount: 0, toolBreakdown: {} }),
    );

    expect(store.loadSession('clobber-me')!.toolCallCount).toBe(12);
  });

  it('still overwrites when the new summary has activity', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const startTime = new Date('2026-04-15T10:00:00Z').getTime();
    store.saveSession(makeSummary({ sessionId: 'grow', startTime, toolCallCount: 3 }));
    store.saveSession(makeSummary({ sessionId: 'grow', startTime, toolCallCount: 9 }));

    expect(store.loadSession('grow')!.toolCallCount).toBe(9);
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

  it('loadAllSessions excludes synthetic session IDs (local-/proxy-/pending- prefixes)', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(makeSummary({ sessionId: 'real-session-1', startTime: Date.now() - 3000 }));
    store.saveSession(makeSummary({ sessionId: 'local-1234567890', startTime: Date.now() - 2000 }));
    store.saveSession(makeSummary({ sessionId: 'proxy-9876543210', startTime: Date.now() - 1500 }));
    store.saveSession(
      makeSummary({ sessionId: 'pending-1111111111', startTime: Date.now() - 1000 }),
    );
    store.saveSession(makeSummary({ sessionId: 'real-session-2', startTime: Date.now() - 500 }));

    const all = store.loadAllSessions();
    expect(all.map((s) => s.sessionId).sort()).toEqual(['real-session-1', 'real-session-2']);
  });

  it('loadTodaySessions excludes synthetic session IDs', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const now = Date.now();

    store.saveSession(makeSummary({ sessionId: 'real-today', startTime: now - 1000 }));
    store.saveSession(makeSummary({ sessionId: 'local-today', startTime: now - 500 }));

    const sessions = store.loadTodaySessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['real-today']);
  });

  it('loadSessionsOverlappingToday excludes synthetic session IDs', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = today.getTime();

    // Started yesterday, ends after today's midnight — real overlapping session.
    store.saveSession(
      makeSummary({
        sessionId: 'real-overlap',
        startTime: startOfToday - 3_600_000,
        endTime: startOfToday + 3_600_000,
      }),
    );
    // Same overlap window, but a synthetic ID — must still be excluded.
    store.saveSession(
      makeSummary({
        sessionId: 'proxy-overlap',
        startTime: startOfToday - 3_600_000,
        endTime: startOfToday + 3_600_000,
      }),
    );

    const sessions = store.loadSessionsOverlappingToday();
    expect(sessions.map((s) => s.sessionId)).toEqual(['real-overlap']);
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

  it('loadSessionsOverlappingToday includes cross-midnight and endTime=0 sessions, excludes yesterday-only sessions', () => {
    const store = new SessionStore({ storagePath: tmpDir });

    // Use local midnight so the boundary is correct for any timezone
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = today.getTime();
    const startOfYesterday = startOfToday - 86_400_000;

    // Started and ended entirely yesterday — should be excluded.
    store.saveSession(
      makeSummary({
        sessionId: 'yesterday-only',
        startTime: startOfYesterday + 1000,
        endTime: startOfYesterday + 5000,
      }),
    );

    // Started yesterday evening, ended after today's local midnight — should
    // be included via the endTime-overlap filter.
    store.saveSession(
      makeSummary({
        sessionId: 'cross-midnight',
        startTime: startOfYesterday + 80_000_000,
        endTime: startOfToday + 1000,
      }),
    );

    // Legacy/crashed session written without an endTime field at all —
    // deserializes to endTime: 0 and should be included via the explicit
    // endTime === 0 carve-out. Written directly to disk to simulate a file
    // an older build produced (FullSessionSummary.endTime is required, so
    // saveSession() itself cannot omit it).
    const noEndTimeDate = today.toISOString().slice(0, 10);
    const { endTime: _unused, ...withoutEndTime } = makeSummary({
      sessionId: 'no-end-time',
      startTime: startOfToday + 2000,
    });
    writeFileSync(
      resolve(tmpDir, 'sessions', `${noEndTimeDate}_no-end-time.json`),
      JSON.stringify(withoutEndTime),
    );

    const sessions = store.loadSessionsOverlappingToday();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['cross-midnight', 'no-end-time']);
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
      getScores: () => [{}, {}],
      getSessionSampleCount: () => 2,
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
    expect(summary.efficiencyScoreSampleCount).toBe(2);
    expect(summary.efficiencyScoreComponents).toEqual({
      speed: 0.7,
      correctness: 0.9,
      autonomy: 1,
      firstAttemptQuality: 0.7,
    });
    expect(summary.taskCount).toBe(2);
    expect(summary.agentSpawns).toBe(1);
    expect(summary.toolSuccessRate).toBe(0.9);
    expect(summary.outcome).toBe('completed');
  });

  it('folds TaskMetrics.seededAggregate into filesRead/linesAdded/testRunCount/etc alongside completedTasks', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
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
    };

    const mockTaskDetector = {
      getCurrentTask: () => null,
      getMetrics: () => ({
        totalTasksCompleted: 3,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: null,
        averageToolCallsPerTask: null,
        completedTasks: [
          {
            taskId: 't1',
            startTime: 1700000000000,
            endTime: 1700000060000,
            durationMs: 60_000,
            toolCallCount: 2,
            toolCallsByType: {},
            filesRead: ['/live.ts'],
            filesModified: [],
            linesChanged: 4,
            linesAdded: 4,
            linesRemoved: 0,
            bashCommandsRun: 0,
            testsRun: 1,
            testsPassed: 1,
            buildRun: 0,
            buildPassed: 0,
            estimatedCostUsd: null,
            tokensUsed: 0,
            askedUserQuestions: 0,
            subAgentsSpawned: 0,
            toolCalls: [],
          },
        ],
        seededAggregate: {
          filesRead: ['/seeded-a.ts', '/live.ts'],
          filesModified: ['/seeded-a.ts'],
          linesAdded: 20,
          linesRemoved: 5,
          testsRun: 3,
          testsPassed: 2,
          buildRun: 1,
          buildPassed: 1,
          agentSpawns: 2,
        },
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['sessionTracker'],
      taskDetector: mockTaskDetector as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['taskDetector'],
      developer: 'alice',
    });

    expect(summary.filesRead.sort()).toEqual(['/live.ts', '/seeded-a.ts'].sort()); // deduped union
    expect(summary.filesModified).toEqual(['/seeded-a.ts']);
    expect(summary.linesAdded).toBe(24); // 4 live + 20 seeded
    expect(summary.linesRemoved).toBe(5);
    expect(summary.testRunCount).toBe(4); // 1 live + 3 seeded
    expect(summary.testPassCount).toBe(3);
    expect(summary.buildRunCount).toBe(1);
    expect(summary.buildPassCount).toBe(1);
    expect(summary.agentSpawns).toBe(2);
    expect(summary.taskCount).toBe(3); // from totalTasksCompleted, unaffected by this fold
  });

  it('reads userMessages/assistantMessages/userCorrections from transcriptMessageTracker', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 0,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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

    const mockTranscriptMessageTracker = {
      getMetrics: () => ({
        userMessages: 4,
        assistantMessages: 6,
        userCorrections: 1,
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      transcriptMessageTracker: mockTranscriptMessageTracker as unknown as TranscriptMessageTracker,
      developer: 'alice',
    });

    expect(summary.userMessages).toBe(4);
    expect(summary.assistantMessages).toBe(6);
    expect(summary.userCorrections).toBe(1);
  });

  it('defaults userMessages/assistantMessages/userCorrections to 0 when transcriptMessageTracker is absent', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 0,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });

    expect(summary.userMessages).toBe(0);
    expect(summary.assistantMessages).toBe(0);
    expect(summary.userCorrections).toBe(0);
  });

  it("persists the provided outcome (periodic checkpoints write 'in progress')", () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'live-session',
        sessionName: null,
        sessionStartTime: 1000,
        sessionDurationMs: 5000,
        sessionEndTime: 6000,
        toolCallCount: 3,
        toolCallCountByTool: { Read: 3 },
        uniqueFilesRead: 1,
        uniqueFilesWritten: 0,
        toolSuccessRate: 1,
        toolCallTimeline: [],
      }),
    };
    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
      outcome: 'in progress',
    });
    expect(summary.outcome).toBe('in progress');
  });

  it('redacts secret-shaped substrings in filesRead and filesModified', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'redact-test',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 1,
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
        totalTasksCompleted: 1,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: 0,
        averageToolCallsPerTask: 0,
        completedTasks: [
          {
            taskId: 't1',
            startTime: 1700000000000,
            endTime: 1700000060000,
            durationMs: 60_000,
            toolCallCount: 1,
            toolCallsByType: {},
            filesRead: ['/repo/config-API_KEY=abc123def456secretvalue.ts'],
            filesModified: ['/repo/README.md'],
            linesChanged: 0,
            linesAdded: 0,
            linesRemoved: 0,
            bashCommandsRun: 0,
            testsRun: 0,
            testsPassed: 0,
            buildRun: 0,
            buildPassed: 0,
            estimatedCostUsd: 0,
            tokensUsed: 0,
            askedUserQuestions: 0,
            subAgentsSpawned: 0,
            toolCalls: [],
          },
        ],
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      developer: 'alice',
    });

    expect(summary.filesRead).toEqual(['/repo/config-[REDACTED]']);
    expect(summary.filesRead[0]).not.toContain('abc123def456secretvalue');
    expect(summary.filesModified).toEqual(['/repo/README.md']);
  });

  it('redacts secret-shaped substrings in sessionName and repoName', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'redact-test-2',
        sessionName: 'API_KEY=abc123def456secretvalue',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
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

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
      repoName: 'API_KEY=abc123def456secretvalue',
    });

    expect(summary.sessionName).toBe('[REDACTED]');
    expect(summary.repoName).toBe('[REDACTED]');
  });

  it('leaves sessionName and repoName as null when not provided', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'redact-test-3',
        sessionName: null,
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
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

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });

    expect(summary.sessionName).toBeNull();
    expect(summary.repoName).toBeNull();
  });

  it('redacts secret-shaped substrings in sessionIntent (Phase 3)', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'redact-test-intent',
        sessionName: null,
        sessionNameSource: null,
        // Sensitive first-prompt content; only ever non-null when recordContent
        // was on. Persist must redact it (idempotently) before it hits disk.
        sessionIntent: 'deploy with API_KEY=abc123def456secretvalue please',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
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

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });

    expect(summary.sessionIntent).toBe('deploy with [REDACTED] please');
  });

  it('leaves sessionIntent null when not provided (recordContent off)', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'redact-test-intent-null',
        sessionName: null,
        sessionNameSource: null,
        sessionIntent: null,
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
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

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });

    expect(summary.sessionIntent).toBeNull();
  });

  it('deserializeFullSessionSummary round-trips sessionIntent and defaults it to null when missing', () => {
    const original = makeSummary({ sessionIntent: 'refactor the auth flow' });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(original)) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.sessionIntent).toBe('refactor the auth flow');

    // Pre-Phase-3 session files have no sessionIntent field → null, not undefined.
    const raw = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    delete raw.sessionIntent;
    expect(deserializeFullSessionSummary(raw).sessionIntent).toBeNull();
  });

  it('deserializeFullSessionSummary round-trips a valid sessionNameSource and rejects bogus/missing to null', () => {
    const original = makeSummary({ sessionName: 'my session', sessionNameSource: 'ai-title' });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(original)) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.sessionNameSource).toBe('ai-title');

    // A value outside the 4-way enum → null (defends against a corrupt/edited file).
    const bogus = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    bogus.sessionNameSource = 'nonsense';
    expect(deserializeFullSessionSummary(bogus).sessionNameSource).toBeNull();

    // Pre-feature session files have no field → null.
    const missing = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    delete missing.sessionNameSource;
    expect(deserializeFullSessionSummary(missing).sessionNameSource).toBeNull();
  });

  it('mergeSummaries keeps name and source together and never clobbers a captured intent', () => {
    const existing = makeSummary({
      sessionName: 'human named it',
      sessionNameSource: 'user',
      sessionIntent: 'the original prompt',
    });
    // A later (checkpoint) write that never resolved a name/intent this run:
    // both are null on `incoming`.
    const incoming = makeSummary({
      sessionName: null,
      sessionNameSource: null,
      sessionIntent: null,
    });
    const merged = mergeSummaries(existing, incoming);
    // Name kept — and its source must stay tied to it (no user→null desync).
    expect(merged.sessionName).toBe('human named it');
    expect(merged.sessionNameSource).toBe('user');
    // A previously-captured intent is preserved, not overwritten to null.
    expect(merged.sessionIntent).toBe('the original prompt');
  });

  it('mergeSummaries keeps a real platform label against an incoming generic-mcp checkpoint', () => {
    const existing = makeSummary({ platform: 'claude-code' });
    const incoming = makeSummary({ platform: 'generic-mcp' });
    const merged = mergeSummaries(existing, incoming);
    expect(merged.platform).toBe('claude-code');
  });

  it('mergeSummaries lets an incoming real platform upgrade an existing generic-mcp label', () => {
    const existing = makeSummary({ platform: 'generic-mcp' });
    const incoming = makeSummary({ platform: 'claude-code' });
    const merged = mergeSummaries(existing, incoming);
    expect(merged.platform).toBe('claude-code');
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
      costPerMillionTokens: null,
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
      subagentCostUsd: 0.021,
      parentCostUsd: 0.029,
      costByWorkflowRunId: {},
      costByDayUsd: {},
      subagentCostByDayUsd: {},
      costRateMultiplierApplied: 1,
    } satisfies CostMetrics);
    const summary = buildSessionSummary({
      sessionTracker,
      costTracker,
      developer: 'dev',
    });
    expect(summary.tokensCacheRead).toBe(5_000);
    expect(summary.tokensCacheCreation).toBe(1_500);
    expect(summary.cacheSavingsUsd).toBe(0.018);
    expect(summary.subagentCostUsd).toBe(0.021);
  });

  it('includes costByWorkflowRunId from CostTracker', () => {
    const sessionTracker = makeSessionTracker();
    const costTracker = new CostTracker();
    jest.spyOn(costTracker, 'getMetrics').mockReturnValue({
      sessionTotalCostUsd: 0.05,
      costByTask: null,
      costByModel: {},
      costPerLineOfCode: null,
      costPerFileModified: null,
      costPerMillionTokens: null,
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
      subagentCostUsd: 0.021,
      parentCostUsd: 0.029,
      costByWorkflowRunId: { wf_test_run: { '2026-08-14': 0.05 } },
      costByDayUsd: { '2026-08-14': 0.05 },
      subagentCostByDayUsd: {},
      costRateMultiplierApplied: 1,
    } satisfies CostMetrics);
    const summary = buildSessionSummary({
      sessionTracker,
      costTracker,
      developer: 'dev',
    });
    expect(summary.costByWorkflowRunId).toEqual({ wf_test_run: { '2026-08-14': 0.05 } });
  });

  it('defaults costByWorkflowRunId to {} when no CostTracker is provided', () => {
    const summary = buildSessionSummary({
      sessionTracker: makeSessionTracker(),
      developer: 'dev',
    });
    expect(summary.costByWorkflowRunId).toEqual({});
  });

  it('defaults subagentCostUsd to 0 when no CostTracker is provided', () => {
    const summary = buildSessionSummary({
      sessionTracker: makeSessionTracker(),
      developer: 'dev',
    });
    expect(summary.subagentCostUsd).toBe(0);
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

  it('deserializeFullSessionSummary round-trips subagentCostUsd', () => {
    const raw = {
      sessionId: 'sess-subagent',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      subagentCostUsd: 0.0345,
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.subagentCostUsd).toBe(0.0345);
  });

  it('deserializeFullSessionSummary defaults subagentCostUsd to 0 when the field is missing', () => {
    const raw = {
      sessionId: 'sess-old',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.subagentCostUsd).toBe(0);
  });

  it('deserializeFullSessionSummary round-trips costByWorkflowRunId', () => {
    const raw = {
      sessionId: 'sess-wf',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      costByWorkflowRunId: { wf_abc: { '2026-08-14': 0.5, '2026-08-15': 1.25 } },
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByWorkflowRunId).toEqual({
      wf_abc: { '2026-08-14': 0.5, '2026-08-15': 1.25 },
    });
  });

  it('deserializeFullSessionSummary defaults costByWorkflowRunId to {} when the field is missing', () => {
    const raw = {
      sessionId: 'sess-old',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByWorkflowRunId).toEqual({});
  });

  it('deserializeFullSessionSummary round-trips costByDayUsd / subagentCostByDayUsd', () => {
    const raw = {
      sessionId: 'sess-day-buckets',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      costByDayUsd: { '2026-08-17': 245.0, '2026-08-18': 5.0 },
      subagentCostByDayUsd: { '2026-08-18': 1.5 },
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByDayUsd).toEqual({ '2026-08-17': 245.0, '2026-08-18': 5.0 });
    expect(result.subagentCostByDayUsd).toEqual({ '2026-08-18': 1.5 });
  });

  it('deserializeFullSessionSummary leaves day-bucket maps undefined when the fields are missing', () => {
    // Undefined (not {}) so the aggregate route can distinguish "old file, fall
    // back to timeline pro-rate" from "new file that genuinely spent $0 today".
    const raw = {
      sessionId: 'sess-old',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByDayUsd).toBeUndefined();
    expect(result.subagentCostByDayUsd).toBeUndefined();
  });

  it('deserializeFullSessionSummary drops non-numeric values inside the day-bucket maps', () => {
    const raw = {
      sessionId: 'sess-malformed-day',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      costByDayUsd: { '2026-08-18': 5.0, '2026-08-17': 'nope', bad: null },
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByDayUsd).toEqual({ '2026-08-18': 5.0 });
  });

  it('deserializeFullSessionSummary treats an array costByDayUsd as absent (undefined), not a {0:..} map', () => {
    // typeof [] === 'object'; without an Array guard a corrupt array would
    // become { '0': 5 } (defined) and wrongly take the day-bucket branch in the
    // aggregate route (reading $0 today) instead of falling back to pro-rating.
    const raw = {
      sessionId: 'sess-array-day',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      costByDayUsd: [5.0, 6.0],
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByDayUsd).toBeUndefined();
  });

  it('deserializeFullSessionSummary drops non-numeric values inside costByWorkflowRunId rather than throwing', () => {
    const raw = {
      sessionId: 'sess-malformed',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      durationMs: 3_600_000,
      toolCallCount: 5,
      developer: 'dev',
      costByWorkflowRunId: {
        wf_ok: { '2026-08-14': 0.5 },
        wf_bad_day: { '2026-08-14': 'not-a-number' },
        wf_not_an_object: 'not-an-object',
      },
    };
    const result = deserializeFullSessionSummary(raw as unknown as Record<string, unknown>);
    expect(result.costByWorkflowRunId).toEqual({ wf_ok: { '2026-08-14': 0.5 }, wf_bad_day: {} });
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

  it('computes toolSelectionMetrics from the full in-memory tool calls when a scorer is provided', () => {
    const toolCalls = [
      {
        id: 'c1',
        sessionId: 'test-session',
        toolName: 'Read',
        toolUseId: 'c1',
        timestamp: 1,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
      {
        id: 'c2',
        sessionId: 'test-session',
        toolName: 'Read',
        toolUseId: 'c2',
        timestamp: 2,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
      {
        id: 'c3',
        sessionId: 'test-session',
        toolName: 'Read',
        toolUseId: 'c3',
        timestamp: 3,
        durationMs: 5,
        success: true,
        filePath: '/f.ts',
      },
    ];
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 3,
        toolCallCountByTool: { Read: 3 },
        toolDurationMsByTool: {},
        toolSuccessRate: 1,
        toolSuccessRateByTool: {},
        toolErrorCount: 0,
        toolErrorsByType: {},
        uniqueFilesRead: 1,
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
        totalTasksCompleted: 1,
        currentTaskActive: false,
        currentTaskToolCalls: 0,
        averageTaskDurationMs: 1000,
        averageToolCallsPerTask: 3,
        completedTasks: [
          {
            taskId: 't1',
            startTime: 1,
            endTime: 3,
            durationMs: 2,
            toolCallCount: 3,
            toolCallsByType: { Read: 3 },
            filesRead: ['/f.ts'],
            filesModified: [],
            linesChanged: 0,
            linesAdded: 0,
            linesRemoved: 0,
            bashCommandsRun: 0,
            testsRun: 0,
            testsPassed: 0,
            buildRun: 0,
            buildPassed: 0,
            estimatedCostUsd: 0,
            tokensUsed: 0,
            askedUserQuestions: 0,
            subAgentsSpawned: 0,
            toolCalls,
          },
        ],
      }),
    };
    const scorer = new ToolSelectionScorer();

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      taskDetector: mockTaskDetector as unknown as TaskDetector,
      toolSelectionScorer: scorer,
      developer: 'alice',
    });

    expect(summary.toolSelectionMetrics).toEqual(
      toToolSelectionSummary(scorer.scoreSession(toolCalls)),
    );
    expect(summary.toolSelectionMetrics?.redundantReadCount).toBe(1);
  });

  it('leaves toolSelectionMetrics null when no scorer is provided', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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
    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });
    expect(summary.toolSelectionMetrics).toBeNull();
  });

  it('round-trips toolSelectionMetrics through JSON serialization', () => {
    const original = makeSummary({
      toolSelectionMetrics: {
        score: 0.91,
        totalCalls: 20,
        penalizedCalls: 2,
        redundantReadCount: 1,
        repeatedFailureCount: 0,
        unusedOutputCount: 1,
      },
    });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(original)) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.toolSelectionMetrics).toEqual(original.toolSelectionMetrics);
  });

  it('defaults toolSelectionMetrics to null for legacy session files missing the field', () => {
    const legacy = makeSummary();
    const { toolSelectionMetrics: _toolSelectionMetrics, ...withoutField } = legacy;
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(withoutField)) as Parameters<
        typeof deserializeFullSessionSummary
      >[0],
    );
    expect(roundTripped.toolSelectionMetrics).toBeNull();
  });

  it('captures efficiencyScoreSampleCount and efficiencyScoreComponents from EfficiencyScorer', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
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
    };
    const mockEfficiencyScorer = {
      getSessionAverage: () => ({
        score: 0.77,
        components: { speed: 0.8, correctness: 0.7, autonomy: 0.9, firstAttemptQuality: 0.6 },
        taskId: 'session-average',
        timestamp: Date.now(),
      }),
      getScores: () => [{}, {}, {}],
      getSessionSampleCount: () => 3, // what buildSessionSummary actually reads
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['sessionTracker'],
      efficiencyScorer: mockEfficiencyScorer as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['efficiencyScorer'],
      developer: 'alice',
    });

    expect(summary.efficiencyScore).toBe(0.77);
    expect(summary.efficiencyScoreSampleCount).toBe(3);
    expect(summary.efficiencyScoreComponents).toEqual({
      speed: 0.8,
      correctness: 0.7,
      autonomy: 0.9,
      firstAttemptQuality: 0.6,
    });
  });

  it('defaults efficiencyScoreSampleCount to 0 and efficiencyScoreComponents to null with no efficiencyScorer', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
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
    };
    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['sessionTracker'],
      developer: 'alice',
    });
    expect(summary.efficiencyScoreSampleCount).toBe(0);
    expect(summary.efficiencyScoreComponents).toBeNull();
  });

  it('persists efficiencyScoreSampleCount from getSessionSampleCount(), not the fresh-only getScores().length, so seeded weight from an earlier restart survives a second checkpoint', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
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
    };
    // Simulates a session on its second restart: only 1 fresh task has been
    // scored since the last restart, but getSessionAverage() (and therefore
    // this checkpoint's efficiencyScore) is already weighted by 4 seeded
    // samples carried over from the prior process's own checkpoint. If
    // buildSessionSummary persisted getScores().length here instead of
    // getSessionSampleCount(), it would record sampleCount=1 alongside a
    // score that actually reflects 5 samples' worth of history.
    const mockEfficiencyScorer = {
      getSessionAverage: () => ({
        score: 0.81,
        components: { speed: 0.75, correctness: 0.85, autonomy: 0.9, firstAttemptQuality: 0.75 },
        taskId: 'session-average',
        timestamp: Date.now(),
      }),
      getScores: () => [{}], // 1 fresh score this process
      getSessionSampleCount: () => 5, // 1 fresh + 4 seeded from a prior restart
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['sessionTracker'],
      efficiencyScorer: mockEfficiencyScorer as unknown as Parameters<
        typeof buildSessionSummary
      >[0]['efficiencyScorer'],
      developer: 'alice',
    });

    expect(summary.efficiencyScoreSampleCount).toBe(5);
    expect(summary.efficiencyScoreSampleCount).not.toBe(mockEfficiencyScorer.getScores().length);
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

  it('merges two saveSession calls with the same sessionId into one file, keeping the latest scalar fields', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const startTime = new Date('2026-03-01T00:00:00Z').getTime();

    store.saveSession(makeSummary({ sessionId: 'dup-id', developer: 'alice', startTime }));
    store.saveSession(makeSummary({ sessionId: 'dup-id', developer: 'bob', startTime }));

    const files = readdirSync(join(tmpDir, 'sessions'));
    expect(files).toHaveLength(1);

    const loaded = store.loadSession('dup-id');
    expect(loaded).not.toBeNull();
    // Scalar identity fields still follow the later write; only recorded
    // activity is protected from regression (see the cross-process merge
    // tests below).
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

describe('modelBreakdown field', () => {
  it('buildSessionSummary populates modelBreakdown from modelUsageTracker.getRawBreakdown()', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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
    const modelUsageTracker = {
      getRawBreakdown: () => ({
        'claude-sonnet-5': {
          requestCount: 3,
          totalInputTokens: 900,
          totalOutputTokens: 400,
          totalCostUsd: 0.12,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalThinkingTokens: 0,
        },
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      modelUsageTracker: modelUsageTracker as unknown as ModelUsageTracker,
      developer: 'alice',
    });

    expect(summary.modelBreakdown).toEqual({
      'claude-sonnet-5': {
        requestCount: 3,
        totalInputTokens: 900,
        totalOutputTokens: 400,
        totalCostUsd: 0.12,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    });
  });

  it('defaults modelBreakdown to {} when no modelUsageTracker is provided', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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
    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });
    expect(summary.modelBreakdown).toEqual({});
  });

  it('round-trips modelBreakdown through JSON serialization', () => {
    const original = makeSummary({
      modelBreakdown: {
        'claude-sonnet-5': {
          requestCount: 3,
          totalInputTokens: 900,
          totalOutputTokens: 400,
          totalCostUsd: 0.12,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalThinkingTokens: 0,
        },
      },
    });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(original)) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.modelBreakdown).toEqual(original.modelBreakdown);
  });

  it('defaults modelBreakdown to {} for legacy session files missing the field', () => {
    const legacy = makeSummary();
    const { modelBreakdown: _modelBreakdown, ...withoutField } = legacy;
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(withoutField)) as Parameters<
        typeof deserializeFullSessionSummary
      >[0],
    );
    expect(roundTripped.modelBreakdown).toEqual({});
  });

  it('drops malformed entries (missing numeric fields) rather than throwing', () => {
    const raw = JSON.stringify({
      ...makeSummary(),
      modelBreakdown: {
        'good-model': {
          requestCount: 1,
          totalInputTokens: 10,
          totalOutputTokens: 10,
          totalCostUsd: 0.1,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalThinkingTokens: 0,
        },
        'bad-model': { requestCount: 1 },
      },
    });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(raw) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.modelBreakdown).toEqual({
      'good-model': {
        requestCount: 1,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0.1,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    });
  });
});

describe('qualityProxy field', () => {
  it('buildSessionSummary populates qualityProxy from qualityProxyTracker.getRawCounts()', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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
    const qualityProxyTracker = {
      getRawCounts: () => ({
        totalSignals: 4,
        diffApplyCleanCount: 2,
        diffFailCount: 1,
        testPassCount: 1,
        testFailCount: 0,
        backtrackCount: 0,
        selfCorrectionCount: 0,
      }),
    };

    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      qualityProxyTracker: qualityProxyTracker as unknown as QualityProxyTracker,
      developer: 'alice',
    });

    expect(summary.qualityProxy).toEqual({
      totalSignals: 4,
      diffApplyCleanCount: 2,
      diffFailCount: 1,
      testPassCount: 1,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
  });

  it('defaults qualityProxy to all-zero counts when no qualityProxyTracker is provided', () => {
    const mockSessionTracker = {
      getMetrics: () => ({
        sessionId: 'test-session',
        sessionStartTime: 1700000000000,
        sessionDurationMs: 1000,
        toolCallCount: 0,
        toolCallCountByTool: {},
        toolDurationMsByTool: {},
        toolSuccessRate: null,
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
    const summary = buildSessionSummary({
      sessionTracker: mockSessionTracker as unknown as SessionTracker,
      developer: 'alice',
    });
    expect(summary.qualityProxy).toEqual(ZERO_QUALITY_PROXY_COUNTS);
  });

  it('round-trips qualityProxy through JSON serialization', () => {
    const original = makeSummary({
      qualityProxy: {
        totalSignals: 4,
        diffApplyCleanCount: 2,
        diffFailCount: 1,
        testPassCount: 1,
        testFailCount: 0,
        backtrackCount: 0,
        selfCorrectionCount: 0,
      },
    });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(original)) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.qualityProxy).toEqual(original.qualityProxy);
  });

  it('defaults qualityProxy to all-zero counts for legacy session files missing the field', () => {
    const legacy = makeSummary();
    const { qualityProxy: _qualityProxy, ...withoutField } = legacy;
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(JSON.stringify(withoutField)) as Parameters<
        typeof deserializeFullSessionSummary
      >[0],
    );
    expect(roundTripped.qualityProxy).toEqual(ZERO_QUALITY_PROXY_COUNTS);
  });

  it('defaults qualityProxy to all-zero counts when a field is malformed (missing a numeric key)', () => {
    const raw = JSON.stringify({
      ...makeSummary(),
      qualityProxy: { totalSignals: 4 }, // missing the other required numeric fields
    });
    const roundTripped = deserializeFullSessionSummary(
      JSON.parse(raw) as Parameters<typeof deserializeFullSessionSummary>[0],
    );
    expect(roundTripped.qualityProxy).toEqual(ZERO_QUALITY_PROXY_COUNTS);
  });
});

describe('saveSession cross-process merge', () => {
  it('does not let a thinner writer erase a richer view of the same session', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const rich = makeSummary({
      sessionId: 'd0f6fceb-ecc5-4610-9c62-3b2c10415137',
      toolCallCount: 7,
      toolBreakdown: { Bash: 7 },
      model: 'claude-sonnet-4-6',
      tokensInput: 292,
      tokensOutput: 533,
      estimatedCostUsd: 0.008871,
      modelBreakdown: {
        'claude-sonnet-4-6': {
          requestCount: 1,
          totalInputTokens: 292,
          totalOutputTokens: 533,
          totalCostUsd: 0.008871,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalThinkingTokens: 0,
        },
      },
    });
    store.saveSession(rich);

    // The MCP engine spawned by the same CLI session writes its own partial
    // view under the identical session id.
    const thin = makeSummary({
      sessionId: 'd0f6fceb-ecc5-4610-9c62-3b2c10415137',
      toolCallCount: 1,
      toolBreakdown: { Bash: 1 },
      model: null,
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCostUsd: null,
      modelBreakdown: {},
    });
    store.saveSession(thin);

    const loaded = store.loadSession('d0f6fceb-ecc5-4610-9c62-3b2c10415137');
    expect(loaded?.toolCallCount).toBe(7);
    expect(loaded?.model).toBe('claude-sonnet-4-6');
    expect(loaded?.tokensInput).toBe(292);
    expect(loaded?.modelBreakdown).toEqual({
      'claude-sonnet-4-6': {
        requestCount: 1,
        totalInputTokens: 292,
        totalOutputTokens: 533,
        totalCostUsd: 0.008871,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    });
  });

  it('still lets a later write add new activity', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const id = 'aaaa1111-2222-4333-8444-555566667777';
    store.saveSession(makeSummary({ sessionId: id, toolCallCount: 2, toolBreakdown: { Bash: 2 } }));
    store.saveSession(makeSummary({ sessionId: id, toolCallCount: 9, toolBreakdown: { Bash: 9 } }));
    const loaded = store.loadSession(id);
    expect(loaded?.toolCallCount).toBe(9);
    expect(loaded?.toolBreakdown).toEqual({ Bash: 9 });
  });

  it('unions per-model breakdowns contributed by different processes', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    const id = 'bbbb1111-2222-4333-8444-555566667777';
    store.saveSession(
      makeSummary({
        sessionId: id,
        toolCallCount: 1,
        modelBreakdown: {
          'model-a': {
            requestCount: 1,
            totalInputTokens: 10,
            totalOutputTokens: 5,
            totalCostUsd: 0.1,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            totalThinkingTokens: 0,
          },
        },
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: id,
        toolCallCount: 1,
        modelBreakdown: {
          'model-b': {
            requestCount: 2,
            totalInputTokens: 20,
            totalOutputTokens: 6,
            totalCostUsd: 0.2,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            totalThinkingTokens: 0,
          },
        },
      }),
    );
    expect(Object.keys(store.loadSession(id)?.modelBreakdown ?? {}).sort()).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it('merges into one file instead of duplicating when a later write computes an earlier date than an existing file', () => {
    // A `--local`/synthetic-owner process rolling up a session it only
    // started observing after a date boundary computes its own startTime
    // from the first event *it* saw — which can be a different calendar
    // day than a prior save for the same real session id.
    const store = new SessionStore({ storagePath: tmpDir });
    const id = 'cccc1111-2222-4333-8444-555566667777';

    store.saveSession(
      makeSummary({
        sessionId: id,
        startTime: new Date('2026-03-01T10:00:00Z').getTime(),
        toolCallCount: 5,
        toolBreakdown: { Bash: 5 },
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: id,
        startTime: new Date('2026-03-02T09:00:00Z').getTime(),
        toolCallCount: 3,
        toolBreakdown: { Bash: 3 },
      }),
    );

    const files = readdirSync(join(tmpDir, 'sessions')).filter((f) => f.includes(id));
    expect(files).toEqual(['2026-03-01_cccc1111-2222-4333-8444-555566667777.json']);

    const loaded = store.loadSession(id);
    expect(loaded?.toolCallCount).toBe(5);
    expect(loaded?.toolBreakdown).toEqual({ Bash: 5 });
  });

  it('does not erase a real efficiencyScore/sampleCount/components/costByWorkflowRunId when a later write never seeded them', () => {
    // Simulates a process that resolved its session id via the cwd-only
    // fallback (rehydrateTrackersIfResumed() is skipped for that path in
    // src/index.ts) writing an unseeded shutdown save over a checkpoint that
    // already had a real efficiency score recorded.
    const store = new SessionStore({ storagePath: tmpDir });
    const id = 'dddd1111-2222-4333-8444-555566667777';

    store.saveSession(
      makeSummary({
        sessionId: id,
        efficiencyScore: 0.82,
        efficiencyScoreSampleCount: 5,
        efficiencyScoreComponents: {
          speed: 0.8,
          correctness: 0.9,
          autonomy: 0.7,
          firstAttemptQuality: 0.85,
        },
        costByWorkflowRunId: { 'run-1': { '2026-03-01': 1.5 } },
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: id,
        toolCallCount: 20,
        efficiencyScore: null,
        efficiencyScoreSampleCount: 0,
        efficiencyScoreComponents: null,
        costByWorkflowRunId: {},
      }),
    );

    const loaded = store.loadSession(id);
    expect(loaded?.toolCallCount).toBe(20);
    expect(loaded?.efficiencyScore).toBe(0.82);
    expect(loaded?.efficiencyScoreSampleCount).toBe(5);
    expect(loaded?.efficiencyScoreComponents).toEqual({
      speed: 0.8,
      correctness: 0.9,
      autonomy: 0.7,
      firstAttemptQuality: 0.85,
    });
    expect(loaded?.costByWorkflowRunId).toEqual({ 'run-1': { '2026-03-01': 1.5 } });
  });

  it('merges the efficiencyScore/sampleCount/components triple atomically when BOTH sides have a real score', () => {
    // sampleCount is a weight multiplier for EfficiencyScorer.seedFromPersisted()
    // (score * sampleCount), not just a display field — taking the score from
    // one side and the (larger) sampleCount from the other would attach a
    // thin sample's score to a much larger weight, corrupting every future
    // re-seed. The larger-sampleCount side's full triple must win together.
    const store = new SessionStore({ storagePath: tmpDir });
    const id = 'eeee1111-2222-4333-8444-555566667777';

    store.saveSession(
      makeSummary({
        sessionId: id,
        efficiencyScore: 0.8,
        efficiencyScoreSampleCount: 50,
        efficiencyScoreComponents: {
          speed: 0.8,
          correctness: 0.8,
          autonomy: 0.8,
          firstAttemptQuality: 0.8,
        },
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: id,
        toolCallCount: 20,
        efficiencyScore: 0.4,
        efficiencyScoreSampleCount: 3,
        efficiencyScoreComponents: {
          speed: 0.4,
          correctness: 0.4,
          autonomy: 0.4,
          firstAttemptQuality: 0.4,
        },
      }),
    );

    const loaded = store.loadSession(id);
    // The 50-sample side wins outright — score AND sampleCount AND
    // components together — not a mix of the two sides' fields.
    expect(loaded?.efficiencyScore).toBe(0.8);
    expect(loaded?.efficiencyScoreSampleCount).toBe(50);
    expect(loaded?.efficiencyScoreComponents).toEqual({
      speed: 0.8,
      correctness: 0.8,
      autonomy: 0.8,
      firstAttemptQuality: 0.8,
    });
  });
});

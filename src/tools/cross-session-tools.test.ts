import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import { TrendAnalyzer } from '../metrics/trend-analyzer.js';
import { CollaborationProfiler } from '../metrics/collaboration-profile.js';
import { ClaudeMdTracker } from '../metrics/claudemd-tracker.js';
import { CostPerOutcomeAnalyzer } from '../metrics/cost-per-outcome.js';
import { TaskDetector } from '../metrics/task-detector.js';
import { PromptFeedbackEngine } from '../metrics/prompt-feedback.js';
import { RecommendationEngine } from '../metrics/recommendation-engine.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  handleGetSessionHistory,
  handleGetWeeklySummary,
  handleGetTrends,
  handleGetCollaborationProfile,
  handleGetClaudeMdImpact,
  handleGetCostPerOutcome,
  handleGetRecommendations,
  handleGetPlatformComparison,
  handleGetTeamSummary,
  toFiniteNumber,
} from './cross-session-tools.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(tmpdir(), `nr-xsess-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
  store = new SessionStore({ storagePath: tmpDir });
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
    efficiencyScore: 0.75,
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: 1,
    toolSuccessRate: 1,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 10,
    assistantMessages: 10,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    toolName: 'Read',
    toolUseId: `tu-${Date.now()}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    ...overrides,
  } as ToolCallRecord;
}

describe('Cross-session tool handlers', () => {
  // -------------------------------------------------------------------------
  // 1. get_session_history
  // -------------------------------------------------------------------------

  it('handleGetSessionHistory returns paginated session summaries', () => {
    for (let i = 0; i < 5; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `sess-${i}`,
          startTime: Date.now() - (5 - i) * 86_400_000,
        }),
      );
    }

    const result = handleGetSessionHistory(store, { limit: 3 });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.count).toBe(3);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions[0]).toHaveProperty('session_id');
    expect(parsed.sessions[0]).toHaveProperty('efficiency_score');
    expect(parsed.sessions[0]).toHaveProperty('estimated_cost_usd');
  });

  it('handleGetSessionHistory returns error for invalid since date', () => {
    const result = handleGetSessionHistory(store, { since: 'not-a-date' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('Invalid since date');
  });

  // -------------------------------------------------------------------------
  // 2. get_weekly_summary with "latest"
  // -------------------------------------------------------------------------

  it('handleGetWeeklySummary with "latest" returns current week data', () => {
    store.saveSession(
      makeSummary({
        sessionId: 'this-week',
        startTime: Date.now() - 86_400_000,
        estimatedCostUsd: 2.5,
      }),
    );

    const generator = new WeeklySummaryGenerator({
      storagePath: tmpDir,
      sessionStore: store,
    });

    const result = handleGetWeeklySummary(generator, { week: 'latest' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toHaveProperty('week');
    expect(parsed).toHaveProperty('sessionCount');
    expect(parsed).toHaveProperty('totalCostUsd');
    expect(parsed).toHaveProperty('perDeveloper');
  });

  // -------------------------------------------------------------------------
  // handleGetWeeklySummary — weekId validation
  // -------------------------------------------------------------------------

  it('handleGetWeeklySummary returns error for path-traversal weekId', () => {
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const result = handleGetWeeklySummary(generator, { week: '../../../etc/passwd' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toMatch(/Invalid week format/);
  });

  it('handleGetWeeklySummary returns error for arbitrary string weekId', () => {
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const result = handleGetWeeklySummary(generator, { week: 'not-a-week' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toMatch(/Invalid week format/);
  });

  it('handleGetWeeklySummary accepts valid YYYY-Wnn weekId', () => {
    const generator = new WeeklySummaryGenerator({ storagePath: tmpDir, sessionStore: store });
    const result = handleGetWeeklySummary(generator, { week: '2026-W16' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.week).toBe('2026-W16');
  });

  // -------------------------------------------------------------------------
  // 3. get_trends for "efficiency"
  // -------------------------------------------------------------------------

  it('handleGetTrends returns weekly efficiency data points', () => {
    // Create sessions across 2 weeks
    const now = Date.now();
    store.saveSession(
      makeSummary({
        sessionId: 'week-1',
        startTime: now - 10 * 86_400_000,
        efficiencyScore: 0.6,
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'week-2',
        startTime: now - 3 * 86_400_000,
        efficiencyScore: 0.8,
      }),
    );

    const trendAnalyzer = new TrendAnalyzer({ sessionStore: store });

    const result = handleGetTrends(trendAnalyzer, { metric: 'efficiency', weeks: 4 });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.metric).toBe('efficiency');
    expect(parsed.data_points).toBeInstanceOf(Array);
    expect(parsed.data_points.length).toBeGreaterThanOrEqual(1);
    expect(parsed.data_points[0]).toHaveProperty('week');
    expect(parsed.data_points[0]).toHaveProperty('value');
  });

  // -------------------------------------------------------------------------
  // 4. get_collaboration_profile
  // -------------------------------------------------------------------------

  it('handleGetCollaborationProfile returns dimension scores and classification', () => {
    store.saveSession(
      makeSummary({
        sessionId: 's1',
        userMessages: 10,
        userCorrections: 1,
        toolCallCount: 20,
        taskCount: 2,
        agentSpawns: 1,
      }),
    );

    const profiler = new CollaborationProfiler({ sessionStore: store });

    const result = handleGetCollaborationProfile(profiler, { developer: 'alice' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.developer).toBe('alice');
    expect(parsed.classification).toBeTruthy();
    expect(parsed.dimensions).toHaveProperty('specificity');
    expect(parsed.dimensions).toHaveProperty('autonomy');
    expect(parsed.dimensions).toHaveProperty('correctionRate');
    expect(parsed.dimensions).toHaveProperty('taskComplexity');
    expect(parsed.team_comparison).toHaveProperty('specificity');
  });

  // -------------------------------------------------------------------------
  // 5. get_claudemd_impact
  // -------------------------------------------------------------------------

  it('handleGetClaudeMdImpact returns before/after deltas', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    tracker.detectChange(
      makeToolCall({
        toolName: 'Write',
        filePath: '/project/CLAUDE.md',
        lineCount: 30,
        timestamp: changeTimestamp,
      } as Partial<ToolCallRecord>),
    );

    store.saveSession(
      makeSummary({
        sessionId: 'before-1',
        startTime: changeTimestamp - 86_400_000,
        efficiencyScore: 0.6,
        estimatedCostUsd: 4,
      }),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'after-1',
        startTime: changeTimestamp + 86_400_000,
        efficiencyScore: 0.8,
        estimatedCostUsd: 3,
      }),
    );

    const result = handleGetClaudeMdImpact(tracker);
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.change).toHaveProperty('file');
    expect(parsed.change).toHaveProperty('type');
    expect(parsed.before).toHaveProperty('avgEfficiencyScore');
    expect(parsed.after).toHaveProperty('avgEfficiencyScore');
    expect(parsed.deltas).toHaveProperty('efficiencyScore');
    expect(parsed).toHaveProperty('verdict');
  });

  // -------------------------------------------------------------------------
  // 6. get_cost_per_outcome
  // -------------------------------------------------------------------------

  it('handleGetCostPerOutcome returns per-category breakdown', () => {
    const analyzer = new CostPerOutcomeAnalyzer();
    const taskDetector = new TaskDetector();

    // Record tool calls to create a completed task
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Write',
        filePath: '/src/new.ts',
        timestamp: Date.now() - 5000,
      } as Partial<ToolCallRecord>),
    );
    // Force task completion with a large gap
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Read',
        timestamp: Date.now() + 60_000,
      }),
    );

    const result = handleGetCostPerOutcome(analyzer, taskDetector, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toHaveProperty('outcome_distribution');
    expect(parsed).toHaveProperty('waste_ratio');
    expect(parsed).toHaveProperty('total_cost');
    expect(parsed).toHaveProperty('total_tasks');
    expect(parsed).toHaveProperty('roi_estimate');
  });

  it('handleGetCostPerOutcome filters tasks by since parameter', () => {
    const analyzer = new CostPerOutcomeAnalyzer();
    const taskDetector = new TaskDetector();

    const now = Date.now();
    // Create an old completed task
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Write',
        filePath: '/src/old.ts',
        timestamp: now - 100_000,
      } as Partial<ToolCallRecord>),
    );
    // Close old task via AskUserQuestion boundary signal
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'AskUserQuestion',
        timestamp: now - 50_000,
      }),
    );
    // Create a recent task (active, not completed)
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Edit',
        filePath: '/src/new.ts',
        timestamp: now - 5_000,
      } as Partial<ToolCallRecord>),
    );

    // Filter to only include tasks starting after 60s ago
    const sinceDate = new Date(now - 10_000).toISOString();
    const result = handleGetCostPerOutcome(analyzer, taskDetector, { since: sinceDate });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.total_tasks).toBe(1);
  });

  it('handleGetCostPerOutcome includes active task', () => {
    const analyzer = new CostPerOutcomeAnalyzer();
    const taskDetector = new TaskDetector();

    // Only an active task (no completed)
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Edit',
        filePath: '/src/active.ts',
        timestamp: Date.now(),
      } as Partial<ToolCallRecord>),
    );

    expect(taskDetector.getCompletedTasks()).toHaveLength(0);
    expect(taskDetector.getCurrentTask()).not.toBeNull();

    const result = handleGetCostPerOutcome(analyzer, taskDetector, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.total_tasks).toBe(1);
  });

  it('handleGetCostPerOutcome handles invalid since date gracefully', () => {
    const analyzer = new CostPerOutcomeAnalyzer();
    const taskDetector = new TaskDetector();

    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Write',
        filePath: '/src/file.ts',
        timestamp: Date.now() - 5000,
      } as Partial<ToolCallRecord>),
    );
    taskDetector.recordToolCall(
      makeToolCall({
        toolName: 'Read',
        timestamp: Date.now() + 60_000,
      }),
    );

    // Invalid date string — now returns isError: true (consistent with handleGetSessionHistory)
    const result = handleGetCostPerOutcome(analyzer, taskDetector, { since: 'not-a-date' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // 7. get_recommendations
  // -------------------------------------------------------------------------

  it('handleGetRecommendations returns prioritized list with evidence', () => {
    // High correction rate → generates recommendations
    store.saveSession(
      makeSummary({
        sessionId: 's1',
        userMessages: 20,
        userCorrections: 8,
      }),
    );

    const trendAnalyzer = new TrendAnalyzer({ sessionStore: store });
    const collaborationProfiler = new CollaborationProfiler({ sessionStore: store });
    const claudeMdTracker = new ClaudeMdTracker({ sessionStore: store });
    const promptFeedbackEngine = new PromptFeedbackEngine({
      sessionStore: store,
      collaborationProfiler,
      claudeMdTracker,
    });
    const costPerOutcomeAnalyzer = new CostPerOutcomeAnalyzer();

    const engine = new RecommendationEngine({
      sessionStore: store,
      trendAnalyzer,
      collaborationProfiler,
      claudeMdTracker,
      promptFeedbackEngine,
      costPerOutcomeAnalyzer,
    });

    const result = handleGetRecommendations(engine, { developer: 'alice' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toHaveProperty('recommendations');
    expect(parsed).toHaveProperty('count');
    expect(parsed.count).toBeGreaterThan(0);

    const rec = parsed.recommendations[0];
    expect(rec).toHaveProperty('id');
    expect(rec).toHaveProperty('category');
    expect(rec).toHaveProperty('priority');
    expect(rec).toHaveProperty('detail');
    expect(rec).toHaveProperty('evidence');
  });

  // -------------------------------------------------------------------------
  // 8. get_platform_comparison — efficiency
  // -------------------------------------------------------------------------

  it('handleGetPlatformComparison returns per-platform efficiency data', () => {
    store.saveSession(
      makeSummary({
        sessionId: 'cc-1',
        efficiencyScore: 0.8,
        platform: 'claude-code',
      } as Partial<FullSessionSummary>),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'cur-1',
        efficiencyScore: 0.6,
        platform: 'cursor',
      } as Partial<FullSessionSummary>),
    );

    const result = handleGetPlatformComparison(store, { metric: 'efficiency' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.metric).toBe('efficiency');
    expect(parsed.platforms).toHaveProperty('claude-code');
    expect(parsed.platforms).toHaveProperty('cursor');
    expect(parsed.platforms['claude-code'].session_count).toBe(1);
    expect(parsed.platforms['claude-code'].average).toBe(0.8);
    expect(parsed.platforms['cursor'].average).toBe(0.6);
  });

  // -------------------------------------------------------------------------
  // 9. get_platform_comparison — cost
  // -------------------------------------------------------------------------

  it('handleGetPlatformComparison returns per-platform cost data', () => {
    store.saveSession(
      makeSummary({
        sessionId: 'cc-cost',
        estimatedCostUsd: 1.5,
        platform: 'claude-code',
      } as Partial<FullSessionSummary>),
    );
    store.saveSession(
      makeSummary({
        sessionId: 'ws-cost',
        estimatedCostUsd: 0.75,
        platform: 'windsurf',
      } as Partial<FullSessionSummary>),
    );

    const result = handleGetPlatformComparison(store, { metric: 'cost' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.metric).toBe('cost');
    expect(parsed.platforms).toHaveProperty('windsurf');
    expect(parsed.platforms['windsurf'].average).toBe(0.75);
  });

  // -------------------------------------------------------------------------
  // 10. get_platform_comparison — defaults
  // -------------------------------------------------------------------------

  it('handleGetPlatformComparison defaults sessions without platform to claude-code', () => {
    store.saveSession(
      makeSummary({
        sessionId: 'no-platform',
        efficiencyScore: 0.7,
      }),
    );

    const result = handleGetPlatformComparison(store, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.metric).toBe('efficiency');
    expect(parsed.platforms).toHaveProperty('claude-code');
  });

  // -------------------------------------------------------------------------
  // 11. get_platform_comparison — error_rate weighted formula (B-02)
  // -------------------------------------------------------------------------

  it('handleGetPlatformComparison error_rate uses weighted formula across sessions', () => {
    // Session A: 1 call, 100% tool failure rate → contributes 1 failed call
    store.saveSession(
      makeSummary({
        sessionId: 'er-a',
        toolCallCount: 1,
        toolSuccessRate: 0,
        platform: 'claude-code',
      } as Partial<FullSessionSummary>),
    );
    // Session B: 100 calls, 10% tool failure rate → contributes 10 failed calls
    store.saveSession(
      makeSummary({
        sessionId: 'er-b',
        toolCallCount: 100,
        toolSuccessRate: 0.9,
        platform: 'claude-code',
      } as Partial<FullSessionSummary>),
    );

    const result = handleGetPlatformComparison(store, { metric: 'error_rate' });
    const parsed = JSON.parse(result.content[0]!.text);

    // Weighted: (1 + 10) / (1 + 100) = 11/101 ≈ 0.11
    // Unweighted arithmetic mean would be: (1.0 + 0.1) / 2 = 0.55 — very different
    const average = parsed.platforms['claude-code'].average as number;
    expect(average).toBeCloseTo(11 / 101, 2);
    expect(average).not.toBeCloseTo(0.55, 1);
  });

  it('handleGetPlatformComparison error_rate returns 0 when platform has no tool calls', () => {
    store.saveSession(
      makeSummary({
        sessionId: 'er-zero',
        toolCallCount: 0,
        toolSuccessRate: 0,
        platform: 'cursor',
      } as Partial<FullSessionSummary>),
    );

    const result = handleGetPlatformComparison(store, { metric: 'error_rate' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.platforms['cursor'].average).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 12. get_platform_comparison — error_rate uses tool success, not task success (#101)
  // -------------------------------------------------------------------------

  it('handleGetPlatformComparison error_rate reflects tool failures, not test pass rate', () => {
    // Platform with 0 test runs but 50% tool failure — old code showed 0% error rate
    store.saveSession(
      makeSummary({
        sessionId: 'no-tests',
        toolCallCount: 10,
        toolSuccessRate: 0.5, // 50% tool success → 50% error rate
        taskSuccessRate: null, // no test runs
        platform: 'windsurf',
      } as Partial<FullSessionSummary>),
    );

    const result = handleGetPlatformComparison(store, { metric: 'error_rate' });
    const parsed = JSON.parse(result.content[0]!.text);

    // Should report 0.5 (50% tool error rate), not 0 (from null taskSuccessRate ?? 1 → 0%)
    expect(parsed.platforms['windsurf'].average).toBeCloseTo(0.5, 2);
  });

  // unbounded developer / notes inputs
  it('handleGetSessionHistory truncates developer over 256 chars', () => {
    const longDev = 'a'.repeat(300);
    store.saveSession(makeSummary({ sessionId: 'dev-long', developer: 'a'.repeat(256) }));
    // Should not throw; developer filter is truncated, returning 0 or 1 sessions
    const result = handleGetSessionHistory(store, { developer: longDev });
    expect(result.content[0]).toBeDefined();
  });

  it('handleGetTrends truncates developer over 256 chars', () => {
    const analyzer = new TrendAnalyzer({ sessionStore: store });
    const longDev = 'b'.repeat(300);
    // Should not throw and returns a result object
    const result = handleGetTrends(analyzer, { developer: longDev, weeks: 4 });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty('data_points');
  });

  it('handleGetCollaborationProfile truncates developer over 256 chars', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });
    const longDev = 'c'.repeat(300);
    const result = handleGetCollaborationProfile(profiler, { developer: longDev });
    const parsed = JSON.parse(result.content[0]!.text);
    // developer in response is the value stored by the profiler (truncated input)
    expect(parsed.developer.length).toBeLessThanOrEqual(256);
  });

  it('handleGetRecommendations truncates developer over 256 chars', () => {
    const trendAnalyzer = new TrendAnalyzer({ sessionStore: store });
    const collaborationProfiler = new CollaborationProfiler({ sessionStore: store });
    const claudeMdTracker = new ClaudeMdTracker({ sessionStore: store });
    const promptFeedbackEngine = new PromptFeedbackEngine({
      sessionStore: store,
      collaborationProfiler,
      claudeMdTracker,
    });
    const costPerOutcomeAnalyzer = new CostPerOutcomeAnalyzer();
    const engine = new RecommendationEngine({
      sessionStore: store,
      trendAnalyzer,
      collaborationProfiler,
      claudeMdTracker,
      promptFeedbackEngine,
      costPerOutcomeAnalyzer,
    });
    const longDev = 'd'.repeat(300);
    const result = handleGetRecommendations(engine, { developer: longDev });
    expect(result.content[0]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // handleGetTeamSummary — teamId validation
  // -------------------------------------------------------------------------

  it('rejects teamId with special characters', async () => {
    const result = await handleGetTeamSummary({
      teamId: "team' OR '1'='1",
      accountId: '12345',
      nrApiKey: 'test-key',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toBeDefined();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('Invalid teamId format');
  });

  it('rejects teamId with spaces', async () => {
    const result = await handleGetTeamSummary({
      teamId: 'team with spaces',
      accountId: '12345',
      nrApiKey: 'test-key',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toBeDefined();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
  });

  it('accepts teamId with valid characters (does not reject on format)', async () => {
    const result = await handleGetTeamSummary({
      teamId: 'platform-team_123',
      accountId: '12345',
      nrApiKey: 'test-key',
    });
    expect(result.content[0]).toBeDefined();
    const text = result.content[0].text;
    // Valid teamId should not trigger format validation error.
    // May still error from NerdGraph request, but that's OK — we're testing format validation.
    const parsed = JSON.parse(text);
    if (parsed.error) {
      expect(parsed.error).not.toContain('Invalid teamId format');
    }
  });

  it('rejects non-numeric accountId', async () => {
    const result = await handleGetTeamSummary({
      teamId: 'my-team',
      accountId: 'not-a-number',
      nrApiKey: 'test-key',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/Invalid accountId/);
  });

  it('rejects NaN accountId', async () => {
    const result = await handleGetTeamSummary({
      teamId: 'my-team',
      accountId: 'NaN',
      nrApiKey: 'test-key',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/Invalid accountId/);
  });

  it('surfaces NerdGraph errors instead of returning empty results', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: 'Access denied' }] }),
    } as Response);

    try {
      const result = await handleGetTeamSummary({
        teamId: 'my-team',
        accountId: '12345',
        nrApiKey: 'test-key',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain('NerdGraph');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('surfaces missing data structure instead of returning empty results', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: { actor: { account: { nrql: null } } } }),
    } as Response);

    try {
      const result = await handleGetTeamSummary({
        teamId: 'my-team',
        accountId: '12345',
        nrApiKey: 'test-key',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // negative and out-of-range inputs
  // -------------------------------------------------------------------------

  describe('negative and out-of-range inputs', () => {
    it('handleGetTrends with weeks: -1 does not crash and returns data_points array', () => {
      const analyzer = new TrendAnalyzer({ sessionStore: store });
      const result = handleGetTrends(analyzer, { weeks: -1 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.data_points).toBeInstanceOf(Array);
      expect(parsed.metric).toBe('efficiency');
      expect(parsed.weeks).toBe(1); // clamped to minimum 1
    });

    it('handleGetTrends with weeks: 999 does not crash and returns data_points array', () => {
      const analyzer = new TrendAnalyzer({ sessionStore: store });
      const result = handleGetTrends(analyzer, { weeks: 999 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.data_points).toBeInstanceOf(Array);
    });

    it('handleGetPlatformComparison with weeks: -1 does not crash', () => {
      const result = handleGetPlatformComparison(store, { weeks: -1 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.platforms).toBeDefined();
      expect(parsed.weeks).toBe(-1);
    });

    it('handleGetPlatformComparison with weeks: 999 does not crash', () => {
      const result = handleGetPlatformComparison(store, { weeks: 999 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.platforms).toBeDefined();
    });

    it('handleGetTeamSummary rejects since: "yesterday" (plain word, not relative format)', async () => {
      const result = await handleGetTeamSummary({
        teamId: 'my-team',
        accountId: '12345',
        nrApiKey: 'test-key',
        since: 'yesterday',
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/Invalid since/);
    });

    it('handleGetTeamSummary rejects since: "2026-05-01" (ISO date instead of relative)', async () => {
      const result = await handleGetTeamSummary({
        teamId: 'my-team',
        accountId: '12345',
        nrApiKey: 'test-key',
        since: '2026-05-01',
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/Invalid since/);
    });

    it('handleGetSessionHistory with limit: 0 does not crash', () => {
      store.saveSession(makeSummary({ sessionId: 'lim-zero' }));
      const result = handleGetSessionHistory(store, { limit: 0 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.sessions).toBeInstanceOf(Array);
    });
  });

  // -------------------------------------------------------------------------
  // Findings #1 & #2: team summary NRQL must not use cumulative gauge rollups
  // -------------------------------------------------------------------------

  describe('team summary NRQL uses correct attributes', () => {
    it('cost query uses AiCodingTask not cumulative gauge sum', async () => {
      const bodies: string[] = [];
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return {
          ok: true,
          json: async () => ({ data: { actor: { account: { nrql: { results: [] } } } } }),
        } as Response;
      });
      try {
        await handleGetTeamSummary({ teamId: 'my-team', accountId: '12345', nrApiKey: 'test-key' });
        const allBodies = bodies.join('\n');
        expect(allBodies).not.toContain('ai.cost.session_total_usd.sum');
        expect(allBodies).toContain('AiCodingTask');
        expect(allBodies).toContain('ai.estimated_cost_usd');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('efficiency query does not reference non-existent .sum rollup attribute', async () => {
      const bodies: string[] = [];
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return {
          ok: true,
          json: async () => ({ data: { actor: { account: { nrql: { results: [] } } } } }),
        } as Response;
      });
      try {
        await handleGetTeamSummary({ teamId: 'my-team', accountId: '12345', nrApiKey: 'test-key' });
        const allBodies = bodies.join('\n');
        expect(allBodies).not.toContain('ai.efficiency.score.sum');
        expect(allBodies).toContain('ai.efficiency.score');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('toFiniteNumber', () => {
    it('converts valid numbers', () => {
      expect(toFiniteNumber(123)).toBe(123);
      expect(toFiniteNumber('456')).toBe(456);
      expect(toFiniteNumber(0)).toBe(0);
    });

    it('returns fallback (0) for non-numeric strings', () => {
      expect(toFiniteNumber('abc')).toBe(0);
      expect(toFiniteNumber('')).toBe(0);
    });

    it('returns fallback (0) for undefined and null', () => {
      expect(toFiniteNumber(undefined)).toBe(0);
      expect(toFiniteNumber(null)).toBe(0);
    });

    it('returns fallback (0) for Infinity and NaN', () => {
      expect(toFiniteNumber(Infinity)).toBe(0);
      expect(toFiniteNumber(-Infinity)).toBe(0);
      expect(toFiniteNumber(NaN)).toBe(0);
    });

    it('uses a custom fallback when provided', () => {
      expect(toFiniteNumber('abc', -1)).toBe(-1);
    });
  });
});

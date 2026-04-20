import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { WeeklySummaryGenerator, getIsoWeekId } from '../storage/weekly-summary.js';
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
} from './cross-session-tools.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
      store.saveSession(makeSummary({
        sessionId: `sess-${i}`,
        startTime: Date.now() - (5 - i) * 86_400_000,
      }));
    }

    const result = handleGetSessionHistory(store, { limit: 3 });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.count).toBe(3);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions[0]).toHaveProperty('session_id');
    expect(parsed.sessions[0]).toHaveProperty('efficiency_score');
    expect(parsed.sessions[0]).toHaveProperty('estimated_cost_usd');
  });

  // -------------------------------------------------------------------------
  // 2. get_weekly_summary with "latest"
  // -------------------------------------------------------------------------

  it('handleGetWeeklySummary with "latest" returns current week data', () => {
    store.saveSession(makeSummary({
      sessionId: 'this-week',
      startTime: Date.now() - 86_400_000,
      estimatedCostUsd: 2.5,
    }));

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
  // 3. get_trends for "efficiency"
  // -------------------------------------------------------------------------

  it('handleGetTrends returns weekly efficiency data points', () => {
    // Create sessions across 2 weeks
    const now = Date.now();
    store.saveSession(makeSummary({
      sessionId: 'week-1',
      startTime: now - 10 * 86_400_000,
      efficiencyScore: 0.6,
    }));
    store.saveSession(makeSummary({
      sessionId: 'week-2',
      startTime: now - 3 * 86_400_000,
      efficiencyScore: 0.8,
    }));

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
    store.saveSession(makeSummary({
      sessionId: 's1',
      userMessages: 10,
      userCorrections: 1,
      toolCallCount: 20,
      taskCount: 2,
      agentSpawns: 1,
    }));

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

    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 30,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    store.saveSession(makeSummary({
      sessionId: 'before-1',
      startTime: changeTimestamp - 86_400_000,
      efficiencyScore: 0.6,
      estimatedCostUsd: 4,
    }));
    store.saveSession(makeSummary({
      sessionId: 'after-1',
      startTime: changeTimestamp + 86_400_000,
      efficiencyScore: 0.8,
      estimatedCostUsd: 3,
    }));

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
    taskDetector.recordToolCall(makeToolCall({
      toolName: 'Write',
      filePath: '/src/new.ts',
      timestamp: Date.now() - 5000,
    } as Partial<ToolCallRecord>));
    // Force task completion with a large gap
    taskDetector.recordToolCall(makeToolCall({
      toolName: 'Read',
      timestamp: Date.now() + 60_000,
    }));

    const result = handleGetCostPerOutcome(analyzer, taskDetector, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toHaveProperty('outcome_distribution');
    expect(parsed).toHaveProperty('waste_ratio');
    expect(parsed).toHaveProperty('total_cost');
    expect(parsed).toHaveProperty('total_tasks');
    expect(parsed).toHaveProperty('roi_estimate');
  });

  // -------------------------------------------------------------------------
  // 7. get_recommendations
  // -------------------------------------------------------------------------

  it('handleGetRecommendations returns prioritized list with evidence', () => {
    // High correction rate → generates recommendations
    store.saveSession(makeSummary({
      sessionId: 's1',
      userMessages: 20,
      userCorrections: 8,
    }));

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
    store.saveSession(makeSummary({
      sessionId: 'cc-1',
      efficiencyScore: 0.8,
      platform: 'claude-code',
    } as Partial<FullSessionSummary>));
    store.saveSession(makeSummary({
      sessionId: 'cur-1',
      efficiencyScore: 0.6,
      platform: 'cursor',
    } as Partial<FullSessionSummary>));

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
    store.saveSession(makeSummary({
      sessionId: 'cc-cost',
      estimatedCostUsd: 1.50,
      platform: 'claude-code',
    } as Partial<FullSessionSummary>));
    store.saveSession(makeSummary({
      sessionId: 'ws-cost',
      estimatedCostUsd: 0.75,
      platform: 'windsurf',
    } as Partial<FullSessionSummary>));

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
    store.saveSession(makeSummary({
      sessionId: 'no-platform',
      efficiencyScore: 0.7,
    }));

    const result = handleGetPlatformComparison(store, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.metric).toBe('efficiency');
    expect(parsed.platforms).toHaveProperty('claude-code');
  });
});

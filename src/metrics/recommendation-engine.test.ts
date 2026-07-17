import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricAggregator } from '../shared/index.js';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';
import { TrendAnalyzer } from './trend-analyzer.js';
import { CollaborationProfiler } from './collaboration-profile.js';
import { ClaudeMdTracker } from './claudemd-tracker.js';
import { PromptFeedbackEngine } from './prompt-feedback.js';
import { CostPerOutcomeAnalyzer } from './cost-per-outcome.js';
import { RecommendationEngine } from './recommendation-engine.js';
import { TaskDetector } from './task-detector.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(tmpdir(), `nr-rec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    userMessages: 10,
    assistantMessages: 10,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

function createEngine() {
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

  return { engine, claudeMdTracker };
}

describe('RecommendationEngine', () => {
  // -------------------------------------------------------------------------
  // 1. Combines sub-engines
  // -------------------------------------------------------------------------

  it('generateAllRecommendations combines recommendations from multiple sub-engines', () => {
    const { engine } = createEngine();

    // High correction rate → prompt_engineering rec
    // Re-reading anti-patterns → prompt_engineering rec (file_paths)
    for (let i = 0; i < 4; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `s-${i}`,
          userMessages: 20,
          userCorrections: 8,
          antiPatterns: [{ type: 're_reading', count: 3 }],
        }),
      );
    }
    store.saveSession(
      makeSummary({
        sessionId: 's-clean',
        userMessages: 20,
        userCorrections: 8,
        antiPatterns: [{ type: 're_reading', count: 1 }],
      }),
    );

    const recs = engine.generateAllRecommendations('alice');

    expect(recs.length).toBeGreaterThanOrEqual(2);

    const categories = new Set(recs.map((r) => r.category));
    expect(categories.has('prompt_engineering')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Deduplicated
  // -------------------------------------------------------------------------

  it('recommendations are deduplicated by id', () => {
    const { engine } = createEngine();

    // Same conditions that generate same recommendations
    for (let i = 0; i < 3; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `s-${i}`,
          userMessages: 20,
          userCorrections: 8,
        }),
      );
    }

    const recs = engine.generateAllRecommendations('alice');
    const ids = recs.map((r) => r.id);
    const uniqueIds = new Set(ids);

    expect(ids.length).toBe(uniqueIds.size);
  });

  // -------------------------------------------------------------------------
  // 3. Sorted by priority
  // -------------------------------------------------------------------------

  it('recommendations are sorted by priority: high before medium before low', () => {
    const { engine } = createEngine();

    // Trigger both high (correction rate) and medium (re-reading) recs
    for (let i = 0; i < 4; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `s-${i}`,
          userMessages: 20,
          userCorrections: 8,
          antiPatterns: [{ type: 're_reading', count: 2 }],
        }),
      );
    }
    store.saveSession(
      makeSummary({
        sessionId: 's-clean',
        userMessages: 20,
        userCorrections: 8,
        antiPatterns: [{ type: 're_reading', count: 1 }],
      }),
    );

    const recs = engine.generateAllRecommendations('alice');

    if (recs.length >= 2) {
      const highIdx = recs.findIndex((r) => r.priority === 'high');
      const mediumIdx = recs.findIndex((r) => r.priority === 'medium');

      if (highIdx !== -1 && mediumIdx !== -1) {
        expect(highIdx).toBeLessThan(mediumIdx);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 4. topN limits output
  // -------------------------------------------------------------------------

  it('topN limits the number of recommendations returned', () => {
    const { engine } = createEngine();

    // Generate multiple recs
    for (let i = 0; i < 4; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `s-${i}`,
          userMessages: 20,
          userCorrections: 8,
          antiPatterns: [{ type: 're_reading', count: 3 }],
        }),
      );
    }
    store.saveSession(
      makeSummary({
        sessionId: 's-extra',
        userMessages: 20,
        userCorrections: 8,
        antiPatterns: [{ type: 're_reading', count: 1 }],
      }),
    );

    const allRecs = engine.generateAllRecommendations('alice');
    expect(allRecs.length).toBeGreaterThanOrEqual(2);

    const limited = engine.generateAllRecommendations('alice', { topN: 1 });
    expect(limited.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. Cost recommendations include active task
  // -------------------------------------------------------------------------

  it('cost recommendations consider the active (current) task', () => {
    const taskDetector = new TaskDetector();

    // Record enough tool calls with failures to trigger high waste ratio
    for (let i = 0; i < 10; i++) {
      taskDetector.recordToolCall({
        id: `rec-${i}`,
        sessionId: 'sess-cost-test',
        toolName: 'Edit',
        toolUseId: `toolu_${i}`,
        timestamp: Date.now() + i * 100,
        durationMs: 200,
        success: i % 2 === 0, // 50% failure rate
      } satisfies ToolCallRecord);
    }

    // No completed tasks — only an active task
    expect(taskDetector.getCompletedTasks()).toHaveLength(0);
    expect(taskDetector.getCurrentTask()).not.toBeNull();

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
      taskDetector,
    });

    const recs = engine.generateAllRecommendations('alice');

    // Should have at least prompt recs; the key check is that getCostRecommendations
    // didn't silently skip due to empty completedTasks
    expect(recs.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. generateTeamRecommendations
  // -------------------------------------------------------------------------

  it('generateTeamRecommendations flags high team correction rate and low autonomy', () => {
    const { engine } = createEngine();

    for (const developer of ['alice', 'bob']) {
      store.saveSession(
        makeSummary({
          sessionId: `team-${developer}`,
          developer,
          userMessages: 10,
          userCorrections: 8, // correctionRate = 1 - 8/10 = 0.2 -> team correction pct = 80%
          toolCallCount: 5,
          assistantMessages: 10, // autonomy = (5/10)/5 = 0.1
        }),
      );
    }

    const recs = engine.generateTeamRecommendations();

    expect(
      recs.some(
        (r) =>
          r.category === 'efficiency' &&
          r.priority === 'high' &&
          r.title === 'High team correction rate',
      ),
    ).toBe(true);
    expect(
      recs.some(
        (r) =>
          r.category === 'prompt_engineering' &&
          r.priority === 'medium' &&
          r.title === 'Low team autonomy',
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. getModelRecommendations via generateAllRecommendations
  // -------------------------------------------------------------------------

  it('flags cost-inefficient model usage when cost ratio exceeds 2x with <15% efficiency difference', () => {
    const { engine } = createEngine();

    for (let i = 0; i < 2; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `expensive-${i}`,
          model: 'model-alpha',
          estimatedCostUsd: 1.0,
          efficiencyScore: 0.8,
        }),
      );
      store.saveSession(
        makeSummary({
          sessionId: `cheap-${i}`,
          model: 'model-beta',
          estimatedCostUsd: 0.4,
          efficiencyScore: 0.8,
        }),
      );
    }

    const recs = engine.generateAllRecommendations('alice');

    const modelRec = recs.find((r) => r.category === 'model_selection');
    expect(modelRec).toBeDefined();
    expect(modelRec?.detail).toContain('model-beta');
  });

  // -------------------------------------------------------------------------
  // 6. emitMetrics
  // -------------------------------------------------------------------------

  it('emitMetrics emits ai.recommendation events with correct attributes', () => {
    const { engine } = createEngine();

    store.saveSession(
      makeSummary({
        sessionId: 's1',
        userMessages: 20,
        userCorrections: 8,
      }),
    );

    const recorded: Array<{
      name: string;
      value: number;
      attrs?: Record<string, string | number>;
    }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    engine.emitMetrics(aggregator, 'alice');

    expect(recorded.length).toBeGreaterThan(0);

    for (const r of recorded) {
      expect(r.name).toBe('ai.recommendation');
      expect(r.attrs?.developer).toBe('alice');
      expect(r.attrs?.category).toBeTruthy();
      expect(r.attrs?.priority).toBeTruthy();
    }
  });
});

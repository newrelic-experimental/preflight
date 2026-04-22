import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';
import { CollaborationProfiler } from './collaboration-profile.js';
import { ClaudeMdTracker } from './claudemd-tracker.js';
import { PromptFeedbackEngine } from './prompt-feedback.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-feedback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function createEngine() {
  const profiler = new CollaborationProfiler({ sessionStore: store });
  const tracker = new ClaudeMdTracker({ sessionStore: store });
  const engine = new PromptFeedbackEngine({
    sessionStore: store,
    collaborationProfiler: profiler,
    claudeMdTracker: tracker,
  });
  return { profiler, tracker, engine };
}

describe('PromptFeedbackEngine', () => {
  // -------------------------------------------------------------------------
  // 1. File path correlation
  // -------------------------------------------------------------------------

  it('correlates file-path-providing sessions with higher efficiency', () => {
    const { engine } = createEngine();

    // Sessions where dev "provides file paths" (low Read ratio, has modifications)
    // Read ratio < 0.3: e.g. Read=2 out of 20 toolCalls = 0.1
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `with-fp-${i}`,
        toolCallCount: 20,
        toolBreakdown: { Read: 2, Edit: 10, Bash: 8 },
        filesModified: ['/src/index.ts'],
        efficiencyScore: 0.85,
      }));
    }

    // Sessions without file paths (high Read ratio = lots of exploration)
    // Read ratio > 0.3: e.g. Read=15 out of 20 toolCalls = 0.75
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `without-fp-${i}`,
        toolCallCount: 20,
        toolBreakdown: { Read: 15, Edit: 3, Bash: 2 },
        filesModified: ['/src/index.ts'],
        efficiencyScore: 0.55,
      }));
    }

    const correlations = engine.correlatePromptStyleWithOutcomes('alice');

    const filePathCorrelation = correlations.find((c) => c.behavior === 'provides file paths');
    expect(filePathCorrelation).toBeDefined();
    expect(filePathCorrelation!.delta).toBeGreaterThan(0);
    expect(filePathCorrelation!.withBehaviorAvg).toBeGreaterThan(filePathCorrelation!.withoutBehaviorAvg);
  });

  // -------------------------------------------------------------------------
  // 2. Cohen's d — significant
  // -------------------------------------------------------------------------

  it('compareClaudeMdVersions labels large effect size as significant', () => {
    const { engine } = createEngine();
    const changeTimestamp = Date.now();

    // Before: efficiency clustered around 0.5
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `before-${i}`,
        startTime: changeTimestamp - 86_400_000 * (i + 1),
        efficiencyScore: 0.5 + (i % 2 === 0 ? 0.02 : -0.02),
      }));
    }

    // After: efficiency clustered around 0.9
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: 0.9 + (i % 2 === 0 ? 0.02 : -0.02),
      }));
    }

    const comparison = engine.compareClaudeMdVersions(changeTimestamp);

    const effSize = comparison.effectSizes.find((e) => e.metric === 'efficiency');
    expect(effSize).toBeDefined();
    expect(effSize!.cohensD).toBeGreaterThan(0.5);
    expect(effSize!.label).toBe('significant');
  });

  // -------------------------------------------------------------------------
  // 3. Cohen's d — noise
  // -------------------------------------------------------------------------

  it('compareClaudeMdVersions labels small effect size as noise', () => {
    const { engine } = createEngine();
    const changeTimestamp = Date.now();

    // Before: efficiency with large spread, mean ~0.7
    const beforeScores = [0.50, 0.60, 0.70, 0.80, 0.90];
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `before-${i}`,
        startTime: changeTimestamp - 86_400_000 * (i + 1),
        efficiencyScore: beforeScores[i]!,
      }));
    }

    // After: efficiency with large spread, mean ~0.72 (tiny difference vs before)
    const afterScores = [0.52, 0.62, 0.72, 0.82, 0.92];
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: afterScores[i]!,
      }));
    }

    const comparison = engine.compareClaudeMdVersions(changeTimestamp);

    const effSize = comparison.effectSizes.find((e) => e.metric === 'efficiency');
    expect(effSize).toBeDefined();
    expect(Math.abs(effSize!.cohensD)).toBeLessThan(0.2);
    expect(effSize!.label).toBe('noise');
  });

  // -------------------------------------------------------------------------
  // 4. Zero-variance Cohen's d (pooled SD = 0)
  // -------------------------------------------------------------------------

  it('compareClaudeMdVersions labels zero-variance groups as noise (not Infinity)', () => {
    const { engine } = createEngine();
    const changeTimestamp = Date.now();

    // All sessions have identical efficiency scores — pooled SD = 0
    for (let i = 0; i < 3; i++) {
      store.saveSession(makeSummary({
        sessionId: `before-${i}`,
        startTime: changeTimestamp - 86_400_000 * (i + 1),
        efficiencyScore: 0.5,
      }));
    }
    for (let i = 0; i < 3; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: 0.9,
      }));
    }

    const comparison = engine.compareClaudeMdVersions(changeTimestamp);

    const effSize = comparison.effectSizes.find((e) => e.metric === 'efficiency');
    expect(effSize).toBeDefined();
    expect(Number.isFinite(effSize!.cohensD)).toBe(true);
    expect(effSize!.cohensD).toBe(0);
    expect(effSize!.label).toBe('noise');
  });

  // -------------------------------------------------------------------------
  // 5. Recommendation: high correction rate
  // -------------------------------------------------------------------------

  it('recommends more context for developer with high correction rate', () => {
    const { engine } = createEngine();

    // Developer with correctionRate dimension = 0.65 → 1 - 0.65 = 0.35 > 0.3
    // correctionRate = 1 - corrections/messages → 0.65 means corrections = 0.35 * messages
    // Need: userCorrections / userMessages = 0.35 → 35% corrections
    store.saveSession(makeSummary({
      sessionId: 's1',
      userMessages: 20,
      userCorrections: 7,
      toolCallCount: 10,
    }));

    const recommendations = engine.generatePromptRecommendations('alice');

    const contextRec = recommendations.find((r) => r.category === 'prompt_context');
    expect(contextRec).toBeDefined();
    expect(contextRec!.priority).toBe('high');
    expect(contextRec!.message).toContain('context');
    expect(contextRec!.evidence).toMatch(/\d+%/);
  });

  // -------------------------------------------------------------------------
  // 5. Recommendation: high complexity + low autonomy → /plan
  // -------------------------------------------------------------------------

  it('recommends /plan mode for high complexity + low autonomy', () => {
    const { engine } = createEngine();

    // High task complexity: many files, many tool calls, some agents per task
    // taskComplexity composite = (avgFiles/20 + avgToolCalls/50 + avgAgents/3) / 3
    // e.g. 15 files/task + 40 toolCalls/task + 2 agents/task
    // = (15/20 + 40/50 + 2/3) / 3 = (0.75 + 0.8 + 0.667) / 3 = 0.739 ≥ 0.5 ✓
    //
    // Low autonomy: toolCalls / assistantMessages / 5 < 0.5 → need assistantMessages > toolCalls/2.5
    // e.g. 40 toolCalls / 25 assistantMessages / 5 = 0.32 < 0.5 ✓
    store.saveSession(makeSummary({
      sessionId: 's1',
      filesRead: Array.from({ length: 10 }, (_, i) => `/f${i}.ts`),
      filesModified: Array.from({ length: 5 }, (_, i) => `/m${i}.ts`),
      toolCallCount: 40,
      agentSpawns: 2,
      taskCount: 1,
      userMessages: 10,
      assistantMessages: 25,
    }));

    const recommendations = engine.generatePromptRecommendations('alice');

    const planRec = recommendations.find((r) => r.category === 'plan_mode');
    expect(planRec).toBeDefined();
    expect(planRec!.priority).toBe('medium');
    expect(planRec!.message).toContain('/plan');
  });

  // -------------------------------------------------------------------------
  // 6. Recommendation: poor read efficiency (re_reading anti-pattern)
  // -------------------------------------------------------------------------

  it('recommends file paths for sessions with frequent re-reading', () => {
    const { engine } = createEngine();

    // > 50% of sessions have re_reading anti-pattern
    for (let i = 0; i < 4; i++) {
      store.saveSession(makeSummary({
        sessionId: `rr-${i}`,
        antiPatterns: [{ type: 're_reading', count: 3 }],
      }));
    }
    // 1 session without
    store.saveSession(makeSummary({
      sessionId: 'clean-1',
      antiPatterns: [],
    }));

    const recommendations = engine.generatePromptRecommendations('alice');

    const fpRec = recommendations.find((r) => r.category === 'file_paths');
    expect(fpRec).toBeDefined();
    expect(fpRec!.priority).toBe('medium');
    expect(fpRec!.message).toContain('re-read');
    expect(fpRec!.evidence).toMatch(/\d+%/);
  });

  // -------------------------------------------------------------------------
  // 7. Recommendation: negative CLAUDE.md impact
  // -------------------------------------------------------------------------

  it('recommends reverting CLAUDE.md change when impact is negative', () => {
    const { tracker, engine } = createEngine();
    const changeTimestamp = Date.now();

    // Record a CLAUDE.md change
    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 100,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // Sessions before: good metrics
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `before-${i}`,
        startTime: changeTimestamp - 86_400_000 * (i + 1),
        efficiencyScore: 0.8,
        estimatedCostUsd: 2,
        taskSuccessRate: 0.9,
        userMessages: 10,
        userCorrections: 1,
        toolCallCount: 10,
        taskCount: 2,
      }));
    }

    // Sessions after: degraded metrics
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: 0.4,
        estimatedCostUsd: 6,
        taskSuccessRate: 0.5,
        userMessages: 10,
        userCorrections: 5,
        toolCallCount: 30,
        taskCount: 2,
      }));
    }

    const recommendations = engine.generatePromptRecommendations('alice');

    const claudeRec = recommendations.find((r) => r.category === 'claudemd_impact');
    expect(claudeRec).toBeDefined();
    expect(claudeRec!.priority).toBe('high');
    expect(claudeRec!.message).toContain('CLAUDE.md');
  });

  // -------------------------------------------------------------------------
  // 8. Priority sorting
  // -------------------------------------------------------------------------

  it('recommendations are sorted by priority: high before medium before low', () => {
    const { tracker, engine } = createEngine();
    const changeTimestamp = Date.now();

    // Trigger both high-priority (correction rate) and medium-priority (re-reading) rules
    for (let i = 0; i < 4; i++) {
      store.saveSession(makeSummary({
        sessionId: `s-${i}`,
        userMessages: 20,
        userCorrections: 8,
        antiPatterns: [{ type: 're_reading', count: 2 }],
      }));
    }
    store.saveSession(makeSummary({
      sessionId: 's-clean',
      userMessages: 20,
      userCorrections: 8,
      antiPatterns: [{ type: 're_reading', count: 1 }],
    }));

    const recommendations = engine.generatePromptRecommendations('alice');

    expect(recommendations.length).toBeGreaterThanOrEqual(2);

    // Find the indices
    const highIdx = recommendations.findIndex((r) => r.priority === 'high');
    const mediumIdx = recommendations.findIndex((r) => r.priority === 'medium');

    if (highIdx !== -1 && mediumIdx !== -1) {
      expect(highIdx).toBeLessThan(mediumIdx);
    }
  });

  // -------------------------------------------------------------------------
  // 9. Evidence includes actual numbers
  // -------------------------------------------------------------------------

  it('each recommendation evidence string contains numeric values', () => {
    const { engine } = createEngine();

    // High correction rate → generates recommendation with numbers
    store.saveSession(makeSummary({
      sessionId: 's1',
      userMessages: 20,
      userCorrections: 8,
    }));

    const recommendations = engine.generatePromptRecommendations('alice');

    expect(recommendations.length).toBeGreaterThan(0);
    for (const rec of recommendations) {
      expect(rec.evidence).toBeTruthy();
      expect(rec.evidence).toMatch(/\d/);
    }
  });

  // -------------------------------------------------------------------------
  // 10. emitMetrics
  // -------------------------------------------------------------------------

  it('emitMetrics emits ai.prompt_recommendation events with correct attributes', () => {
    const { engine } = createEngine();

    // Generate a recommendation
    store.saveSession(makeSummary({
      sessionId: 's1',
      userMessages: 20,
      userCorrections: 8,
    }));

    const recorded: Array<{ name: string; value: number; attrs?: Record<string, string | number> }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    engine.emitMetrics(aggregator, 'alice');

    expect(recorded.length).toBeGreaterThan(0);

    for (const r of recorded) {
      expect(r.name).toBe('ai.prompt_recommendation');
      expect(r.attrs?.developer).toBe('alice');
      expect(r.attrs?.category).toBeTruthy();
      expect(r.attrs?.priority).toBeTruthy();
    }
  });
});

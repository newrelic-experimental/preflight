import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { getWeekDateRange } from '../storage/weekly-summary.js';
import { CollaborationProfiler } from './collaboration-profile.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-collab-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('CollaborationProfiler', () => {
  // -------------------------------------------------------------------------
  // 1. High specificity + high autonomy
  // -------------------------------------------------------------------------

  it('high toolCall/userMessage ratio + high toolCall/assistantMessage ratio → high specificity + high autonomy', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // specificity: 20 tool calls / 3 user messages = ratio 6.67, normalized: 6.67/10 ≈ 0.667
    // autonomy: 20 tool calls / 4 assistant messages = 5.0, normalized: 5/5 = 1.0
    store.saveSession(makeSummary({
      sessionId: 's1',
      toolCallCount: 20,
      userMessages: 3,
      assistantMessages: 4,
      userCorrections: 0,
    }));

    const profile = profiler.computeProfile('alice');

    expect(profile.dimensions.specificity).toBeCloseTo(0.667, 2);
    expect(profile.dimensions.autonomy).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Low specificity + low correction rate
  // -------------------------------------------------------------------------

  it('low toolCall/userMessage ratio + high corrections → low specificity + low correctionRate', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // 5 tool calls / 4 user messages = ratio 1.25, normalized: 1.25/10 = 0.125
    // 3 corrections / 4 messages → correctionRate = 1 - 3/4 = 0.25
    store.saveSession(makeSummary({
      sessionId: 's1',
      toolCallCount: 5,
      userMessages: 4,
      userCorrections: 3,
    }));

    const profile = profiler.computeProfile('alice');

    expect(profile.dimensions.specificity).toBe(0.125);
    expect(profile.dimensions.correctionRate).toBe(0.25);
  });

  // -------------------------------------------------------------------------
  // 3. Task complexity
  // -------------------------------------------------------------------------

  it('task complexity scales with files touched and agent spawns', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // Low complexity: 2 files, 10 tool calls, 0 agents, 1 task
    store.saveSession(makeSummary({
      sessionId: 'low',
      filesRead: ['/a.ts'],
      filesModified: ['/b.ts'],
      toolCallCount: 10,
      agentSpawns: 0,
      taskCount: 1,
    }));

    const lowProfile = profiler.computeProfile('alice');
    const lowComplexity = lowProfile.dimensions.taskComplexity;

    // Clean up and create high-complexity session
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
    store = new SessionStore({ storagePath: tmpDir });

    // High complexity: 15 files, 40 tool calls, 2 agents, 1 task
    const manyFiles = Array.from({ length: 10 }, (_, i) => `/f${i}.ts`);
    store.saveSession(makeSummary({
      sessionId: 'high',
      filesRead: manyFiles,
      filesModified: manyFiles.slice(0, 5),
      toolCallCount: 40,
      agentSpawns: 2,
      taskCount: 1,
    }));

    const highProfiler = new CollaborationProfiler({ sessionStore: store });
    const highProfile = highProfiler.computeProfile('alice');
    const highComplexity = highProfile.dimensions.taskComplexity;

    expect(highComplexity).toBeGreaterThan(lowComplexity);
    expect(highComplexity).toBeGreaterThan(0);
    expect(highComplexity).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 4. Classification logic — all four labels
  // -------------------------------------------------------------------------

  it('classification produces all four labels based on dimension thresholds', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // Power User: high specificity (≥0.6) + high autonomy (≥0.6)
    // specificity: 60/10/10 = 0.6
    // autonomy: 60 toolCalls / 10 assistantMessages / 5 = 1.0 (clamped)
    store.saveSession(makeSummary({
      sessionId: 'power',
      developer: 'power-user',
      toolCallCount: 60,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 0,
    }));
    expect(profiler.computeProfile('power-user').classification).toBe('Power User');

    // Delegator: low specificity (<0.6) + high autonomy (≥0.6)
    // specificity: 15/10/10 = 0.15
    // autonomy: 15 toolCalls / 5 assistantMessages / 5 = 0.6
    store.saveSession(makeSummary({
      sessionId: 'delegator',
      developer: 'delegator-user',
      toolCallCount: 15,
      userMessages: 10,
      assistantMessages: 5,
      userCorrections: 1,
    }));
    expect(profiler.computeProfile('delegator-user').classification).toBe('Delegator');

    // Learning: low specificity (<0.6) + low autonomy (<0.6) + correctionRate < 0.6
    // specificity: 5/10/10 = 0.05
    // correctionRate: 1 - 8/10 = 0.2
    // autonomy: 5/10/5 = 0.1 (<0.6)
    store.saveSession(makeSummary({
      sessionId: 'learning',
      developer: 'learning-user',
      toolCallCount: 5,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 8,
    }));
    expect(profiler.computeProfile('learning-user').classification).toBe('Learning');

    // Collaborative: low specificity + low autonomy + correctionRate ≥ 0.6
    // specificity: 5/10/10 = 0.05 (<0.6)
    // autonomy: 5 toolCalls / 10 assistantMessages / 5 = 0.1 (<0.6)
    // correctionRate: 1 - 1/10 = 0.9 (≥0.6) — few corrections but low autonomy
    store.saveSession(makeSummary({
      sessionId: 'collab',
      developer: 'collab-user',
      toolCallCount: 5,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 1,
    }));
    expect(profiler.computeProfile('collab-user').classification).toBe('Collaborative');
  });

  it('classify() requires low autonomy for Learning — near-threshold autonomy with low correction still needs autonomy < 0.6', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // specificity: 5/10/10 = 0.05 (<0.6)
    // autonomy: 5 toolCalls / 5 assistantMessages / 5 = 0.2 (<0.6) — low enough for Learning
    // correctionRate: 1 - 4/10 = 0.6 — at threshold, NOT < 0.6, so should be Collaborative
    store.saveSession(makeSummary({
      sessionId: 'boundary',
      developer: 'boundary-user',
      toolCallCount: 5,
      userMessages: 10,
      assistantMessages: 5,
      userCorrections: 4,
    }));
    expect(profiler.computeProfile('boundary-user').classification).toBe('Collaborative');

    // Verify Learning still fires when all three conditions are met:
    // specificity: 5/10/10 = 0.05, autonomy: 5/5/5 = 0.2, correctionRate: 1 - 7/10 = 0.3
    store.saveSession(makeSummary({
      sessionId: 'learning2',
      developer: 'learning2-user',
      toolCallCount: 5,
      userMessages: 10,
      assistantMessages: 5,
      userCorrections: 7,
    }));
    expect(profiler.computeProfile('learning2-user').classification).toBe('Learning');
  });

  // -------------------------------------------------------------------------
  // 5. computeTeamBaseline
  // -------------------------------------------------------------------------

  it('computeTeamBaseline averages across 3 developers correctly', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // Alice: specificity = 60/10/10 = 0.6, autonomy = 60/10/5 = 1.0 (clamped)
    store.saveSession(makeSummary({
      sessionId: 'a1',
      developer: 'alice',
      toolCallCount: 60,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 0,
    }));

    // Bob: specificity = 30/10/10 = 0.3, autonomy = 30/10/5 = 0.6
    store.saveSession(makeSummary({
      sessionId: 'b1',
      developer: 'bob',
      toolCallCount: 30,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 0,
    }));

    // Charlie: specificity = 90/10/10 = 0.9, autonomy = 90/10/5 = 1.0 (clamped)
    store.saveSession(makeSummary({
      sessionId: 'c1',
      developer: 'charlie',
      toolCallCount: 90,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 0,
    }));

    const baseline = profiler.computeTeamBaseline();

    expect(baseline.developerCount).toBe(3);
    expect(baseline.sessionCount).toBe(3);
    // Team specificity: (0.6 + 0.3 + 0.9) / 3 = 0.6
    expect(baseline.dimensions.specificity).toBe(0.6);
    // Team autonomy: (1.0 + 0.6 + 1.0) / 3 ≈ 0.867
    expect(baseline.dimensions.autonomy).toBeCloseTo(0.867, 2);
  });

  // -------------------------------------------------------------------------
  // 6. compareToTeam — deltas
  // -------------------------------------------------------------------------

  it('compareToTeam produces correct delta values for each dimension', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // Alice: specificity = 60/10/10 = 0.6, autonomy = 60/5/5 = 1.0 (clamped)
    store.saveSession(makeSummary({
      sessionId: 'a1',
      developer: 'alice',
      toolCallCount: 60,
      userMessages: 10,
      assistantMessages: 5,
      userCorrections: 0,
    }));

    // Bob: specificity = 30/10/10 = 0.3, autonomy = 30/10/5 = 0.6
    store.saveSession(makeSummary({
      sessionId: 'b1',
      developer: 'bob',
      toolCallCount: 30,
      userMessages: 10,
      assistantMessages: 10,
      userCorrections: 5,
    }));

    const comparison = profiler.compareToTeam('alice');

    expect(comparison.developer).toBe('alice');
    // Alice specificity: 0.6, team avg: (0.6 + 0.3)/2 = 0.45
    expect(comparison.developerDimensions.specificity).toBe(0.6);
    expect(comparison.teamDimensions.specificity).toBe(0.45);
    expect(comparison.deltas.specificity).toBe(0.15);

    // Alice autonomy: 1.0, Bob autonomy: 0.6, team avg: (1.0 + 0.6)/2 = 0.8
    expect(comparison.developerDimensions.autonomy).toBe(1);
    expect(comparison.teamDimensions.autonomy).toBe(0.8);
    expect(comparison.deltas.autonomy).toBe(0.2);
  });

  // -------------------------------------------------------------------------
  // 7. Weekly profile evolution
  // -------------------------------------------------------------------------

  it('weekly profiles show trend over 4 weeks', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    const weeks = ['2026-W13', '2026-W14', '2026-W15', '2026-W16'];
    const toolCounts = [10, 20, 30, 60];

    for (let i = 0; i < weeks.length; i++) {
      const { start } = getWeekDateRange(weeks[i]!);
      store.saveSession(makeSummary({
        sessionId: `s-w${i}`,
        startTime: start.getTime() + 43_200_000,
        toolCallCount: toolCounts[i]!,
        userMessages: 10,
        userCorrections: 0,
      }));
    }

    const profile = profiler.computeProfile('alice');

    expect(profile.weeklyProfiles).toHaveLength(4);
    expect(profile.weeklyProfiles.map((wp) => wp.week)).toEqual(weeks);

    // Specificity should increase: 10/10/10=0.1, 20/10/10=0.2, 30/10/10=0.3, 60/10/10=0.6
    const specificities = profile.weeklyProfiles.map((wp) => wp.dimensions.specificity);
    expect(specificities).toEqual([0.1, 0.2, 0.3, 0.6]);
  });

  // -------------------------------------------------------------------------
  // 8. Normalization — all dimensions clamp to [0, 1]
  // -------------------------------------------------------------------------

  it('all dimensions clamp to [0, 1] with extreme values', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    // Extreme values:
    // specificity: 1000/1/10 = 100 → clamped to 1
    // autonomy: 1000 toolCalls / 1 assistantMessage / 5 = 200 → clamped to 1
    // correctionRate: 1 - 100/1 = -99 → clamped to 0
    store.saveSession(makeSummary({
      sessionId: 's-extreme',
      toolCallCount: 1000,
      userMessages: 1,
      assistantMessages: 1,
      userCorrections: 100,
      filesRead: Array.from({ length: 100 }, (_, i) => `/f${i}.ts`),
      filesModified: Array.from({ length: 100 }, (_, i) => `/m${i}.ts`),
      agentSpawns: 50,
      taskCount: 1,
    }));

    const profile = profiler.computeProfile('alice');

    expect(profile.dimensions.specificity).toBe(1);
    expect(profile.dimensions.autonomy).toBe(1);
    expect(profile.dimensions.correctionRate).toBe(0);
    expect(profile.dimensions.taskComplexity).toBe(1);

    // All in [0, 1]
    for (const dim of Object.values(profile.dimensions)) {
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // 9. emitMetrics
  // -------------------------------------------------------------------------

  it('emitMetrics emits all dimension scores with developer attribute', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    store.saveSession(makeSummary({
      sessionId: 'emit-alice',
      developer: 'alice',
      toolCallCount: 60,
      userMessages: 10,
      userCorrections: 1,
    }));
    store.saveSession(makeSummary({
      sessionId: 'emit-bob',
      developer: 'bob',
      toolCallCount: 20,
      userMessages: 5,
      userCorrections: 2,
    }));

    const recorded: Array<{ name: string; value: number; attrs?: Record<string, string | number> }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    profiler.emitMetrics(aggregator);

    const metricNames = recorded.map((r) => r.name);
    expect(metricNames).toContain('ai.collaboration.specificity');
    expect(metricNames).toContain('ai.collaboration.autonomy');
    expect(metricNames).toContain('ai.collaboration.correction_rate');
    expect(metricNames).toContain('ai.collaboration.task_complexity');

    // Both developers should be represented
    const developers = recorded.map((r) => r.attrs?.developer);
    expect(developers).toContain('alice');
    expect(developers).toContain('bob');

    // All values in [0, 1]
    for (const r of recorded) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // 9. Neutral autonomy for zero-message sessions
  // -------------------------------------------------------------------------

  it('returns 0.5 autonomy for sessions with zero assistant messages', () => {
    const profiler = new CollaborationProfiler({ sessionStore: store });

    store.saveSession(makeSummary({
      sessionId: 's1',
      toolCallCount: 50,
      userMessages: 0,
      assistantMessages: 0,
      userCorrections: 0,
    }));

    const profile = profiler.computeProfile('alice');

    expect(profile.dimensions.autonomy).toBe(0.5);
    expect(profile.dimensions.specificity).toBe(0.5);
  });
});

import { describe, it, expect } from '@jest/globals';
import { FirstSaveBaselines, costSeedOf, toolCallSeedOf } from './first-save-baselines.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: 'sess-a',
    sessionName: null,
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    model: null,
    toolBreakdown: {},
    skillBreakdown: {},
    filesRead: [],
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandCount: 0,
    testRunCount: 0,
    testPassCount: 0,
    buildRunCount: 0,
    buildPassCount: 0,
    estimatedCostUsd: 1,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: null,
    toolSelectionMetrics: null,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
    antiPatterns: [],
    taskCount: 0,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

describe('FirstSaveBaselines', () => {
  const beforeSave = makeSummary({ toolCallCount: 2, estimatedCostUsd: 0.4 });
  const current = makeSummary({ toolCallCount: 6, estimatedCostUsd: 1.4 });

  it('seeds both families from the current file when this process saved nothing', () => {
    const seeds = new FirstSaveBaselines().take('sess-a', () => current);
    expect(seeds).toEqual({ toolCalls: toolCallSeedOf(current), cost: costSeedOf(current) });
  });

  it('seeds tool calls from before a rollup save and cost from the current file', () => {
    const baselines = new FirstSaveBaselines();
    baselines.recordSave({ sessionId: 'sess-a', previous: beforeSave, ownSession: false });

    const seeds = baselines.take('sess-a', () => current);

    expect(seeds).toEqual({ toolCalls: toolCallSeedOf(beforeSave), cost: costSeedOf(current) });
  });

  it('seeds both families from before the first save of its own summary', () => {
    const baselines = new FirstSaveBaselines();
    baselines.recordSave({ sessionId: 'sess-a', previous: beforeSave, ownSession: true });
    baselines.recordSave({ sessionId: 'sess-a', previous: current, ownSession: true });

    const seeds = baselines.take('sess-a', () => current);

    expect(seeds).toEqual({ toolCalls: toolCallSeedOf(beforeSave), cost: costSeedOf(beforeSave) });
  });

  it('seeds cost from before its own first save when a rollup save came earlier', () => {
    const baselines = new FirstSaveBaselines();
    const afterRollup = makeSummary({ toolCallCount: 4, estimatedCostUsd: 0.9 });
    baselines.recordSave({ sessionId: 'sess-a', previous: beforeSave, ownSession: false });
    baselines.recordSave({ sessionId: 'sess-a', previous: afterRollup, ownSession: true });

    const seeds = baselines.take('sess-a', () => current);

    expect(seeds).toEqual({ toolCalls: toolCallSeedOf(beforeSave), cost: costSeedOf(afterRollup) });
  });

  it('seeds nothing for a family whose first save created the file', () => {
    const baselines = new FirstSaveBaselines();
    baselines.recordSave({ sessionId: 'sess-a', previous: null, ownSession: false });

    expect(baselines.take('sess-a', () => current)).toEqual({
      toolCalls: null,
      cost: costSeedOf(current),
    });
  });

  it("keeps another session's snapshot when one session is taken", () => {
    const baselines = new FirstSaveBaselines();
    const beforeB = makeSummary({ sessionId: 'sess-b', toolCallCount: 3 });
    baselines.recordSave({ sessionId: 'sess-a', previous: beforeSave, ownSession: false });
    baselines.recordSave({ sessionId: 'sess-b', previous: beforeB, ownSession: false });

    baselines.take('sess-a', () => current);
    const seedsB = baselines.take('sess-b', () => current);

    expect(seedsB.toolCalls).toEqual(toolCallSeedOf(beforeB));
  });

  it('forgets a session once taken', () => {
    const baselines = new FirstSaveBaselines();
    baselines.recordSave({ sessionId: 'sess-a', previous: beforeSave, ownSession: true });
    baselines.take('sess-a', () => current);

    expect(baselines.take('sess-a', () => current)).toEqual({
      toolCalls: toolCallSeedOf(current),
      cost: costSeedOf(current),
    });
  });
});

describe('costSeedOf', () => {
  it('carries the prior spend the budget thresholds seed from', () => {
    const seed = costSeedOf(makeSummary({ estimatedCostUsd: 6 }));
    expect(seed.estimatedCostUsd).toBe(6);
    expect(seed.costTracker.totalCostUsd).toBe(6);
  });
});

describe('toolCallSeedOf', () => {
  it('keeps the efficiency score only when it has samples', () => {
    const components = { speed: 50, correctness: 60, autonomy: 70, firstAttemptQuality: 80 };
    const scored = makeSummary({
      efficiencyScore: 60,
      efficiencyScoreComponents: components,
      efficiencyScoreSampleCount: 3,
    });

    expect(toolCallSeedOf(scored).efficiency).toEqual({ score: 60, components, sampleCount: 3 });
    expect(toolCallSeedOf({ ...scored, efficiencyScoreSampleCount: 0 }).efficiency).toBeNull();
  });
});

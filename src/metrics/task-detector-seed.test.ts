import { describe, it, expect } from '@jest/globals';
import { buildTaskDetectorSeed } from './task-detector-seed.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';

function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}`,
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
    filesRead: ['/src/a.ts', '/src/b.ts'],
    filesModified: ['/src/a.ts'],
    linesAdded: 20,
    linesRemoved: 5,
    bashCommandCount: 0,
    testRunCount: 3,
    testPassCount: 2,
    buildRunCount: 1,
    buildPassCount: 1,
    estimatedCostUsd: 1.5,
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
    taskCount: 4,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 2,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
    ...overrides,
  };
}

describe('buildTaskDetectorSeed', () => {
  it('maps every relevant FullSessionSummary field onto the seed', () => {
    const seed = buildTaskDetectorSeed(makeSummary());
    expect(seed.filesRead).toEqual(['/src/a.ts', '/src/b.ts']);
    expect(seed.filesModified).toEqual(['/src/a.ts']);
    expect(seed.linesAdded).toBe(20);
    expect(seed.linesRemoved).toBe(5);
    expect(seed.testsRun).toBe(3);
    expect(seed.testsPassed).toBe(2);
    expect(seed.buildRun).toBe(1);
    expect(seed.buildPassed).toBe(1);
    expect(seed.agentSpawns).toBe(2);
    expect(seed.taskCount).toBe(4);
  });

  it('produces an all-zero/empty seed for a session with no task activity', () => {
    const seed = buildTaskDetectorSeed(
      makeSummary({
        filesRead: [],
        filesModified: [],
        linesAdded: 0,
        linesRemoved: 0,
        testRunCount: 0,
        testPassCount: 0,
        buildRunCount: 0,
        buildPassCount: 0,
        agentSpawns: 0,
        taskCount: 0,
      }),
    );
    expect(seed.filesRead).toEqual([]);
    expect(seed.taskCount).toBe(0);
  });
});

import { describe, it, expect } from '@jest/globals';
import { buildContribution, type FullSessionSummary } from './session-store.js';
import { foldWriterContributions, type WriterContribution } from './session-writers.js';
import type { ToolCallRecord } from './types.js';
import type { TokenUsage } from '../core/index.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { EfficiencyScorer } from '../metrics/efficiency-score.js';
import { costSeedOf, toolCallSeedOf } from '../metrics/first-save-baselines.js';
import { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import { TaskDetector } from '../metrics/task-detector.js';

const SID = 'sess-contrib';
const MODEL = 'claude-sonnet-4-5-20250929';
let nextId = 0;

/** One process's trackers, wired as the engine wires them. */
function writer() {
  const sessionTracker = new SessionTracker(SID, 100);
  const costTracker = new CostTracker(sessionTracker);
  const modelUsageTracker = new ModelUsageTracker();
  const taskDetector = new TaskDetector();
  const efficiencyScorer = new EfficiencyScorer();
  const qualityProxyTracker = new QualityProxyTracker();
  const sources = {
    sessionTracker,
    costTracker,
    modelUsageTracker,
    taskDetector,
    efficiencyScorer,
    qualityProxyTracker,
    developer: 'dev',
  };
  return {
    sources,
    call(toolName: string, toolUseId: string, extra: Partial<ToolCallRecord> = {}) {
      const record: ToolCallRecord = {
        id: `${toolUseId}-${++nextId}`,
        sessionId: SID,
        toolName,
        toolUseId,
        timestamp: Date.now(),
        durationMs: 5,
        success: true,
        ...extra,
      };
      sessionTracker.recordToolCall(record);
      taskDetector.recordToolCall(record);
      qualityProxyTracker.recordToolCall(record);
    },
    /** Closes the active task, as a question to the user does, and scores it. */
    endTask() {
      this.call('AskUserQuestion', `ask-${++nextId}`);
      const tasks = taskDetector.getCompletedTasks();
      efficiencyScorer.computeScore(tasks[tasks.length - 1]!);
    },
    turn(inputTokens: number, outputTokens: number, replacesEstimates = false) {
      const usage: TokenUsage = {
        inputTokens,
        outputTokens,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + outputTokens,
      };
      const breakdown = costTracker.recordTokenUsage(usage, MODEL, { replacesEstimates });
      modelUsageTracker.recordUsage(MODEL, usage, breakdown.totalUsd);
    },
    estimate(chars: number) {
      costTracker.recordEstimatedTokens(chars, chars / 4, MODEL);
    },
    /** Seeds every tracker from the saved session, as a restarted engine does. */
    resume(saved: FullSessionSummary) {
      const calls = toolCallSeedOf(saved);
      const cost = costSeedOf(saved);
      sessionTracker.seedFromPersisted(calls.sessionTracker);
      qualityProxyTracker.seedFromPersisted(calls.qualityProxy);
      taskDetector.seedFromPersisted(calls.taskDetector);
      if (calls.efficiency) efficiencyScorer.seedFromPersisted(calls.efficiency);
      costTracker.seedFromPersisted(cost.costTracker);
      modelUsageTracker.seedFromPersisted(cost.modelBreakdown);
    },
    contribution: (): WriterContribution => buildContribution(sources),
  };
}

const fold = (...parts: WriterContribution[]) =>
  foldWriterContributions(parts as [WriterContribution, ...WriterContribution[]]);

const round = (x: number) => Math.round(x * 1e9) / 1e9;

/** The fields a session sums across writers. */
function totals(s: FullSessionSummary) {
  const model = s.modelBreakdown[MODEL];
  return {
    toolCallCount: s.toolCallCount,
    toolBreakdown: s.toolBreakdown,
    bashCommandCount: s.bashCommandCount,
    estimatedCostUsd: round(s.estimatedCostUsd ?? 0),
    tokensInput: s.tokensInput,
    tokensOutput: s.tokensOutput,
    modelRequests: model?.requestCount ?? 0,
    modelInputTokens: model?.totalInputTokens ?? 0,
    linesAdded: s.linesAdded,
    testRunCount: s.testRunCount,
    taskCount: s.taskCount,
    qualityProxy: s.qualityProxy,
    efficiencyScoreSampleCount: s.efficiencyScoreSampleCount,
    filesModified: [...s.filesModified].sort(),
  };
}

/** Writer A's work, then one task of writer B's, replayable on a single writer as the truth. */
function firstWork(w: ReturnType<typeof writer>) {
  w.call('Edit', 'a-edit', { filePath: '/src/a.ts', newLineCount: 4, oldLineCount: 1 });
  w.call('Bash', 'a-test', { isTestCommand: true, success: false });
  w.call('Bash', 'shared-call', { durationMs: null, success: false, errorType: 'timeout' });
  w.endTask();
  w.turn(10_000, 2_000);
}
function laterWork(w: ReturnType<typeof writer>) {
  w.call('Edit', 'b-edit', { filePath: '/src/b.ts', newLineCount: 7, oldLineCount: 0 });
  w.call('Bash', 'b-test', { isTestCommand: true });
  w.endTask();
  w.turn(4_000, 500);
}

describe('buildContribution', () => {
  it('counts a call a seed already holds, so the fold counts it once', () => {
    const a = writer();
    a.call('Read', 'call-1');
    a.call('Bash', 'shared-call', { durationMs: null, success: false, errorType: 'timeout' });
    const first = a.contribution();

    const b = writer();
    b.resume(fold(first));
    b.call('Bash', 'shared-call');
    b.call('Grep', 'call-2');
    const own = b.contribution().summary;

    expect(b.sources.sessionTracker.getMetrics().toolCallCount).toBe(3);
    expect(own).toMatchObject({
      toolCallCount: 2,
      toolBreakdown: { Bash: 1, Grep: 1 },
      bashCommandCount: 1,
      toolSuccessRate: 1,
    });
    expect(fold(first, b.contribution())).toMatchObject({
      toolCallCount: 3,
      toolBreakdown: { Read: 1, Bash: 1, Grep: 1 },
      bashCommandCount: 1,
    });
  });

  it('amends the outcome of a repeated seeded call in its own share', () => {
    const a = writer();
    a.call('Bash', 'shared-call');
    const b = writer();
    b.resume(fold(a.contribution()));
    b.call('Bash', 'shared-call', {
      id: 'late',
      durationMs: null,
      success: false,
      errorType: 'timeout',
    });
    b.sources.sessionTracker.amendToolCall({
      id: 'late',
      sessionId: SID,
      toolName: 'Bash',
      toolUseId: 'shared-call',
      timestamp: Date.now(),
      durationMs: 40,
      success: true,
    });

    expect(b.contribution().summary).toMatchObject({ toolCallCount: 1, toolSuccessRate: 1 });
  });

  it('leaves out every seed, so writers sharing one fold to what one writer doing all the work saves', () => {
    const a = writer();
    firstWork(a);
    const first = a.contribution();
    const restarted = [writer(), writer()];
    for (const w of restarted) {
      w.resume(fold(first));
      w.call('Bash', 'shared-call');
    }
    laterWork(restarted[0]!);
    restarted[1]!.call('Edit', 'c-edit', { filePath: '/src/c.ts', newLineCount: 2 });
    restarted[1]!.endTask();
    restarted[1]!.turn(1_000, 100);

    const truth = writer();
    firstWork(truth);
    truth.call('Bash', 'shared-call');
    laterWork(truth);
    truth.call('Edit', 'c-edit', { filePath: '/src/c.ts', newLineCount: 2 });
    truth.endTask();
    truth.turn(1_000, 100);

    const folded = fold(first, ...restarted.map((w) => w.contribution()));
    expect(totals(folded)).toEqual(totals(truth.contribution().summary));
    expect(folded.efficiencyScore).toBeCloseTo(truth.contribution().summary.efficiencyScore!, 2);
    expect(restarted[0]!.contribution().summary).toMatchObject({
      taskCount: 1,
      linesAdded: 7,
      efficiencyScoreSampleCount: 1,
    });
  });

  it('retracts once a real report replaces estimates it seeded, which drops every estimate', () => {
    const a = writer();
    a.turn(1_000, 100);
    a.estimate(40_000);
    const first = a.contribution();
    const b = writer();
    b.resume(fold(first));
    b.turn(2_000, 200, true);

    const exactOnly = writer();
    exactOnly.turn(1_000, 100);
    exactOnly.turn(2_000, 200, true);
    expect(first.retracted).toBe(false);
    expect(b.contribution().retracted).toBe(true);
    expect(round(fold(first, b.contribution()).estimatedCostUsd!)).toBe(
      round(exactOnly.contribution().summary.estimatedCostUsd!),
    );
  });

  it('does not retract when it held no estimates to replace', () => {
    const b = writer();
    b.turn(2_000, 200, true);

    expect(b.contribution().retracted).toBe(false);
  });
});

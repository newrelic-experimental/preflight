import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';
import { ClaudeMdTracker } from './claudemd-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-claudemd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    userMessages: 0,
    assistantMessages: 0,
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

describe('ClaudeMdTracker', () => {
  // -------------------------------------------------------------------------
  // 1. Write to CLAUDE.md triggers change event
  // -------------------------------------------------------------------------

  it('Write to CLAUDE.md triggers ClaudeMdChange with correct metadata', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    const toolCall = makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 50,
      contentLength: 2000,
    } as Partial<ToolCallRecord>);

    const change = tracker.detectChange(toolCall);

    expect(change).not.toBeNull();
    expect(change!.changeType).toBe('created');
    expect(change!.filePath).toBe('/project/CLAUDE.md');
    expect(change!.linesAdded).toBe(50);
    expect(change!.linesRemoved).toBe(0);
    expect(change!.diffSummary).toContain('created');
    expect(change!.diffSummary).toContain('/project/CLAUDE.md');
  });

  // -------------------------------------------------------------------------
  // 2. Edit to .claude/settings.json triggers change event
  // -------------------------------------------------------------------------

  it('Edit to .claude/settings.json triggers change event with modified type', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    const toolCall = makeToolCall({
      toolName: 'Edit',
      filePath: '/project/.claude/settings.json',
      oldLineCount: 5,
      newLineCount: 8,
      isDelete: false,
    } as Partial<ToolCallRecord>);

    const change = tracker.detectChange(toolCall);

    expect(change).not.toBeNull();
    expect(change!.changeType).toBe('modified');
    expect(change!.filePath).toBe('/project/.claude/settings.json');
    expect(change!.linesAdded).toBe(8);
    expect(change!.linesRemoved).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 3. Hash comparison detects between-session changes
  // -------------------------------------------------------------------------

  it('detectBetweenSessionChange returns true for different hashes', () => {
    expect(ClaudeMdTracker.detectBetweenSessionChange('abc123', 'def456')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Hash comparison detects no change
  // -------------------------------------------------------------------------

  it('detectBetweenSessionChange returns false for identical hashes', () => {
    expect(ClaudeMdTracker.detectBetweenSessionChange('abc123', 'abc123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. computeImpact — positive impact
  // -------------------------------------------------------------------------

  it('computeImpact returns correct deltas and Positive impact verdict', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    // Record a change so the tracker has context for the report
    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 30,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // 5 sessions before: efficiency 0.6, cost $4
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `before-${i}`,
        startTime: changeTimestamp - 86_400_000 * (i + 1),
        efficiencyScore: 0.6,
        estimatedCostUsd: 4,
        taskSuccessRate: 0.7,
        userMessages: 10,
        userCorrections: 3,
        toolCallCount: 20,
        taskCount: 2,
      }));
    }

    // 5 sessions after: efficiency 0.75, cost $3
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: 0.75,
        estimatedCostUsd: 3,
        taskSuccessRate: 0.9,
        userMessages: 10,
        userCorrections: 1,
        toolCallCount: 15,
        taskCount: 2,
      }));
    }

    const report = tracker.computeImpact(changeTimestamp);

    expect(report.beforeMetrics.avgEfficiencyScore).toBe(0.6);
    expect(report.afterMetrics.avgEfficiencyScore).toBe(0.75);
    expect(report.beforeMetrics.avgCostUsd).toBe(4);
    expect(report.afterMetrics.avgCostUsd).toBe(3);

    expect(report.deltas.efficiencyScore.value).toBeCloseTo(0.15, 2);
    expect(report.deltas.efficiencyScore.improved).toBe(true);
    expect(report.deltas.cost.value).toBeCloseTo(-1, 2);
    expect(report.deltas.cost.improved).toBe(true);
    expect(report.deltas.taskSuccessRate.improved).toBe(true);

    expect(report.verdict).toMatch(/^Positive impact/);
  });

  // -------------------------------------------------------------------------
  // 6. computeImpact — negative impact
  // -------------------------------------------------------------------------

  it('computeImpact returns Negative impact verdict for degraded metrics', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    tracker.detectChange(makeToolCall({
      toolName: 'Edit',
      filePath: '/project/CLAUDE.md',
      oldLineCount: 10,
      newLineCount: 50,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // 5 sessions before: good metrics
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

    // 5 sessions after: degraded metrics
    for (let i = 0; i < 5; i++) {
      store.saveSession(makeSummary({
        sessionId: `after-${i}`,
        startTime: changeTimestamp + 86_400_000 * (i + 1),
        efficiencyScore: 0.5,
        estimatedCostUsd: 5,
        taskSuccessRate: 0.6,
        userMessages: 10,
        userCorrections: 5,
        toolCallCount: 25,
        taskCount: 2,
      }));
    }

    const report = tracker.computeImpact(changeTimestamp);

    expect(report.deltas.efficiencyScore.improved).toBe(false);
    expect(report.deltas.cost.improved).toBe(false);
    expect(report.deltas.taskSuccessRate.improved).toBe(false);
    expect(report.verdict).toMatch(/^Negative impact/);
  });

  // -------------------------------------------------------------------------
  // 7. Improved direction correctness
  // -------------------------------------------------------------------------

  it('improved flag is correct: lower cost = improved, higher efficiency = improved', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 10,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // Before: eff 0.6, cost $4
    store.saveSession(makeSummary({
      sessionId: 'before-1',
      startTime: changeTimestamp - 86_400_000,
      efficiencyScore: 0.6,
      estimatedCostUsd: 4,
      taskSuccessRate: 0.8,
      userMessages: 10,
      userCorrections: 3,
      toolCallCount: 20,
      taskCount: 2,
    }));

    // After: eff 0.75, cost $3 (both improved)
    store.saveSession(makeSummary({
      sessionId: 'after-1',
      startTime: changeTimestamp + 86_400_000,
      efficiencyScore: 0.75,
      estimatedCostUsd: 3,
      taskSuccessRate: 0.9,
      userMessages: 10,
      userCorrections: 1,
      toolCallCount: 15,
      taskCount: 2,
    }));

    const report = tracker.computeImpact(changeTimestamp);

    // Higher efficiency = improved
    expect(report.deltas.efficiencyScore.improved).toBe(true);
    // Lower cost = improved
    expect(report.deltas.cost.improved).toBe(true);
    // Lower correction rate = improved
    expect(report.deltas.correctionRate.improved).toBe(true);
    // Higher task success = improved
    expect(report.deltas.taskSuccessRate.improved).toBe(true);

    // Now test the reverse: worse efficiency and cost
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
    store = new SessionStore({ storagePath: tmpDir });
    const tracker2 = new ClaudeMdTracker({ sessionStore: store });

    tracker2.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 10,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // Before: eff 0.8, cost $2
    store.saveSession(makeSummary({
      sessionId: 'before-2',
      startTime: changeTimestamp - 86_400_000,
      efficiencyScore: 0.8,
      estimatedCostUsd: 2,
    }));

    // After: eff 0.5, cost $5 (both degraded)
    store.saveSession(makeSummary({
      sessionId: 'after-2',
      startTime: changeTimestamp + 86_400_000,
      efficiencyScore: 0.5,
      estimatedCostUsd: 5,
    }));

    const report2 = tracker2.computeImpact(changeTimestamp);

    // Lower efficiency = NOT improved
    expect(report2.deltas.efficiencyScore.improved).toBe(false);
    // Higher cost = NOT improved
    expect(report2.deltas.cost.improved).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. estimateContextCost
  // -------------------------------------------------------------------------

  it('estimateContextCost returns correct tokens and cost for 10,000 char file', () => {
    // Create a temporary file with exactly 10,000 characters
    const testFile = join(tmpDir, 'CLAUDE.md');
    writeFileSync(testFile, 'x'.repeat(10_000));

    const estimate = ClaudeMdTracker.estimateContextCost(testFile);

    expect(estimate.charCount).toBe(10_000);
    expect(estimate.estimatedTokens).toBe(2500);
    // perTurnCost = (2500 / 1_000_000) * 3 = 0.0075
    expect(estimate.perTurnCostUsd).toBe(0.0075);
    // perSessionCost = 0.0075 * 10 = 0.075
    expect(estimate.perSessionCostUsd).toBe(0.075);
    expect(estimate.filePath).toBe(testFile);
  });

  // -------------------------------------------------------------------------
  // 9. contextTokensForClaudeMd uses actual file size, not linesAdded
  // -------------------------------------------------------------------------

  it('contextTokensForClaudeMd reflects actual file size, not linesAdded', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    // Create a CLAUDE.md file with 2000 characters (= 500 tokens at 0.25 tokens/char)
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'x'.repeat(2000));

    // Record a small edit that only adds 3 lines — old bug would estimate ~30 tokens
    tracker.detectChange(makeToolCall({
      toolName: 'Edit',
      filePath: claudeMdPath,
      newLineCount: 3,
      oldLineCount: 0,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // Need at least one session so computeImpact doesn't short-circuit
    store.saveSession(makeSummary({
      sessionId: 'before-1',
      startTime: changeTimestamp - 86_400_000,
    }));

    const report = tracker.computeImpact(changeTimestamp);

    // Should reflect actual file: 2000 chars * 0.25 = 500 tokens
    expect(report.contextTokensForClaudeMd).toBe(500);
  });

  // -------------------------------------------------------------------------
  // 10. emitMetrics
  // -------------------------------------------------------------------------

  it('emitMetrics emits change events and delta metrics', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    // Detect a change
    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 20,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    // Add sessions before and after
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

    const recorded: Array<{ name: string; value: number; attrs?: Record<string, string | number> }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    tracker.emitMetrics(aggregator);

    const metricNames = recorded.map((r) => r.name);
    expect(metricNames).toContain('ai.claudemd.change');
    expect(metricNames).toContain('ai.claudemd.post_change_efficiency_delta');
    expect(metricNames).toContain('ai.claudemd.post_change_cost_delta');

    // Verify attributes on the change event
    const changeEvent = recorded.find((r) => r.name === 'ai.claudemd.change');
    expect(changeEvent!.attrs?.filePath).toBe('/project/CLAUDE.md');
    expect(changeEvent!.attrs?.changeType).toBe('created');
  });

  // -------------------------------------------------------------------------
  // 11. changes cap (MAX_CHANGES = 1000)
  // -------------------------------------------------------------------------

  it('never holds more than 1000 changes', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    for (let i = 0; i < 1005; i++) {
      tracker.detectChange(makeToolCall({
        toolName: 'Write',
        filePath: '/project/.claude/settings.json',
        lineCount: 1,
        timestamp: 1000 + i,
      } as Partial<ToolCallRecord>));
    }

    expect(tracker.getChanges()).toHaveLength(1000);
  });

  it('drops oldest changes when cap is exceeded', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    for (let i = 0; i < 1002; i++) {
      tracker.detectChange(makeToolCall({
        toolName: 'Write',
        filePath: `/project/.claude/config${i}.json`,
        lineCount: 1,
        timestamp: 1000 + i,
      } as Partial<ToolCallRecord>));
    }

    const changes = tracker.getChanges();
    expect(changes[0].filePath).toBe('/project/.claude/config2.json');
    expect(changes[999].filePath).toBe('/project/.claude/config1001.json');
  });

  // -------------------------------------------------------------------------
  // 12. emitMetrics does not re-emit already-harvested changes
  // -------------------------------------------------------------------------

  it('emitMetrics only emits new changes on subsequent harvests', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 10,
      timestamp: Date.now(),
    } as Partial<ToolCallRecord>));

    const recorded1: string[] = [];
    const agg1 = {
      record(name: string) { recorded1.push(name); },
    } as unknown as MetricAggregator;
    tracker.emitMetrics(agg1);
    const changeCount1 = recorded1.filter((n) => n === 'ai.claudemd.change').length;
    expect(changeCount1).toBe(1);

    // Second harvest with no new changes — should emit 0 change events
    const recorded2: string[] = [];
    const agg2 = {
      record(name: string) { recorded2.push(name); },
    } as unknown as MetricAggregator;
    tracker.emitMetrics(agg2);
    const changeCount2 = recorded2.filter((n) => n === 'ai.claudemd.change').length;
    expect(changeCount2).toBe(0);

    // After a new change, should emit exactly 1
    tracker.detectChange(makeToolCall({
      toolName: 'Edit',
      filePath: '/project/CLAUDE.md',
      oldLineCount: 10,
      newLineCount: 12,
      timestamp: Date.now() + 1000,
    } as Partial<ToolCallRecord>));

    const recorded3: string[] = [];
    const agg3 = {
      record(name: string) { recorded3.push(name); },
    } as unknown as MetricAggregator;
    tracker.emitMetrics(agg3);
    const changeCount3 = recorded3.filter((n) => n === 'ai.claudemd.change').length;
    expect(changeCount3).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 13. getCachedImpact avoids redundant computeImpact calls
  // -------------------------------------------------------------------------

  it('emitMetrics reuses the cached impact report when no new change arrives', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });
    const changeTimestamp = Date.now();

    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 10,
      timestamp: changeTimestamp,
    } as Partial<ToolCallRecord>));

    store.saveSession(makeSummary({
      sessionId: 'before-1',
      startTime: changeTimestamp - 86_400_000,
    }));

    const agg = { record() {} } as unknown as MetricAggregator;

    // Spy on loadAllSessions to count disk reads
    const loadSpy = jest.spyOn(store, 'loadAllSessions');

    tracker.emitMetrics(agg); // first harvest — cache miss → 1 disk read
    tracker.emitMetrics(agg); // second harvest — cache hit → 0 additional reads

    // loadAllSessions called once via computeImpact, not twice
    expect(loadSpy).toHaveBeenCalledTimes(1);

    loadSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 14. reset clears all state
  // -------------------------------------------------------------------------

  it('reset clears changes, lastEmittedIndex, and impact cache', () => {
    const tracker = new ClaudeMdTracker({ sessionStore: store });

    tracker.detectChange(makeToolCall({
      toolName: 'Write',
      filePath: '/project/CLAUDE.md',
      lineCount: 5,
      timestamp: Date.now(),
    } as Partial<ToolCallRecord>));
    expect(tracker.getChanges()).toHaveLength(1);

    tracker.reset();
    expect(tracker.getChanges()).toHaveLength(0);

    // After reset, emitMetrics should emit 0 events
    const recorded: string[] = [];
    const agg = { record(name: string) { recorded.push(name); } } as unknown as MetricAggregator;
    tracker.emitMetrics(agg);
    expect(recorded.filter((n) => n === 'ai.claudemd.change')).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { estimatedFromOf } from '../__test-utils__/estimated-from.js';
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TokenUsage } from '../shared/index.js';
import { localDateKey } from '../lib/date.js';
import { SessionStore, type FullSessionSummary } from '../storage/session-store.js';
import {
  collectCommitsAcrossRepos,
  LocalSessionAggregator,
  RepoNameResolver,
  stripHeredocs,
  type SessionFileStore,
  type SummaryContext,
} from './local-session-aggregator.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';
import { CostTracker } from './cost-tracker.js';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

// git sets GIT_DIR/GIT_WORK_TREE for hook subprocesses, which override `-C
// <dir>` and would silently redirect these calls to the real repo instead of
// the isolated temp dir under test. See git-activity-recorder.test.ts.
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, { ...options, env: CLEAN_ENV });
}

/** A `since` far enough back that every commit a test creates is in range. */
function farBackSince(): string {
  return new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
}

const REAL_ID = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';
const MODEL = 'claude-sonnet-4-20250514';

/** Stub resolver so tests never shell out to git. */
class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function makeContext(outcome = 'in progress'): SummaryContext {
  return {
    developer: 'tester',
    platform: 'copilot',
    outcome,
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
  };
}

function summariesOf(agg: LocalSessionAggregator, outcome = 'in progress') {
  return agg.toSummaries(makeContext(outcome));
}

/** A session file as a `--stdio` engine writes it. */
function makeEngineSummary(overrides: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: REAL_ID,
    sessionName: 'repo',
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 3,
    developer: 'alice',
    model: MODEL,
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
    estimatedCostUsd: 0,
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
    taskCount: 1,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'in progress',
    ...overrides,
  } as unknown as FullSessionSummary;
}

describe('LocalSessionAggregator', () => {
  it('rolls tool calls up under the real session id', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1000,
      success: true,
      cwd: '/repo',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 2000,
      success: true,
    });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 3000 });

    const [summary] = summariesOf(agg);
    expect(summary?.sessionId).toBe(REAL_ID);
    expect(summary?.toolCallCount).toBe(3);
    expect(summary?.toolBreakdown).toEqual({ run_in_terminal: 2, read_file: 1 });
    expect(summary?.startTime).toBe(1000);
    expect(summary?.endTime).toBe(3000);
    expect(summary?.durationMs).toBe(2000);
    expect(summary?.repoName).toBe('acme/widgets');
  });

  // Synthetic ids are MCP-internal bookkeeping; persisting them is exactly the
  // "confusing duplicate rows" case persistSession() already refuses.
  it.each(['local-1786389794360', 'proxy-123', 'pending-456'])(
    'ignores the synthetic session id %s',
    (syntheticId) => {
      const agg = new LocalSessionAggregator();
      agg.recordToolCall({ sessionId: syntheticId, toolName: 'run_in_terminal', timestamp: 1 });
      agg.recordTokenUsage(syntheticId, { costUsd: 5, inputTokens: 100 });
      expect(agg.size()).toBe(0);
      expect(summariesOf(agg)).toEqual([]);
    },
  );

  it('keeps sessions separate so one window\u2019s chats do not merge', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 2 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 3 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s.toolCallCount]));
    expect(byId.get(REAL_ID)).toBe(1);
    expect(byId.get(other)).toBe(2);
  });

  // Regression guard: a session's own records carry its true platform
  // (e.g. a Copilot session drained by an unrelated generic-mcp dashboard
  // process); that must win over toSummaries()'s context.platform, which
  // only reflects the *draining* process's own environment.
  it("prefers the session's own record platform over the draining process's context platform", () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1,
      platform: 'copilot',
    });

    const [summary] = agg.toSummaries({
      developer: 'tester',
      platform: 'generic-mcp',
      outcome: 'in progress',
      repoResolver: new StubRepoResolver(),
      toolSelectionScorer: new ToolSelectionScorer(),
    });
    expect(summary?.platform).toBe('copilot');
  });

  it('falls back to the context platform when no record carries one', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'run_in_terminal', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.platform).toBe('copilot');
  });

  it('keeps the first non-null platform seen across a session’s records', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1,
      platform: 'copilot',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 2,
      platform: 'copilot-sdk',
    });

    const [summary] = summariesOf(agg);
    expect(summary?.platform).toBe('copilot');
  });

  it('attributes token cost to the session that incurred it', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, {
      costUsd: 0.25,
      model: 'claude-opus-4.8',
      inputTokens: 1000,
      outputTokens: 50,
      timestamp: 2,
    });
    agg.recordTokenUsage(REAL_ID, { costUsd: 0.75, model: 'claude-opus-4.8', inputTokens: 10 });

    const [summary] = summariesOf(agg);
    expect(summary?.estimatedCostUsd).toBeCloseTo(1.0);
    expect(summary?.tokensInput).toBe(1010);
    expect(summary?.tokensOutput).toBe(50);
    expect(summary?.model).toBe('claude-opus-4.8');
  });

  it('counts unpriced-model calls on the session that made them', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 100, outputTokens: 20 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 30 });
    agg.recordTokenUsage(other, { costUsd: 0.01, model: 'claude-sonnet-5', inputTokens: 100 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s]));
    expect(byId.get(REAL_ID)?.unpricedByModel).toEqual({
      'claude-foo-9-9': { calls: 2, tokens: 150 },
    });
    expect(byId.get(other)?.unpricedByModel).toBeUndefined();
  });

  it('counts family-priced calls on the session that made them', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-opus-5-9', inputTokens: 100, outputTokens: 20 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-opus-5-9', inputTokens: 30 });
    agg.recordTokenUsage(other, { costUsd: 0.01, model: 'claude-sonnet-5', inputTokens: 100 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s]));
    expect(byId.get(REAL_ID)?.estimatedByModel).toEqual({
      'claude-opus-5-9': {
        calls: 2,
        tokens: 150,
        estimatedFrom: estimatedFromOf('claude-opus-5-9'),
      },
    });
    expect(byId.get(REAL_ID)?.unpricedByModel).toBeUndefined();
    expect(byId.get(other)?.estimatedByModel).toBeUndefined();
  });

  it('leaves model null when a session spans several models', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-opus-4.8' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-sonnet-4.6' });
    expect(summariesOf(agg)[0]?.model).toBeNull();
  });

  it('emits a summary for a chat-only session that recorded cost', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, inputTokens: 500 });
    expect(agg.size()).toBe(1);
    expect(summariesOf(agg)).toHaveLength(1);
    expect(summariesOf(agg)[0]).toMatchObject({ sessionId: REAL_ID, estimatedCostUsd: 2 });
  });

  it('does not emit a summary for a session with no tool calls and no usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {});
    expect(summariesOf(agg)).toEqual([]);
  });

  it('reports cost as null rather than zero when nothing was spent', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    expect(summariesOf(agg)[0]?.estimatedCostUsd).toBeNull();
  });

  it('tracks success rate and modified files', () => {
    const agg = new LocalSessionAggregator();
    // toolName here is the canonical (already-mapped) name — recordToolCall
    // receives the same rawRecord TaskDetector does, and TaskDetector's own
    // Read-vs-Write/Edit gating (task-detector.ts) requires this shape.
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Edit', timestamp: 1, filePath: '/a.ts' });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Edit', timestamp: 2, filePath: '/a.ts' });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Edit',
      timestamp: 3,
      filePath: '/b.ts',
      success: false,
    });

    const [summary] = summariesOf(agg);
    expect(summary?.filesModified).toEqual(['/a.ts', '/b.ts']);
    expect(summary?.toolSuccessRate).toBeCloseTo(2 / 3);
  });

  it('classifies a Read call as filesRead, not filesModified — a read-only exploration session must not look like it edited files', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 1, filePath: '/c.ts' });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Write', timestamp: 2, filePath: '/d.ts' });

    const [summary] = summariesOf(agg);
    expect(summary?.filesRead).toEqual(['/c.ts']);
    expect(summary?.filesModified).toEqual(['/d.ts']);
  });

  it('carries the outcome through so periodic saves are not marked completed', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    expect(summariesOf(agg, 'in progress')[0]?.outcome).toBe('in progress');
    expect(summariesOf(agg, 'completed')[0]?.outcome).toBe('completed');
  });

  it('exposes distinct cwds for git repo discovery', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'x', timestamp: 1, cwd: '/one' });
    agg.recordToolCall({
      sessionId: 'c0000000-0000-4000-8000-000000000000',
      toolName: 'x',
      timestamp: 2,
      cwd: '/two',
    });
    expect(agg.cwds().sort()).toEqual(['/one', '/two']);
  });
});

describe('collectCommitsAcrossRepos', () => {
  let repoDir: string;
  let initialBranch: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join('/tmp', 'collect-commits-'));
    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    initialBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    })
      .stdout.toString()
      .trim();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('attributes a commit on a branch that is not checked out to the root (the --branches pass)', () => {
    spawnSync('git', ['checkout', '-b', 'feature'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['commit', '--allow-empty', '-m', 'feature work'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    const featureHash = spawnSync('git', ['rev-parse', 'feature'], {
      cwd: repoDir,
      encoding: 'utf-8',
    })
      .stdout.toString()
      .trim();
    // Back on the original branch — 'feature' still exists but isn't checked
    // out, and isn't HEAD, so the HEAD-only pass 1 can't see its commit.
    spawnSync('git', ['checkout', initialBranch], { cwd: repoDir, stdio: 'ignore' });

    const commits = collectCommitsAcrossRepos([repoDir], farBackSince(), null);
    const featureCommit = commits.find((c) => c.hash === featureHash);

    expect(featureCommit).toBeDefined();
    expect(featureCommit?.root).toBe(repoDir);
  });

  it('attributes a commit seen from both a linked worktree and the primary checkout to the primary', () => {
    const initHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
      .stdout.toString()
      .trim();
    const worktreeParent = mkdtempSync(join('/tmp', 'collect-commits-wt-'));
    const worktreeDir = join(worktreeParent, 'wt');
    try {
      spawnSync('git', ['worktree', 'add', '-b', 'feature-wt', worktreeDir], {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Worktree passed FIRST — collectCommitsAcrossRepos must still reorder
      // primaries first internally, not trust caller order.
      const commits = collectCommitsAcrossRepos([worktreeDir, repoDir], farBackSince(), null);
      const initCommits = commits.filter((c) => c.hash === initHash);

      expect(initCommits).toHaveLength(1);
      expect(initCommits[0].root).toBe(repoDir);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  });
});

describe('LocalSessionAggregator timeline persistence', () => {
  it('emits a replayable timeline entry per tool call', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 100,
      durationMs: 42,
      success: true,
      command: 'npm test',
      isTestCommand: true,
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      timestamp: 100,
      toolName: 'run_in_terminal',
      durationMs: 42,
      success: true,
      command: 'npm test',
      isTestCommand: true,
    });
  });

  it('persists the created PR number so a replay can match it to a later merge', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 100,
      command: 'gh pr create --fill',
      createdPrNumber: '42',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.createdPrNumber).toBe('42');
  });

  it('persists a background run, whose success predates the command finishing', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 100,
      command: 'gh pr merge 42',
      runInBackground: true,
    });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Bash', timestamp: 200, command: 'ls' });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.runInBackground).toBe(true);
    expect(timeline[1]).not.toHaveProperty('runInBackground');
  });

  it('omits the timeline entirely when nothing was recorded for it', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as unknown[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).not.toHaveProperty('command');
  });

  it('records failures so replay can distinguish them', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 1, success: false });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.success).toBe(false);
  });

  it('threads agentId onto the timeline entry so replay can partition by agent', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'edit',
      timestamp: 1,
      agentId: 'agent-a',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.agentId).toBe('agent-a');
  });

  it('omits agentId when the tool call was made by the parent session', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 1 });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]).not.toHaveProperty('agentId');
  });
});

describe('LocalSessionAggregator panel rehydration', () => {
  it('emits modelBreakdown, qualityProxy and toolSelectionMetrics', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 1000,
      success: true,
    } as never);
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 2000,
      success: true,
    } as never);
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheCreationTokens: 40,
      costUsd: 0.5,
    } as never);
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 50,
      outputTokens: 10,
      costUsd: 0.25,
    } as never);

    const [summary] = summariesOf(agg);
    expect(summary?.modelBreakdown).toEqual({
      'gpt-5': {
        requestCount: 2,
        totalInputTokens: 150,
        totalOutputTokens: 30,
        totalCostUsd: 0.75,
        totalCacheReadTokens: 800,
        totalCacheCreationTokens: 40,
        totalThinkingTokens: 0,
      },
    });
    const quality = summary?.qualityProxy as { totalSignals: number } | undefined;
    expect(quality).toBeDefined();
    expect(typeof quality?.totalSignals).toBe('number');
    const toolSelection = summary?.toolSelectionMetrics as { totalCalls: number } | null;
    expect(toolSelection?.totalCalls).toBe(2);
  });

  it('emits a token-only session so its cost is persisted', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    expect(summariesOf(agg)).toHaveLength(1);
  });
});

describe('LocalSessionAggregator cross-repo git discovery', () => {
  it('exposes a repo targeted only by git -C, which no cwd would reveal', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 1000,
      success: true,
      cwd: '/home/u/aic',
      command: 'git -C /home/u/other-repo status --short',
    } as never);
    expect(agg.cwds().sort()).toEqual(['/home/u/aic', '/home/u/other-repo']);
  });

  it('does not treat a non-git command as a repo target', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 1000,
      success: true,
      cwd: '/home/u/aic',
      command: 'npm run build',
    } as never);
    expect(agg.cwds()).toEqual(['/home/u/aic']);
  });
});

describe('LocalSessionAggregator subagent cost', () => {
  it('routes agentId-tagged usage into subagentCostUsd and subagentCostByDayUsd, while also counting it in costByDayUsd', () => {
    const agg = new LocalSessionAggregator();
    const ts = Date.parse('2026-09-11T12:00:00Z');
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: ts, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostUsd).toBe(2);
    const dayKey = localDateKey(ts);
    expect(summary?.costByDayUsd).toEqual({ [dayKey]: 2 });
    expect(summary?.subagentCostByDayUsd).toEqual({ [dayKey]: 2 });
  });

  it('does not touch subagent fields for agentId-less (parent) usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 3, timestamp: 1000 });
    // Parent-token-only usage has no tool calls, so it still doesn't emit —
    // add a tool call so the summary is inspectable.
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostUsd).toBe(0);
    expect(summary?.subagentCostByDayUsd).toBeUndefined();
    expect(summary?.costByDayUsd).toEqual({ [localDateKey(1000)]: 3 });
  });

  it('emits a summary for a subagent-only rollup with zero tool calls', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 5, timestamp: 1000, agentId: 'agent-1' });

    const summaries = summariesOf(agg);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.toolCallCount).toBe(0);
    expect(summaries[0]?.subagentCostUsd).toBe(5);
    expect(summaries[0]?.estimatedCostUsd).toBe(5);
  });

  it('buckets subagent cost by the turn timestamp, splitting a run across two day keys', () => {
    const agg = new LocalSessionAggregator();
    const day1 = Date.parse('2026-09-10T12:00:00Z');
    // 48h later guarantees a different local calendar date regardless of the
    // test runner's timezone offset (unlike a 2h gap, which can land on the
    // same local day depending on the offset).
    const day2 = day1 + 48 * 60 * 60 * 1000;
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: day1, agentId: 'agent-1' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 4, timestamp: day2, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostByDayUsd).toEqual({
      [localDateKey(day1)]: 1,
      [localDateKey(day2)]: 4,
    });
    expect(summary?.subagentCostUsd).toBe(5);
  });

  it('omits costByDayUsd (undefined, not {}) for a rollup with only tool calls and no token usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.costByDayUsd).toBeUndefined();
    expect(summary?.subagentCostByDayUsd).toBeUndefined();
  });
});

describe('LocalSessionAggregator persist', () => {
  const DAY = new Date(2026, 8, 10, 12).getTime();
  const DAY_KEY = localDateKey(DAY);
  let storagePath: string;
  let store: SessionStore;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'agg-persist-'));
    store = new SessionStore({ storagePath });
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('adds its own cost to the file another writer saved', () => {
    store.saveSession(
      makeEngineSummary({
        estimatedCostUsd: 10,
        subagentCostUsd: 4,
        costByDayUsd: { [DAY_KEY]: 10 },
        subagentCostByDayUsd: { [DAY_KEY]: 4 },
      }),
    );
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY, agentId: 'agent-1' });

    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBe(11);
    expect(file?.subagentCostUsd).toBe(5);
    expect(file?.costByDayUsd).toEqual({ [DAY_KEY]: 11 });
    expect(file?.subagentCostByDayUsd).toEqual({ [DAY_KEY]: 5 });
  });

  it('adds nothing more when it saves the same session again', () => {
    store.saveSession(makeEngineSummary({ estimatedCostUsd: 10, subagentCostUsd: 10 }));
    const agg = new LocalSessionAggregator();
    for (const [i, agentId] of ['agent-1', 'agent-1', 'agent-2'].entries()) {
      agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY + i, agentId });
      agg.persist(store, makeContext());
    }
    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBe(13);
    expect(file?.subagentCostUsd).toBe(13);
  });

  it('counts a file another writer saved after this session’s rollup started', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY });
    store.saveSession(makeEngineSummary({ estimatedCostUsd: 5 }));

    agg.persist(store, makeContext());

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBe(6);
  });

  it('writes its own total when no file exists yet', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: DAY, agentId: 'agent-1' });

    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBe(2);
    expect(file?.subagentCostUsd).toBe(2);
  });

  it('does not re-add cost it already saved', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 5, timestamp: DAY });
    agg.persist(store, makeContext());

    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY + 1000, agentId: 'agent-1' });
    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBe(6);
    expect(file?.subagentCostUsd).toBe(1);
    expect(file?.costByDayUsd).toEqual({ [DAY_KEY]: 6 });
    expect(file?.subagentCostByDayUsd).toEqual({ [DAY_KEY]: 1 });
  });

  it('keeps the saved session cost across a process restart', () => {
    const before = new LocalSessionAggregator();
    before.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    before.recordTokenUsage(REAL_ID, { costUsd: 10, timestamp: DAY });
    before.persist(store, makeContext());

    const after = new LocalSessionAggregator();
    after.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    after.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: DAY });
    after.persist(store, makeContext());

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(12, 6);
  });

  it('adds a parent-only turn after a --local restart to the session saved before it', () => {
    const before = new LocalSessionAggregator();
    before.recordToolCall({ sessionId: REAL_ID, toolName: 'Bash', timestamp: DAY });
    before.recordTokenUsage(REAL_ID, { costUsd: 0.0096, model: MODEL, timestamp: DAY + 1 });
    before.recordTokenUsage(REAL_ID, { costUsd: 0.0096, model: MODEL, timestamp: DAY + 2 });
    before.persist(store, makeContext('completed'));
    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(0.0192, 6);

    const after = new LocalSessionAggregator();
    after.recordTokenUsage(REAL_ID, { costUsd: 0.0096, model: MODEL, timestamp: DAY + 3 });
    after.persist(store, makeContext('completed'));

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(0.0288, 6);
  });

  it('does not count twice the cost a writer seeded from its own save', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: DAY });
    agg.persist(store, makeContext());

    const seeded = store.loadSession(REAL_ID)!;
    store.saveSession({
      ...seeded,
      estimatedCostUsd: (seeded.estimatedCostUsd ?? 0) + 3,
      costByDayUsd: { [DAY_KEY]: (seeded.costByDayUsd?.[DAY_KEY] ?? 0) + 3 },
    });

    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY + 1000 });
    agg.persist(store, makeContext());
    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBeCloseTo(6, 6);
    expect(file?.costByDayUsd?.[DAY_KEY]).toBeCloseTo(6, 6);
  });

  it('still counts its unsaved cost after a save fails', () => {
    store.saveSession(makeEngineSummary({ estimatedCostUsd: 5 }));
    const failingStore: SessionFileStore = {
      loadSession: (id) => store.loadSession(id),
      saveSession: () => false,
    };
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: DAY });
    agg.persist(failingStore, makeContext());

    store.saveSession(makeEngineSummary({ estimatedCostUsd: 8 }));
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY + 1000 });
    agg.persist(store, makeContext());

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(11, 6);
  });

  it('skips a session unchanged since its last save, then folds what changed meanwhile', () => {
    const calls = { loadSession: 0, saveSession: 0 };
    const countingStore: SessionFileStore = {
      loadSession: (id) => {
        calls.loadSession += 1;
        return store.loadSession(id);
      },
      saveSession: (summary) => {
        calls.saveSession += 1;
        return store.saveSession(summary);
      },
    };
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: DAY });
    agg.persist(countingStore, makeContext());

    store.saveSession(makeEngineSummary({ estimatedCostUsd: 5 }));
    agg.persist(countingStore, makeContext());
    expect(calls).toEqual({ loadSession: 1, saveSession: 1 });

    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: DAY + 1000 });
    agg.persist(countingStore, makeContext());
    expect(calls).toEqual({ loadSession: 2, saveSession: 2 });
    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(6, 6);
  });

  it('marks an unchanged session completed on the terminal save', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.persist(store, makeContext('in progress'));

    agg.persist(store, makeContext('completed'));

    expect(store.loadSession(REAL_ID)?.outcome).toBe('completed');
  });

  it('hands an adopting process a file that holds the cost drained since the last save', () => {
    store.saveSession(makeEngineSummary({ estimatedCostUsd: 5 }));
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 0.02, timestamp: DAY });

    const costTracker = new CostTracker();
    costTracker.seedFromPersisted(
      buildCostTrackerSeed(agg.handOff(REAL_ID, store, makeContext())!),
    );
    const turn = costTracker.recordTokenUsage(makeUsage({ inputTokens: 3_333 }), MODEL, {
      timestampMs: Date.now(),
    });
    store.saveSession(
      makeEngineSummary({ estimatedCostUsd: costTracker.getMetrics().sessionTotalCostUsd }),
    );

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(5 + 0.02 + turn.totalUsd, 6);
  });

  it('adds a saved byte-estimate ledger to the total once', () => {
    store.saveSession(
      makeEngineSummary({
        estimatedCostUsd: 6,
        costByDayUsd: { [DAY_KEY]: 6 },
        exactTotals: {
          costUsd: 5,
          inputTokens: 0,
          outputTokens: 0,
          costByDayUsd: { [DAY_KEY]: 5 },
        },
        byteEstimates: {
          costUsd: 1,
          inputTokens: 0,
          outputTokens: 0,
          costByModel: {},
          costByDayUsd: { [DAY_KEY]: 1 },
        },
      }),
    );
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: DAY, success: true });
    agg.recordTokenUsage(REAL_ID, { costUsd: 0.5, timestamp: DAY });

    agg.persist(store, makeContext());
    agg.persist(store, makeContext());
    agg.persist(store, makeContext());

    const file = store.loadSession(REAL_ID);
    expect(file?.estimatedCostUsd).toBeCloseTo(6.5, 6);
    expect(file?.costByDayUsd?.[DAY_KEY]).toBeCloseTo(6.5, 6);
  });
});

describe('LocalSessionAggregator byte estimates for platforms that cannot self-report', () => {
  const DAY = new Date(2026, 8, 10, 12).getTime();
  const DAY_KEY = localDateKey(DAY);
  const CONV_A = 'cursor-conv-a';
  const CONV_B = 'cursor-conv-b';
  const USD_PER_INPUT_TOKEN = 3e-6;
  const USD_PER_OUTPUT_TOKEN = 15e-6;
  // 4000 input bytes and 2000 output bytes are 1000 and 500 tokens at chars/4.
  const ONE_CALL_USD = 1000 * USD_PER_INPUT_TOKEN + 500 * USD_PER_OUTPUT_TOKEN;
  let storagePath: string;
  let store: SessionStore;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'agg-estimates-'));
    store = new SessionStore({ storagePath });
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  function makeAggregator(): LocalSessionAggregator {
    return new LocalSessionAggregator({
      priceByteEstimate: (usage: TokenUsage) => ({
        model: 'default-model',
        costUsd:
          usage.inputTokens * USD_PER_INPUT_TOKEN + usage.outputTokens * USD_PER_OUTPUT_TOKEN,
      }),
    });
  }

  function makeToolCall(
    sessionId: string,
    overrides: Partial<{
      platform: string | null;
      inputSizeBytes: number;
      outputSizeBytes: number;
      timestamp: number;
    }> = {},
  ) {
    return {
      sessionId,
      toolName: 'Bash',
      timestamp: DAY,
      success: true,
      platform: 'cursor',
      inputSizeBytes: 4000,
      outputSizeBytes: 2000,
      ...overrides,
    };
  }

  it('saves a Cursor tool call’s byte estimate to its own conversation', () => {
    const agg = makeAggregator();
    agg.recordToolCall(makeToolCall(CONV_A));
    agg.recordToolCall(makeToolCall(CONV_B, { inputSizeBytes: 800, outputSizeBytes: 0 }));

    agg.persist(store, makeContext());

    const a = store.loadSession(CONV_A);
    const b = store.loadSession(CONV_B);
    expect(a?.estimatedCostUsd).toBeCloseTo(ONE_CALL_USD, 12);
    expect(a?.tokensInput).toBe(1000);
    expect(a?.tokensOutput).toBe(500);
    expect(a?.costByDayUsd).toEqual({ [DAY_KEY]: expect.closeTo(ONE_CALL_USD, 12) });
    expect(b?.estimatedCostUsd).toBeCloseTo(200 * USD_PER_INPUT_TOKEN, 12);
    expect(b?.tokensInput).toBe(200);
  });

  it('saves a Windsurf tool call’s byte estimate too', () => {
    const agg = makeAggregator();
    agg.recordToolCall(makeToolCall(CONV_A, { platform: 'windsurf' }));

    agg.persist(store, makeContext());

    expect(store.loadSession(CONV_A)?.estimatedCostUsd).toBeCloseTo(ONE_CALL_USD, 12);
  });

  it.each([['claude-code'], ['kiro'], ['amazon-q'], ['copilot'], [null]])(
    'does not estimate a %s record drained by the same aggregator',
    (platform) => {
      const agg = makeAggregator();
      agg.recordToolCall(makeToolCall(CONV_A, { platform }));

      agg.persist(store, makeContext());

      const saved = store.loadSession(CONV_A);
      expect(saved?.toolCallCount).toBe(1);
      expect(saved?.estimatedCostUsd ?? null).toBeNull();
      expect(saved?.byteEstimates).toBeUndefined();
      expect(saved?.tokensInput).toBe(0);
    },
  );

  it('retracts a session’s estimate once exact usage arrives for it, and stops estimating it', () => {
    const agg = makeAggregator();
    agg.recordToolCall(makeToolCall(CONV_A));
    agg.recordToolCall(makeToolCall(CONV_B));
    agg.persist(store, makeContext());
    agg.recordTokenUsage(CONV_A, { costUsd: 0.5, inputTokens: 100, timestamp: DAY });
    agg.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 1000 }));

    agg.persist(store, makeContext());

    const a = store.loadSession(CONV_A);
    expect(a?.estimatedCostUsd).toBe(0.5);
    expect(a?.tokensInput).toBe(100);
    expect(a?.costByDayUsd).toEqual({ [DAY_KEY]: 0.5 });
    expect(store.loadSession(CONV_B)?.estimatedCostUsd).toBeCloseTo(ONE_CALL_USD, 12);
  });

  it('does not grow the saved estimate when it saves the same ledger again', () => {
    const agg = makeAggregator();
    agg.recordToolCall(makeToolCall(CONV_A));
    agg.persist(store, makeContext());
    agg.persist(store, makeContext('completed'));

    expect(store.loadSession(CONV_A)?.estimatedCostUsd).toBeCloseTo(ONE_CALL_USD, 12);
    expect(store.loadSession(CONV_A)?.tokensInput).toBe(1000);
  });

  it('keeps the estimate saved before a restart when the restarted aggregator adds a call', () => {
    const before = makeAggregator();
    before.recordToolCall(makeToolCall(CONV_A));
    before.persist(store, makeContext());

    const after = makeAggregator();
    after.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 1000 }));
    after.persist(store, makeContext());

    const saved = store.loadSession(CONV_A);
    expect(saved?.estimatedCostUsd).toBeCloseTo(2 * ONE_CALL_USD, 12);
    expect(saved?.byteEstimates?.costUsd).toBeCloseTo(2 * ONE_CALL_USD, 12);
    expect(saved?.exactTotals?.costUsd).toBe(0);
    expect(saved?.tokensInput).toBe(2000);
  });

  it('keeps every estimate across a save that fails', () => {
    const failingStore: SessionFileStore = {
      loadSession: (id) => store.loadSession(id),
      saveSession: () => false,
    };
    const agg = makeAggregator();
    agg.recordToolCall(makeToolCall(CONV_A));
    agg.persist(failingStore, makeContext());

    agg.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 1000 }));
    agg.persist(store, makeContext());

    expect(store.loadSession(CONV_A)?.byteEstimates?.costUsd).toBeCloseTo(2 * ONE_CALL_USD, 12);
  });

  it('keeps every call when two aggregators save the same conversation in turn', () => {
    const windowOne = makeAggregator();
    const windowTwo = makeAggregator();
    windowOne.recordToolCall(makeToolCall(CONV_A));
    windowOne.persist(store, makeContext());
    windowTwo.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 1000 }));
    windowTwo.persist(store, makeContext());
    windowOne.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 2000 }));
    windowOne.persist(store, makeContext());

    expect(store.loadSession(CONV_A)?.estimatedCostUsd).toBeCloseTo(3 * ONE_CALL_USD, 12);
    expect(store.loadSession(CONV_A)?.tokensInput).toBe(3000);

    windowTwo.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 3000 }));
    windowTwo.persist(store, makeContext());
    windowOne.persist(store, makeContext('completed'));

    const saved = store.loadSession(CONV_A);
    expect(saved?.estimatedCostUsd).toBeCloseTo(4 * ONE_CALL_USD, 12);
    expect(saved?.tokensInput).toBe(4000);
    expect(saved?.tokensOutput).toBe(2000);
    expect(saved?.costByDayUsd).toEqual({ [DAY_KEY]: expect.closeTo(4 * ONE_CALL_USD, 12) });
    expect(saved?.byteEstimates?.costByModel).toEqual({
      'default-model': expect.closeTo(4 * ONE_CALL_USD, 12),
    });
  });

  it('does not bring a retracted estimate back after a restart', () => {
    const before = makeAggregator();
    before.recordToolCall(makeToolCall(CONV_A));
    before.persist(store, makeContext());
    before.recordTokenUsage(CONV_A, { costUsd: 0.5, inputTokens: 100, timestamp: DAY });
    before.persist(store, makeContext());

    const after = makeAggregator();
    after.recordToolCall(makeToolCall(CONV_A, { timestamp: DAY + 1000 }));
    after.persist(store, makeContext());

    const saved = store.loadSession(CONV_A);
    expect(saved?.estimatedCostUsd).toBe(0.5);
    expect(saved?.tokensInput).toBe(100);
    expect(saved?.byteEstimates?.costUsd ?? 0).toBe(0);
  });
});

describe('stripHeredocs', () => {
  it.each([
    ['a closed heredoc', "cat <<'EOF'\ngit push\nEOF\ngit log", "cat <<'EOF'\ngit log", false],
    [
      'a heredoc inside "$( … )"',
      'git commit -m "$(cat <<\'EOF\'\nfix: git push\nEOF\n)" && git push',
      'git commit -m "$(cat <<\'EOF\'\n)" && git push',
      false,
    ],
    ['a <<- heredoc', 'cat <<-EOF\n\tgit push\n\tEOF\ngit log', 'cat <<-EOF\ngit log', false],
    [
      'a heredoc with CRLF line ends',
      'cat <<EOF\r\ngit push\r\nEOF\r\ngit log',
      'cat <<EOF\r\ngit log',
      false,
    ],
    ['a here-string', 'grep -q x <<<"$(gh pr view 1)"\ngit push', null, false],
    ['a double-quoted <<', 'gh pr comment 1 --body "see <<X"\ngit push', null, true],
    ['a single-quoted <<', "echo 'a <<B'\ngit push", null, true],
    ['a quoted "<<EOF"', 'echo "<<EOF"\ngit push', null, true],
    ['a << in a comment with an apostrophe', "# don't <<X\ngit push", null, true],
    ['a << before a number', 'echo $((1<<2))\ngit push', null, false],
    [
      'a quoted << before a real heredoc',
      'echo "see <<X" && cat <<EOF\ngit push\nEOF\ngit log',
      'echo "see <<X" && cat <<EOF\ngit log',
      true,
    ],
    [
      'a quoted <<EOF that a real heredoc closes',
      'gh pr merge 1 --body "see <<EOF"\ngh pr comment 1 <<\'EOF\'\nDone.\nEOF',
      'gh pr merge 1 --body "see <<EOF"',
      true,
    ],
  ])('reads %s and reports no unclosed heredoc', (_label, command, text, readingsDiffer) => {
    expect(stripHeredocs(command)).toEqual({
      text: text ?? command,
      unclosed: false,
      readingsDiffer,
    });
  });

  it.each([
    ['a heredoc whose terminator never comes', 'cat <<EOF\ngit log\n', 'cat <<EOF', false],
    ['an unquoted << in arithmetic', 'echo $((1<<N))\ngit push', 'echo $((1<<N))', false],
    ['a quoted << whose quote never closes', 'echo "see <<X\ngit push', 'echo "see <<X', true],
    [
      'a <<- terminator indented with spaces',
      'cat <<-EOF\n  git push\n  EOF\ngit log',
      'cat <<-EOF',
      false,
    ],
    [
      'a terminator with a trailing space',
      'cat <<EOF\ngit push\nEOF \ngit log',
      'cat <<EOF',
      false,
    ],
  ])(
    'drops the lines after %s and reports it unclosed',
    (_label, command, text, readingsDiffer) => {
      expect(stripHeredocs(command)).toEqual({ text, unclosed: true, readingsDiffer });
    },
  );
});

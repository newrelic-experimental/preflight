import { describe, expect, it } from '@jest/globals';
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { localDateKey } from '../lib/date.js';
import {
  collectCommitsAcrossRepos,
  commitUrlFromRemote,
  LocalSessionAggregator,
  repoNameFromRemote,
  RepoNameResolver,
} from './local-session-aggregator.js';
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

/** Stub resolver so tests never shell out to git. */
class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function summariesOf(
  agg: LocalSessionAggregator,
  outcome = 'in progress',
  toolUseIdToAgentId?: ReadonlyMap<string, string>,
) {
  return agg.toSummaries({
    developer: 'tester',
    platform: 'copilot',
    outcome,
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
    ...(toolUseIdToAgentId !== undefined ? { toolUseIdToAgentId } : {}),
  });
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

  it('leaves model null when a session spans several models', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-opus-4.8' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-sonnet-4.6' });
    expect(summariesOf(agg)[0]?.model).toBeNull();
  });

  // A token-only rollup would be filtered out of /api/sessions anyway, which
  // requires toolCallCount > 0 — writing it just burns a file.
  it('does not emit a summary for a session with no tool calls', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, inputTokens: 500 });
    expect(agg.size()).toBe(1);
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

describe('repoNameFromRemote', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
  ])('parses %s', (remote, expected) => {
    expect(repoNameFromRemote(remote)).toBe(expected);
  });

  it('returns null for a missing remote', () => {
    expect(repoNameFromRemote(null)).toBeNull();
    expect(repoNameFromRemote(undefined)).toBeNull();
  });
});

describe('commitUrlFromRemote', () => {
  const hash = 'abc1234';

  it('builds a browsable URL from an SSH remote', () => {
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', hash)).toBe(
      `https://github.com/acme/widgets/commit/${hash}`,
    );
  });

  it('builds a browsable URL from an HTTPS remote', () => {
    expect(commitUrlFromRemote('https://github.com/acme/widgets.git', hash)).toBe(
      `https://github.com/acme/widgets/commit/${hash}`,
    );
  });

  it('strips embedded credentials rather than leaking them into the link', () => {
    expect(commitUrlFromRemote('https://token@github.com/acme/widgets.git', hash)).toBe(
      `https://github.com/acme/widgets/commit/${hash}`,
    );
  });

  it('supports non-github hosts', () => {
    expect(commitUrlFromRemote('git@gitlab.com:acme/widgets.git', hash)).toBe(
      `https://gitlab.com/acme/widgets/commit/${hash}`,
    );
  });

  it('returns null when the remote or hash is unusable, so the UI shows plain text', () => {
    expect(commitUrlFromRemote(null, hash)).toBeNull();
    expect(commitUrlFromRemote('/srv/local/repo.git', hash)).toBeNull();
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', '')).toBeNull();
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

describe('LocalSessionAggregator late toolUseId backfill before scoreSession', () => {
  function recordUnattributedReads(agg: LocalSessionAggregator): void {
    // Three parallel subagents each Read the same file once. At intake the
    // hook envelope has no agentId — the toolUseId join has not caught up.
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1000,
      success: true,
      toolUseId: 'tu-agent-1',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1100,
      success: true,
      toolUseId: 'tu-agent-2',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1200,
      success: true,
      toolUseId: 'tu-agent-3',
    });
  }

  it('intake-only scoring treats unattributed parallel reads as one agent repeating', () => {
    const agg = new LocalSessionAggregator();
    recordUnattributedReads(agg);

    const [summary] = summariesOf(agg);
    const metrics = summary?.toolSelectionMetrics as {
      score: number;
      redundantReadCount: number;
    };

    // First two reads of /a.ts are free; the third is a redundant_read.
    expect(metrics.redundantReadCount).toBe(1);
    expect(metrics.score).toBeLessThan(1);
  });

  it('late-arriving toolUseId map partitions agents and drops the false redundant-read', () => {
    const agg = new LocalSessionAggregator();
    recordUnattributedReads(agg);

    const [intakeOnly] = summariesOf(agg);
    const intakeMetrics = intakeOnly?.toolSelectionMetrics as {
      score: number;
      redundantReadCount: number;
    };

    // SubagentWatcher caught up after intake (same map the anti-pattern
    // path uses at task-close). Each toolUseId belongs to a different agent.
    const lateMap = new Map<string, string>([
      ['tu-agent-1', 'agent-1'],
      ['tu-agent-2', 'agent-2'],
      ['tu-agent-3', 'agent-3'],
    ]);
    const [late] = summariesOf(agg, 'in progress', lateMap);
    const lateMetrics = late?.toolSelectionMetrics as {
      score: number;
      redundantReadCount: number;
    };

    expect(intakeMetrics.redundantReadCount).toBe(1);
    expect(intakeMetrics.score).toBeLessThan(1);
    expect(lateMetrics.redundantReadCount).toBe(0);
    expect(lateMetrics.score).toBe(1);
    expect(lateMetrics.score).toBeGreaterThan(intakeMetrics.score);
  });

  it('does not overwrite an agentId already present on the stored record', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1000,
      success: true,
      toolUseId: 'tu-keep',
      agentId: 'already-set',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1100,
      success: true,
      toolUseId: 'tu-keep',
      agentId: 'already-set',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      filePath: '/a.ts',
      timestamp: 1200,
      success: true,
      toolUseId: 'tu-keep',
      agentId: 'already-set',
    });

    const lateMap = new Map<string, string>([['tu-keep', 'should-not-win']]);
    const [summary] = summariesOf(agg, 'in progress', lateMap);
    const metrics = summary?.toolSelectionMetrics as { redundantReadCount: number };

    // Same agentId on all three reads → still one redundant_read. If the
    // map overwrote agentId with a new id, partitionByAgent would split
    // them and the count would drop to 0.
    expect(metrics.redundantReadCount).toBe(1);
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

  it('keeps a token-only session out of the summaries, as before', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    expect(summariesOf(agg)).toEqual([]);
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

describe('LocalSessionAggregator restart seeding (persistedCostBaseline)', () => {
  it('folds the persisted baseline in additively on the session’s first agentId usage', () => {
    const agg = new LocalSessionAggregator({
      persistedCostBaseline: () => ({
        estimatedCostUsd: 10,
        subagentCostUsd: 4,
        costByDayUsd: { '2026-09-10': 10 },
        subagentCostByDayUsd: { '2026-09-10': 4 },
      }),
    });
    agg.recordTokenUsage(REAL_ID, {
      costUsd: 1,
      timestamp: Date.parse('2026-09-10T12:00:00Z'),
      agentId: 'agent-1',
    });

    const [summary] = summariesOf(agg);
    // Additive: the persisted baseline (10 all-in / 4 subagent) plus this
    // turn's own $1 (also subagent-tagged), not a replacement of either.
    expect(summary?.estimatedCostUsd).toBe(11);
    expect(summary?.subagentCostUsd).toBe(5);
    expect(summary?.costByDayUsd).toEqual({ '2026-09-10': 11 });
    expect(summary?.subagentCostByDayUsd).toEqual({ '2026-09-10': 5 });
  });

  it('applies the baseline only once, not on every subsequent agentId usage', () => {
    let calls = 0;
    const agg = new LocalSessionAggregator({
      persistedCostBaseline: () => {
        calls += 1;
        return {
          estimatedCostUsd: 10,
          subagentCostUsd: 10,
          costByDayUsd: {},
          subagentCostByDayUsd: {},
        };
      },
    });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: 1000, agentId: 'agent-1' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: 2000, agentId: 'agent-1' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: 3000, agentId: 'agent-2' });

    expect(calls).toBe(1);
    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostUsd).toBe(13);
  });

  it('does not seed on rollup creation — an earlier agentId-less (parent) turn must not trigger it', () => {
    let calls = 0;
    const agg = new LocalSessionAggregator({
      persistedCostBaseline: () => {
        calls += 1;
        return null;
      },
    });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: 1000 });
    expect(calls).toBe(0);

    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: 2000, agentId: 'agent-1' });
    expect(calls).toBe(1);
  });

  it('leaves the rollup at its own accumulated total when persistedCostBaseline returns null', () => {
    const agg = new LocalSessionAggregator({ persistedCostBaseline: () => null });
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: 1000, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.estimatedCostUsd).toBe(2);
    expect(summary?.subagentCostUsd).toBe(2);
  });

  it('never seeds when no persistedCostBaseline option was given', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: 1000, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.estimatedCostUsd).toBe(2);
    expect(summary?.subagentCostUsd).toBe(2);
  });
});

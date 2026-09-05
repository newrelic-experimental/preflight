import { describe, expect, it } from '@jest/globals';
import {
  commitUrlFromRemote,
  LocalSessionAggregator,
  repoNameFromRemote,
  RepoNameResolver,
} from './local-session-aggregator.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

const REAL_ID = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';

/** Stub resolver so tests never shell out to git. */
class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function summariesOf(agg: LocalSessionAggregator, outcome = 'in progress') {
  return agg.toSummaries({
    developer: 'tester',
    platform: 'copilot',
    outcome,
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
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

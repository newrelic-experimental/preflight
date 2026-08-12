import { describe, expect, it } from '@jest/globals';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';

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
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 1, filePath: '/a.ts' });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 2, filePath: '/a.ts' });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'edit',
      timestamp: 3,
      filePath: '/b.ts',
      success: false,
    });

    const [summary] = summariesOf(agg);
    expect(summary?.filesModified).toEqual(['/a.ts', '/b.ts']);
    expect(summary?.toolSuccessRate).toBeCloseTo(2 / 3);
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

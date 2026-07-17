import { ContextTracker, ContextTrackerRegistry } from './context-tracker.js';
import type { TokenEvent, ToolCallRecord } from '../storage/types.js';

function makeTokenEvent(overrides: Partial<TokenEvent> = {}): TokenEvent {
  // Total context = inputTokens + cacheReadTokens + cacheCreationTokens
  // Default: 5000 + 30000 + 15000 = 50000 total context
  return {
    mode: 'token',
    timestamp: Date.now(),
    inputTokens: 5_000,
    outputTokens: 2_000,
    cacheReadTokens: 30_000,
    cacheCreationTokens: 15_000,
    model: 'claude-opus-4-6',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'rec-1',
    sessionId: 'sess-1',
    toolName: 'Read',
    toolUseId: 'tu-1',
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    outputSizeBytes: 4000,
    ...overrides,
  };
}

describe('ContextTracker', () => {
  let tracker: ContextTracker;

  beforeEach(() => {
    tracker = new ContextTracker({ modelContextWindow: 200_000 });
  });

  describe('recordTurn', () => {
    it('records first turn and sets baseline', () => {
      // total context = 10000 + 38000 + 12000 = 60000
      const snapshot = tracker.recordTurn(
        makeTokenEvent({
          inputTokens: 10_000,
          cacheReadTokens: 38_000,
          cacheCreationTokens: 12_000,
        }),
      );

      expect(snapshot.turnNumber).toBe(1);
      expect(snapshot.inputTokens).toBe(60_000);
      expect(snapshot.fillPercent).toBe(30);
      expect(snapshot.breakdown.system).toBe(12_000);
    });

    it('tracks growth across turns', () => {
      // total = 40000+0+0, 60000+0+0, 80000+0+0
      tracker.recordTurn(
        makeTokenEvent({ inputTokens: 40_000, cacheReadTokens: 0, cacheCreationTokens: 10_000 }),
      );
      tracker.recordTurn(
        makeTokenEvent({ inputTokens: 60_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      );
      tracker.recordTurn(
        makeTokenEvent({ inputTokens: 80_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      );

      const growth = tracker.getGrowth();
      expect(growth.startTokens).toBe(50_000); // 40000 + 0 + 10000
      expect(growth.currentTokens).toBe(80_000);
      expect(growth.deltaTokens).toBe(30_000);
    });

    it('calculates fill percent correctly', () => {
      // total = 100000 + 0 + 0 = 100000
      const snapshot = tracker.recordTurn(
        makeTokenEvent({ inputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      );
      expect(snapshot.fillPercent).toBe(50);
    });

    it('accumulates assistant tokens across turns', () => {
      // total = 50000+0+10000 = 60000
      tracker.recordTurn(
        makeTokenEvent({
          inputTokens: 50_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 10_000,
        }),
      );
      // total = 60000+0+0 = 60000
      const snap2 = tracker.recordTurn(
        makeTokenEvent({
          inputTokens: 60_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      );

      // After turn 1, assistant cumulative = 3000 (from turn 1 output)
      expect(snap2.breakdown.assistant).toBe(3_000);
    });

    it('caps history at maxHistorySize', () => {
      const small = new ContextTracker({ maxHistorySize: 3 });
      for (let i = 0; i < 5; i++) {
        small.recordTurn(
          makeTokenEvent({
            inputTokens: (i + 1) * 10_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }),
        );
      }
      const metrics = small.getMetrics();
      expect(metrics.history).toHaveLength(3);
      expect(metrics.history[0].turnNumber).toBe(3);
    });
  });

  describe('recordToolCall', () => {
    it('accumulates output bytes per tool', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 4000 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 8000 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', outputSizeBytes: 2000 }));

      const contributions = tracker.getToolContributions();
      expect(contributions).toHaveLength(2);
      expect(contributions[0].tool).toBe('Read');
      expect(contributions[0].totalBytes).toBe(12_000);
      expect(contributions[0].estimatedTokens).toBe(3_000);
      expect(contributions[1].tool).toBe('Bash');
      expect(contributions[1].totalBytes).toBe(2_000);
    });

    it('ignores records without outputSizeBytes', () => {
      tracker.recordToolCall(makeRecord({ outputSizeBytes: undefined }));
      expect(tracker.getToolContributions()).toHaveLength(0);
    });

    it('ignores records with zero outputSizeBytes', () => {
      tracker.recordToolCall(makeRecord({ outputSizeBytes: 0 }));
      expect(tracker.getToolContributions()).toHaveLength(0);
    });
  });

  describe('breakdown estimation', () => {
    it('attributes tool output to tools category', () => {
      // Record tool outputs first
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 40_000 }));
      // 40_000 bytes / 4 bytes-per-token = 10_000 tokens estimated for tools

      // total context = 10000 + 50000 + 20000 = 80000
      const snapshot = tracker.recordTurn(
        makeTokenEvent({
          inputTokens: 10_000,
          outputTokens: 5_000,
          cacheCreationTokens: 20_000,
          cacheReadTokens: 50_000,
        }),
      );

      expect(snapshot.breakdown.system).toBe(20_000);
      expect(snapshot.breakdown.tools).toBe(10_000);
      // assistant = 0 on first turn (no prior output accumulated yet)
      expect(snapshot.breakdown.assistant).toBe(0);
      // user = remainder: 80000 - 20000 - 10000 - 0 = 50000
      expect(snapshot.breakdown.user).toBe(50_000);
    });

    it('clamps categories to not exceed total input tokens', () => {
      // Create impossibly large tool output
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 1_000_000 }));

      // total context = 30000 + 0 + 10000 = 40000
      const snapshot = tracker.recordTurn(
        makeTokenEvent({
          inputTokens: 30_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 10_000,
        }),
      );

      // tools capped at total - system = 40000 - 10000 = 30000
      expect(snapshot.breakdown.tools).toBeLessThanOrEqual(30_000);
      expect(snapshot.breakdown.user).toBeGreaterThanOrEqual(0);
      const total =
        snapshot.breakdown.system +
        snapshot.breakdown.tools +
        snapshot.breakdown.user +
        snapshot.breakdown.assistant;
      expect(total).toBe(40_000);
    });
  });

  describe('getMetrics', () => {
    it('returns complete metrics snapshot', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 4000 }));
      // total = 65000 + 0 + 15000 = 80000
      tracker.recordTurn(
        makeTokenEvent({ inputTokens: 65_000, cacheReadTokens: 0, cacheCreationTokens: 15_000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.turnCount).toBe(1);
      expect(metrics.growth.startTokens).toBe(80_000);
      expect(metrics.growth.currentTokens).toBe(80_000);
      expect(metrics.growth.deltaTokens).toBe(0);
      expect(metrics.fillPercent).toBe(40);
      expect(metrics.toolContributions).toHaveLength(1);
      expect(metrics.history).toHaveLength(1);
      expect(metrics.currentBreakdown.system).toBe(15_000);
    });

    it('returns zeroed metrics when no data recorded', () => {
      const metrics = tracker.getMetrics();
      expect(metrics.turnCount).toBe(0);
      expect(metrics.growth.startTokens).toBe(0);
      expect(metrics.fillPercent).toBe(0);
      expect(metrics.currentBreakdown).toEqual({ system: 0, tools: 0, user: 0, assistant: 0 });
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 5000 }));
      tracker.recordTurn(
        makeTokenEvent({ inputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      );

      tracker.reset('new-session');

      const metrics = tracker.getMetrics();
      expect(metrics.turnCount).toBe(0);
      expect(metrics.growth.startTokens).toBe(0);
      expect(metrics.toolContributions).toHaveLength(0);
      expect(metrics.history).toHaveLength(0);
    });
  });

  describe('percentOfToolOutput', () => {
    it('calculates percentage of total tool output', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'Read', outputSizeBytes: 8000 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', outputSizeBytes: 2000 }));

      const contributions = tracker.getToolContributions();
      expect(contributions[0].percentOfToolOutput).toBe(80);
      expect(contributions[1].percentOfToolOutput).toBe(20);
    });
  });

  describe('modelContextWindow resolution', () => {
    it('grows the cap to 1M on first Opus 4.7 turn (default 200K start)', () => {
      // Construct with default options (no modelContextWindow override → 200K default)
      const fresh = new ContextTracker();
      // Initial cap is 200K
      expect(fresh.getMetrics().contextWindow).toBe(200_000);

      // First turn lands with claude-opus-4-7 (1M context window)
      fresh.recordTurn(
        makeTokenEvent({
          model: 'claude-opus-4-7',
          inputTokens: 100_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      );

      // Cap should grow from 200K → 1M
      expect(fresh.getMetrics().contextWindow).toBe(1_000_000);
    });

    it('does NOT shrink the cap when Haiku follows Opus', () => {
      // Construct with default 200K cap
      const fresh = new ContextTracker();

      // Turn 1: Opus 4.7 → cap grows to 1M
      fresh.recordTurn(
        makeTokenEvent({
          model: 'claude-opus-4-7',
          inputTokens: 605_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      );
      expect(fresh.getMetrics().contextWindow).toBe(1_000_000);
      // 605K / 1M = 60.5%
      expect(fresh.getMetrics().fillPercent).toBe(60.5);

      // Turn 2: Haiku 4.5 (200K window) at the same total context.
      // Cap must stay at 1M, not shrink to 200K — otherwise a 605K-token
      // snapshot would read as 302.5% fillPercent.
      const snapshot = fresh.recordTurn(
        makeTokenEvent({
          model: 'claude-haiku-4-5',
          inputTokens: 605_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      );

      expect(fresh.getMetrics().contextWindow).toBe(1_000_000);
      expect(fresh.getMetrics().fillPercent).toBe(60.5);
      expect(snapshot.fillPercent).toBe(60.5);
    });
  });
});

describe('ContextTrackerRegistry', () => {
  it('evicts the oldest session once maxSessions is exceeded (LRU)', () => {
    const registry = new ContextTrackerRegistry({ maxSessions: 2 });

    registry.recordTurn(
      makeTokenEvent({
        sessionId: 'sess-a',
        inputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );
    registry.recordTurn(
      makeTokenEvent({
        sessionId: 'sess-b',
        inputTokens: 20_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );
    registry.recordTurn(
      makeTokenEvent({
        sessionId: 'sess-c',
        inputTokens: 30_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );

    expect(registry.getTracker('sess-a')).toBeUndefined();
    expect(registry.getMetrics('sess-b').growth.currentTokens).toBe(20_000);
    expect(registry.getMetrics('sess-c').growth.currentTokens).toBe(30_000);
  });

  it('getMetrics() with no sessionId returns the most-recently-active tracker', () => {
    const registry = new ContextTrackerRegistry({ maxSessions: 5 });

    registry.recordTurn(
      makeTokenEvent({
        sessionId: 'sess-a',
        inputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );
    registry.recordTurn(
      makeTokenEvent({
        sessionId: 'sess-b',
        inputTokens: 90_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );

    // sess-a was created first, but sess-b was touched most recently —
    // getMetrics() with no sessionId must return sess-b's metrics, not sess-a's.
    expect(registry.getMetrics().growth.currentTokens).toBe(90_000);
  });

  it('ignores recordToolCall and recordTurn when sessionId is empty', () => {
    const registry = new ContextTrackerRegistry();

    registry.recordToolCall(makeRecord({ sessionId: '' }));
    const snapshot = registry.recordTurn(makeTokenEvent({ sessionId: '' }));

    expect(snapshot).toBeNull();
    expect(registry.getSessionIds()).toHaveLength(0);
  });
});

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TurnCostAttributor } from './turn-cost-attributor.js';
import type { ToolCallRecord, TokenEvent } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 1000,
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

function makeTokenEvent(overrides?: Partial<TokenEvent>): TokenEvent {
  return {
    mode: 'token',
    timestamp: 1100,
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: 'claude-sonnet-4-20250514',
    // Matches makeRecord()'s default sessionId — in production a token
    // event's sessionId always comes from the same underlying hook-event
    // session as the tool-call records around it (event-processor.ts's
    // handleTokenEvent), so a real recordToolCall()+recordTokenEvent() pair
    // always land in the same per-session bucket.
    sessionId: 'sess-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnCostAttributor', () => {
  describe('recordToolCall() + recordTokenEvent()', () => {
    it('attributes a token event to the most recent turn', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(1);
      expect(metrics.turns[0].toolCalls).toEqual(['toolu_001']);
      expect(metrics.turns[0].toolNames).toEqual(['Read']);
      expect(metrics.turns[0].estimatedCostUsd).toBeGreaterThan(0);
      expect(metrics.turns[0].costPerToolCall).toBe(metrics.turns[0].estimatedCostUsd);
    });

    it('groups consecutive tool calls within 2s into a single turn', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_002', toolName: 'Edit', timestamp: 1500 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1600 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(1);
      expect(metrics.turns[0].toolCalls).toEqual(['toolu_001', 'toolu_002']);
      expect(metrics.turns[0].toolNames).toEqual(['Read', 'Edit']);
      expect(metrics.turns[0].costPerToolCall).toBeCloseTo(
        metrics.turns[0].estimatedCostUsd / 2,
        10,
      );
    });

    it('starts a new turn when gap exceeds 2s', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_002', timestamp: 5000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 5100 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(2);
      expect(metrics.turns[0].toolCalls).toEqual(['toolu_001']);
      expect(metrics.turns[0].toolNames).toEqual(['Read']);
      expect(metrics.turns[1].toolCalls).toEqual(['toolu_002']);
      expect(metrics.turns[1].toolNames).toEqual(['Read']);
    });

    it('ignores token events that arrive too late (>5s after turn end)', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 7000 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(0);
    });

    it('ignores token events when no pending turn exists', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1000 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(0);
    });
  });

  describe('getMetrics()', () => {
    it('returns empty metrics initially', () => {
      const attributor = new TurnCostAttributor();
      const metrics = attributor.getMetrics();

      expect(metrics.turns).toEqual([]);
      expect(metrics.costByToolType).toEqual({});
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.attributionRate).toBe(0);
    });

    it('tracks costByToolType across multiple turns', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', toolName: 'Read', timestamp: 1000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_002', toolName: 'Read', timestamp: 5000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 5100 }));

      const metrics = attributor.getMetrics();
      expect(metrics.costByToolType['Read']).toBeDefined();
      expect(metrics.costByToolType['Read'].callCount).toBe(2);
      expect(metrics.costByToolType['Read'].avgCost).toBeGreaterThan(0);
    });

    it('calculates attributionRate correctly', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_002', timestamp: 5000 }));
      // No token event for second tool call

      const metrics = attributor.getMetrics();
      expect(metrics.attributionRate).toBe(0.5);
    });
  });

  describe('getCostForToolCall()', () => {
    it('returns cost data for an attributed tool call', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const cost = attributor.getCostForToolCall('toolu_001');
      expect(cost).not.toBeNull();
      expect(cost!.estimatedTurnCostUsd).toBeGreaterThan(0);
      expect(cost!.costPerToolCallUsd).toBeGreaterThan(0);
    });

    it('returns null for unknown tool call', () => {
      const attributor = new TurnCostAttributor();
      expect(attributor.getCostForToolCall('unknown')).toBeNull();
    });
  });

  describe('reset()', () => {
    it('clears all state', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      attributor.reset();

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toEqual([]);
      expect(metrics.costByToolType).toEqual({});
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.attributionRate).toBe(0);
    });
  });

  describe('cost calculation', () => {
    it('uses real pricing for claude-sonnet-4', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          inputTokens: 10_000,
          outputTokens: 2_000,
          model: 'claude-sonnet-4-20250514',
        }),
      );

      const metrics = attributor.getMetrics();
      // claude-sonnet-4: input=$3/MTok, output=$15/MTok
      // input:  10000 * 3 / 1_000_000 = 0.03
      // output: 2000 * 15 / 1_000_000 = 0.03
      // total = 0.06
      expect(metrics.turns[0].estimatedCostUsd).toBeCloseTo(0.06, 4);
    });
  });

  // In `--local` mode, HookEventProcessor's `drainAllSessions` feeds
  // this one process-global tracker events from every concurrently-live
  // session. Without per-session partitioning, tool calls from two sessions
  // within TURN_GAP_MS of each other would merge into a single turn
  // attributed to whichever session's record started the accumulator.
  describe('per-session isolation', () => {
    it('keeps two concurrent sessions from merging into the same turn even when interleaved within the turn gap', () => {
      const attributor = new TurnCostAttributor();

      // Session A and session B tool calls interleaved 500ms apart — well
      // within TURN_GAP_MS (2s) of each other, so a session-blind tracker
      // would merge them into one turn.
      attributor.recordToolCall(
        makeRecord({ sessionId: 'session-a', toolUseId: 'a-1', toolName: 'Read', timestamp: 1000 }),
      );
      attributor.recordToolCall(
        makeRecord({
          sessionId: 'session-b',
          toolUseId: 'b-1',
          toolName: 'Write',
          timestamp: 1500,
        }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: 'session-a', timestamp: 1100 }));
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: 'session-b', timestamp: 1600 }));

      const aMetrics = attributor.getMetrics('session-a');
      const bMetrics = attributor.getMetrics('session-b');

      expect(aMetrics.turns).toHaveLength(1);
      expect(aMetrics.turns[0].toolCalls).toEqual(['a-1']);
      expect(aMetrics.turns[0].sessionId).toBe('session-a');

      expect(bMetrics.turns).toHaveLength(1);
      expect(bMetrics.turns[0].toolCalls).toEqual(['b-1']);
      expect(bMetrics.turns[0].sessionId).toBe('session-b');
    });

    it('scopes totalAttributedCost and attributionRate to the requested session only', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ sessionId: 'session-a', toolUseId: 'a-1' }));
      attributor.recordTokenEvent(
        makeTokenEvent({
          sessionId: 'session-a',
          timestamp: 1100,
          inputTokens: 1000,
          outputTokens: 100,
        }),
      );
      attributor.recordToolCall(
        makeRecord({ sessionId: 'session-b', toolUseId: 'b-1', timestamp: 5000 }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          sessionId: 'session-b',
          timestamp: 5100,
          inputTokens: 100_000,
          outputTokens: 20_000,
        }),
      );

      const aMetrics = attributor.getMetrics('session-a');
      const bMetrics = attributor.getMetrics('session-b');

      expect(aMetrics.totalAttributedCost).toBeGreaterThan(0);
      expect(bMetrics.totalAttributedCost).toBeGreaterThan(aMetrics.totalAttributedCost);
      expect(aMetrics.attributionRate).toBe(1);
      expect(bMetrics.attributionRate).toBe(1);
    });

    it('returns empty metrics for an unknown sessionId rather than leaking another session', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ sessionId: 'session-a', toolUseId: 'a-1' }));
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: 'session-a' }));

      const metrics = attributor.getMetrics('session-does-not-exist');
      expect(metrics.turns).toEqual([]);
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.attributionRate).toBe(0);
    });

    it('getCostForToolCall finds a tool call regardless of which session it belongs to', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ sessionId: 'session-a', toolUseId: 'a-1' }));
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: 'session-a' }));
      attributor.recordToolCall(
        makeRecord({ sessionId: 'session-b', toolUseId: 'b-1', timestamp: 5000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: 'session-b', timestamp: 5100 }));

      expect(attributor.getCostForToolCall('a-1')).not.toBeNull();
      expect(attributor.getCostForToolCall('b-1')).not.toBeNull();
    });

    // Regression: no-arg getMetrics() used to fall back to whichever
    // session was most recently touched. It must instead return a real
    // aggregate across every session — matching DecisionTracker's
    // "no-arg = everything" convention — since nr_observe_get_cost_per_tool
    // (a process-wide MCP tool) calls getMetrics() with no argument and
    // expects the sum of everything, not one arbitrary session's data.
    it('getMetrics() with no sessionId aggregates totals, costByToolType, and turns across every session', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(
        makeRecord({ sessionId: 'session-a', toolUseId: 'a-1', toolName: 'Read', timestamp: 1000 }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          sessionId: 'session-a',
          timestamp: 1100,
          inputTokens: 1_000,
          outputTokens: 100,
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          sessionId: 'session-b',
          toolUseId: 'b-1',
          toolName: 'Write',
          timestamp: 5000,
        }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          sessionId: 'session-b',
          timestamp: 5100,
          inputTokens: 2_000,
          outputTokens: 200,
        }),
      );

      const aMetrics = attributor.getMetrics('session-a');
      const bMetrics = attributor.getMetrics('session-b');
      const allMetrics = attributor.getMetrics();

      // Touch session-a again last, so a "most recently touched" fallback
      // would (incorrectly) have returned session-a's data instead of the
      // aggregate — proving the result isn't just "happens to equal the last
      // session touched" by coincidence of test ordering.
      attributor.recordToolCall(
        makeRecord({ sessionId: 'session-a', toolUseId: 'a-2', toolName: 'Read', timestamp: 9000 }),
      );

      const aggregateAfterTouch = attributor.getMetrics();
      expect(aggregateAfterTouch.turns).toHaveLength(2);
      expect(allMetrics.turns).toHaveLength(2);
      expect(allMetrics.totalAttributedCost).toBeCloseTo(
        aMetrics.totalAttributedCost + bMetrics.totalAttributedCost,
        10,
      );
      expect(allMetrics.costByToolType['Read'].callCount).toBe(1);
      expect(allMetrics.costByToolType['Write'].callCount).toBe(1);
    });

    it('getMetrics() with no sessionId includes tool calls with no sessionId at all', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(
        makeRecord({ sessionId: undefined, toolUseId: 'no-session-1', timestamp: 1000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ sessionId: undefined, timestamp: 1100 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(1);
      expect(metrics.totalAttributedCost).toBeGreaterThan(0);
    });
  });
});

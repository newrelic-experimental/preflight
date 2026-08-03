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
});

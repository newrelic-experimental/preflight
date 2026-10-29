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

    it('attributes a token event that arrives long after turn end (extended thinking)', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      // 90s later — well past the old fixed 5s window, well within what
      // extended-thinking models routinely take between a tool result and
      // their next response.
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 91_050 }));

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(1);
      expect(metrics.turns[0].toolCalls).toEqual(['toolu_001']);
    });

    it('returns a response turn for a token event when no pending turn exists', () => {
      const attributor = new TurnCostAttributor();

      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1000 }));

      expect(result.calls).toEqual([]);
      expect(result.attribution.toolCalls).toEqual([]);
      expect(result.attribution.estimatedCostUsd).toBeGreaterThan(0);
      expect(result.attribution.costPerToolCall).toBe(result.attribution.estimatedCostUsd);

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(0);
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.droppedTokenEvents).toBe(0);
    });

    it('returns a response turn for a token event that predates the pending turn it would close', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', timestamp: 1000, durationMs: 500 }),
      );
      // Turn ends at 1500; an event timestamped before that can't be the
      // response that followed it.
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1200 }));

      expect(result.calls).toEqual([]);
      expect(result.attribution.estimatedCostUsd).toBeGreaterThan(0);

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(0);
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.droppedTokenEvents).toBe(0);
    });

    it('leaves the pending turn queued for the token event that does postdate it', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', timestamp: 1000, durationMs: 500 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1200 }));
      const closed = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1600 }));

      expect(closed.calls.map((c) => c.toolUseId)).toEqual(['toolu_001']);
    });

    it('stamps a response turn with the platform of the session most recent tool call', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', timestamp: 1000, platform: 'github-copilot' }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));
      const response = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 9000 }));

      expect(response.calls).toEqual([]);
      expect(response.platform).toBe('github-copilot');
    });

    it("uses the token report's own platform over the session's last tool call", () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ timestamp: 1000, platform: 'copilot' }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));
      const response = attributor.recordTokenEvent(
        makeTokenEvent({ timestamp: 9000, platform: 'claude-code' }),
      );

      expect(response.platform).toBe('claude-code');
    });

    it('keeps the last stamped platform when a later tool call carries none', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'a', timestamp: 1000, platform: 'copilot' }),
      );
      attributor.recordToolCall(makeRecord({ toolUseId: 'b', timestamp: 1500 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1600 }));
      const response = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 9000 }));

      expect(response.platform).toBe('copilot');
    });

    it('leaves a response turn platform undefined before any tool call', () => {
      const attributor = new TurnCostAttributor();

      const response = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1000 }));

      expect(response.platform).toBeUndefined();
    });

    it('queues a second burst of tool calls instead of dropping the first when its token event is still outstanding', () => {
      const attributor = new TurnCostAttributor();

      // Burst 1
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      // Burst 2 starts >2s later, before burst 1's token event has arrived —
      // this used to silently overwrite and lose burst 1 entirely.
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_002', timestamp: 5000 }));

      // Two token events arrive in order and close both bursts, oldest first.
      const result1 = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 6000 }));
      const result2 = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 6100 }));

      expect(result1.calls.map((c) => c.toolUseId)).toEqual(['toolu_001']);
      expect(result2.calls.map((c) => c.toolUseId)).toEqual(['toolu_002']);

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(2);
      expect(metrics.droppedTokenEvents).toBe(0);
    });

    it('evicts a pending turn that has sat unclosed far longer than any plausible thinking time', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      // 11 minutes later — beyond the self-heal threshold, meaning the real
      // closing event for toolu_001 must have been lost, not just delayed.
      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_002', timestamp: 1000 + 11 * 60 * 1000 }),
      );
      const result = attributor.recordTokenEvent(
        makeTokenEvent({ timestamp: 1000 + 11 * 60 * 1000 + 100 }),
      );

      // toolu_001's turn was evicted as stale; the event closes toolu_002's.
      expect(result.calls.map((c) => c.toolUseId)).toEqual(['toolu_002']);

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(1);
      expect(metrics.droppedTokenEvents).toBe(1);
    });

    it('counts a burst as dropped when only a report that predates it ever arrives before it goes stale', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', timestamp: 1000, durationMs: 500 }),
      );
      const early = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1200 }));
      const late = attributor.recordTokenEvent(
        makeTokenEvent({ timestamp: 1500 + 11 * 60 * 1000 }),
      );

      expect(early.calls).toEqual([]);
      expect(late.calls).toEqual([]);
      expect(early.id).not.toBe(late.id);
      const metrics = attributor.getMetrics();
      expect(metrics.turns).toHaveLength(0);
      expect(metrics.droppedTokenEvents).toBe(1);
    });

    it('evicts the oldest queued burst once more than MAX_PENDING_TURNS bursts are outstanding', () => {
      const attributor = new TurnCostAttributor();

      // 21 separate bursts (>2s apart, so each queues separately), no token
      // events in between — this is the "token events stopped arriving
      // entirely" safety valve, not the normal extended-thinking case.
      for (let i = 0; i < 21; i++) {
        attributor.recordToolCall(
          makeRecord({ toolUseId: `toolu_${i}`, timestamp: 1000 + i * 3000 }),
        );
      }

      const metrics = attributor.getMetrics();
      expect(metrics.droppedTokenEvents).toBe(1);

      // The oldest (toolu_0) was evicted; the next token event closes
      // whatever is now the front of the queue (toolu_1).
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1000 + 21 * 3000 }));
      expect(result.calls.map((c) => c.toolUseId)).toEqual(['toolu_1']);
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
      expect(metrics.droppedTokenEvents).toBe(0);
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

      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 9000 })); // dropped, no pending turn

      attributor.reset();

      const metrics = attributor.getMetrics();
      expect(metrics.turns).toEqual([]);
      expect(metrics.costByToolType).toEqual({});
      expect(metrics.totalAttributedCost).toBe(0);
      expect(metrics.attributionRate).toBe(0);
      expect(metrics.droppedTokenEvents).toBe(0);
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

  describe('costBySkill', () => {
    it('two skills in one turn split cost and tokens evenly and each get their duration', () => {
      const attributor = new TurnCostAttributor();
      const skill1 = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };
      const skill2 = { name: 'pstack:how', source: 'tool' as const, runId: 'run-2' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill1,
          skillName: skill1.name,
          durationMs: 1000,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill2,
          skillName: skill2.name,
          durationMs: 2000,
          timestamp: 1500,
          toolUseId: 'skill-2',
        }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          timestamp: 3500,
          inputTokens: 20_000,
          outputTokens: 4_000,
        }),
      );

      const metrics = attributor.getMetrics();
      const skills = metrics.costBySkill;

      expect(Object.keys(skills)).toHaveLength(2);
      expect(skills['code-review']).toBeDefined();
      expect(skills['pstack:how']).toBeDefined();

      const totalCost = metrics.turns[0].estimatedCostUsd;
      expect(skills['code-review'].totalCost).toBeCloseTo(totalCost / 2, 10);
      expect(skills['pstack:how'].totalCost).toBeCloseTo(totalCost / 2, 10);

      expect(skills['code-review'].totalDurationMs).toBe(1000);
      expect(skills['pstack:how'].totalDurationMs).toBe(2000);

      expect(skills['code-review'].callCount).toBe(1);
      expect(skills['pstack:how'].callCount).toBe(1);

      expect(skills['code-review'].attributedCallCount).toBe(1);
      expect(skills['pstack:how'].attributedCallCount).toBe(1);
    });

    it('a skill in a turn with no token event has attributedCallCount 0, avgCost 0, but real callCount and totalDurationMs', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'design', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          durationMs: 500,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      const metrics = attributor.getMetrics();

      expect(metrics.costBySkill.design).toEqual({
        callCount: 1,
        attributedCallCount: 0,
        totalCost: 0,
        avgCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalDurationMs: 500,
        tokens: 0,
      });
      expect(metrics.costByToolType).toEqual({});
      expect(metrics.attributionRate).toBe(0);
    });

    it('tokens equals inputTokens + outputTokens + cacheReadTokens for a live entry', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'design', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 50,
        }),
      );

      const entry = attributor.getMetrics().costBySkill.design!;
      expect(entry.tokens).toBe(entry.inputTokens + entry.outputTokens + entry.cacheReadTokens);
      expect(entry.tokens).toBe(1050);
    });

    it('cacheCreationTokens are distributed and included in tokens for skills and tool types', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'design', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 50,
          cacheCreationTokens: 200,
        }),
      );

      const metrics = attributor.getMetrics();
      const skillEntry = metrics.costBySkill.design!;
      expect(skillEntry.cacheCreationTokens).toBe(200);
      expect(skillEntry.tokens).toBe(900 + 100 + 50 + 200);

      const toolEntry = metrics.costByToolType['Skill']!;
      expect(toolEntry.inputTokens).toBe(900);
      expect(toolEntry.outputTokens).toBe(100);
      expect(toolEntry.cacheReadTokens).toBe(50);
      expect(toolEntry.cacheCreationTokens).toBe(200);
      expect(toolEntry.tokens).toBe(900 + 100 + 50 + 200);
    });

    it('with only Skill calls in runs, costByToolType.Skill equals the sum of costBySkill rows', () => {
      const attributor = new TurnCostAttributor();
      const skill1 = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };
      const skill2 = { name: 'design', source: 'tool' as const, runId: 'run-2' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill1,
          skillName: skill1.name,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill2,
          skillName: skill2.name,
          timestamp: 1500,
          toolUseId: 'skill-2',
        }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 2100 }));

      const metrics = attributor.getMetrics();
      const skillCostSum = Object.values(metrics.costBySkill).reduce(
        (sum, skill) => sum + skill.totalCost,
        0,
      );

      expect(metrics.costByToolType['Skill'].totalCost).toBeCloseTo(skillCostSum, 10);
    });

    it('Skill with no activeSkill is absent from costBySkill and present in costByToolType.Skill', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          durationMs: 100,
          timestamp: 1000,
          toolUseId: 'skill-noname',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          timestamp: 1200,
          toolUseId: 'skill-named',
        }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1300 }));

      const metrics = attributor.getMetrics();

      expect(Object.keys(metrics.costBySkill)).toEqual(['code-review']);

      expect(metrics.costByToolType['Skill'].callCount).toBe(2);

      expect(metrics.turns[0].toolNames).toContain('Skill');
    });

    it('no-arg getMetrics() merges costBySkill across sessions', () => {
      const attributor = new TurnCostAttributor();
      const skill1 = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };
      const skill2 = { name: 'code-review', source: 'tool' as const, runId: 'run-2' };
      const skill3 = { name: 'design', source: 'tool' as const, runId: 'run-3' };

      attributor.recordToolCall(
        makeRecord({
          sessionId: 'session-a',
          toolName: 'Skill',
          activeSkill: skill1,
          skillName: skill1.name,
          timestamp: 1000,
          toolUseId: 'a-skill-1',
        }),
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
          toolName: 'Skill',
          activeSkill: skill2,
          skillName: skill2.name,
          timestamp: 5000,
          toolUseId: 'b-skill-1',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          sessionId: 'session-b',
          toolName: 'Skill',
          activeSkill: skill3,
          skillName: skill3.name,
          timestamp: 5500,
          toolUseId: 'b-skill-2',
        }),
      );
      attributor.recordTokenEvent(
        makeTokenEvent({
          sessionId: 'session-b',
          timestamp: 5600,
          inputTokens: 2_000,
          outputTokens: 200,
        }),
      );

      const allMetrics = attributor.getMetrics();
      const skills = allMetrics.costBySkill;

      expect(skills['code-review']).toBeDefined();
      expect(skills['code-review'].callCount).toBe(2);

      expect(skills['design']).toBeDefined();
      expect(skills['design'].callCount).toBe(1);
    });

    it('returns {} costBySkill when no Skill seen', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolName: 'Read' }));
      attributor.recordTokenEvent(makeTokenEvent());

      const metrics = attributor.getMetrics();
      expect(metrics.costBySkill).toEqual({});
    });

    it('a Read inside a skill run counts toward that skill and toward costByToolType.Read', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          skillName: 'code-review',
          activeSkill: skill,
          durationMs: 100,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Read',
          activeSkill: skill,
          durationMs: 300,
          timestamp: 1200,
          toolUseId: 'read-1',
        }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1600 }));

      const metrics = attributor.getMetrics();
      const turnCost = metrics.turns[0].estimatedCostUsd;
      const entry = metrics.costBySkill['code-review'];
      expect(entry.callCount).toBe(1);
      expect(entry.attributedCallCount).toBe(2);
      expect(entry.totalCost).toBeCloseTo(turnCost, 10);
      expect(entry.avgCost).toBeCloseTo(turnCost, 10);
      expect(entry.totalDurationMs).toBe(400);
      expect(metrics.costByToolType['Read'].totalCost).toBeCloseTo(turnCost / 2, 10);
    });

    it("a subagent's time counts once, through its own calls and not its Agent call", () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'code-review', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Read',
          agentId: 'sub-1',
          activeSkill: skill,
          durationMs: 300,
          timestamp: 1000,
          toolUseId: 'read-1',
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Agent',
          activeSkill: skill,
          durationMs: 600,
          timestamp: 1400,
          toolUseId: 'agent-1',
        }),
      );

      const metrics = attributor.getMetrics();
      expect(metrics.costBySkill['code-review'].totalDurationMs).toBe(300);
    });

    it('a nameless Skill call inside a run is not an invocation of the outer skill', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'code-review', source: 'slash' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({ toolName: 'Skill', activeSkill: skill, timestamp: 1000 }),
      );

      expect(attributor.getMetrics().costBySkill['code-review'].callCount).toBe(1);
    });

    it('slash run cost comes from its stamped tool calls', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'simplify', source: 'slash' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_001', activeSkill: skill, timestamp: 1000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));
      attributor.recordToolCall(
        makeRecord({ toolUseId: 'toolu_002', activeSkill: skill, timestamp: 5000 }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 5100 }));

      const metrics = attributor.getMetrics();
      const entry = metrics.costBySkill.simplify;
      expect(entry.callCount).toBe(1);
      expect(entry.attributedCallCount).toBe(2);
      expect(entry.totalCost).toBeCloseTo(metrics.totalAttributedCost, 10);
    });

    it('reset() clears costBySkill state', () => {
      const attributor = new TurnCostAttributor();
      const skill = { name: 'design', source: 'tool' as const, runId: 'run-1' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          timestamp: 1000,
          toolUseId: 'skill-1',
        }),
      );
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      attributor.reset();

      const metrics = attributor.getMetrics();
      expect(metrics.costBySkill).toEqual({});
      expect(metrics.costByToolType).toEqual({});
    });
  });

  describe('skill invocation counts', () => {
    it('counts one invocation per run id, across tool and slash runs of the same skill', () => {
      const attributor = new TurnCostAttributor();
      const toolRun = { name: 'design', source: 'tool' as const, runId: 'run-1' };
      const slashRun = { name: 'design', source: 'slash' as const, runId: 'run-2' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          skillName: 'design',
          activeSkill: toolRun,
          timestamp: 1000,
        }),
      );
      attributor.recordToolCall(makeRecord({ activeSkill: toolRun, timestamp: 1500 }));
      attributor.recordToolCall(makeRecord({ activeSkill: slashRun, timestamp: 5000 }));

      expect(attributor.getMetrics().costBySkill.design.callCount).toBe(2);
    });

    it('aggregates runs across sessions in no-arg getMetrics()', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({
          sessionId: 'sess-001',
          activeSkill: { name: 'code-review', source: 'slash', runId: 'run-1' },
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          sessionId: 'sess-002',
          activeSkill: { name: 'code-review', source: 'slash', runId: 'run-2' },
        }),
      );

      expect(attributor.getMetrics().costBySkill['code-review'].callCount).toBe(2);
      expect(attributor.getMetrics('sess-001').costBySkill['code-review'].callCount).toBe(1);
    });

    it('a run recorded at open with no tool calls still gets a costBySkill row', () => {
      const attributor = new TurnCostAttributor();
      const run = { name: 'loop', source: 'slash' as const, runId: 'run-1' };

      attributor.recordSkillRun('sess-001', run);
      attributor.recordToolCall(makeRecord({ activeSkill: run, timestamp: 1000 }));

      const entry = attributor.getMetrics().costBySkill.loop;
      expect(entry.callCount).toBe(1);
      attributor.recordSkillRun('sess-001', { ...run, runId: 'run-2' });
      expect(attributor.getMetrics().costBySkill.loop.callCount).toBe(2);
      expect(attributor.getMetrics().costBySkill.loop.attributedCallCount).toBe(0);
    });

    it('a call outside any run belongs to no skill', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const metrics = attributor.getMetrics();
      expect(metrics.costBySkill).toEqual({});
      expect(metrics.costByToolType.Read.totalCost).toBeCloseTo(metrics.totalAttributedCost, 10);
    });
  });

  describe('recordTokenEvent() return value (ClosedTurn)', () => {
    it('closes the turn even when the token event arrives well outside the old fixed window', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 7000 }));
      expect(result.calls).not.toHaveLength(0);
    });

    it('returns ClosedTurn with id on successful attribution', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      expect(result.calls).not.toHaveLength(0);
      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(20);
    });

    it('returns different ids for two closed turns', () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result1 = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_002', timestamp: 5000 }));
      const result2 = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 5100 }));

      expect(result1.calls).not.toHaveLength(0);
      expect(result2.calls).not.toHaveLength(0);
      expect(result1.id).not.toBe(result2.id);
    });

    it('returned calls carry skill for records inside a skill run', () => {
      const attributor = new TurnCostAttributor();
      const skillStamp = { name: 'code-review', source: 'tool' as const, runId: 'run-001' };

      attributor.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skillStamp,
          skillName: skillStamp.name,
          toolUseId: 'skill-1',
          timestamp: 1000,
        }),
      );
      attributor.recordToolCall(
        makeRecord({
          toolName: 'Read',
          activeSkill: skillStamp,
          toolUseId: 'read-1',
          timestamp: 1500,
        }),
      );
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1600 }));

      expect(result.calls).toHaveLength(2);

      const skillCall = result.calls.find((c) => c.toolName === 'Skill');
      expect(skillCall).toBeDefined();
      expect(skillCall!.skill).not.toBeNull();
      expect(skillCall!.skill!.name).toBe('code-review');

      const readCall = result.calls.find((c) => c.toolName === 'Read');
      expect(readCall).toBeDefined();
      expect(readCall!.skill).not.toBeNull();
      expect(readCall!.skill!.name).toBe('code-review');
    });

    it("platform is the first record's platform when stamped", () => {
      const attributor = new TurnCostAttributor();

      attributor.recordToolCall(
        makeRecord({
          toolUseId: 'toolu_001',
          timestamp: 1000,
          platform: 'copilot-app',
        }),
      );
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      expect(result.calls).not.toHaveLength(0);
      expect(result.platform).toBe('copilot-app');
    });

    it('platform is undefined when no record carries a stamp', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      expect(result.calls).not.toHaveLength(0);
      expect(result.platform).toBeUndefined();
    });

    it('attribution deep-equals the last entry of getMetrics().turns', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result = attributor.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const metrics = attributor.getMetrics();
      expect(result.calls).not.toHaveLength(0);
      expect(result.attribution).toEqual(metrics.turns[metrics.turns.length - 1]);
    });

    it('attribution includes cacheCreationTokens', () => {
      const attributor = new TurnCostAttributor();
      attributor.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result = attributor.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          cacheCreationTokens: 500,
        }),
      );

      expect(result.calls).not.toHaveLength(0);
      expect(result.attribution.cacheCreationTokens).toBe(500);
    });

    it('rateMultiplier: 1.5 scales costUsd by 1.5 in returned attribution', () => {
      const attributor1x = new TurnCostAttributor({ rateMultiplier: 1 });
      attributor1x.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result1x = attributor1x.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          inputTokens: 10_000,
          outputTokens: 2_000,
        }),
      );

      const attributor15x = new TurnCostAttributor({ rateMultiplier: 1.5 });
      attributor15x.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      const result15x = attributor15x.recordTokenEvent(
        makeTokenEvent({
          timestamp: 1100,
          inputTokens: 10_000,
          outputTokens: 2_000,
        }),
      );

      expect(result1x.calls).not.toHaveLength(0);
      expect(result15x.calls).not.toHaveLength(0);
      expect(result15x.attribution.estimatedCostUsd).toBeCloseTo(
        result1x.attribution.estimatedCostUsd * 1.5,
        10,
      );
      expect(result15x.attribution.costPerToolCall).toBeCloseTo(
        result1x.attribution.costPerToolCall * 1.5,
        10,
      );
    });

    it('rateMultiplier scales costBySkill in returned attribution', () => {
      const skill = { name: 'test', source: 'tool' as const, runId: 'run-1' };
      const attributor1x = new TurnCostAttributor({ rateMultiplier: 1 });
      attributor1x.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          toolUseId: 'skill-1',
          timestamp: 1000,
        }),
      );
      attributor1x.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const attributor15x = new TurnCostAttributor({ rateMultiplier: 1.5 });
      attributor15x.recordToolCall(
        makeRecord({
          toolName: 'Skill',
          activeSkill: skill,
          skillName: skill.name,
          toolUseId: 'skill-1',
          timestamp: 1000,
        }),
      );
      attributor15x.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const metrics1x = attributor1x.getMetrics();
      const metrics15x = attributor15x.getMetrics();

      expect(metrics15x.costBySkill['test'].totalCost).toBeCloseTo(
        metrics1x.costBySkill['test'].totalCost * 1.5,
        10,
      );
    });

    it('rateMultiplier scales totalAttributedCost', () => {
      const attributor1x = new TurnCostAttributor({ rateMultiplier: 1 });
      attributor1x.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor1x.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const attributor15x = new TurnCostAttributor({ rateMultiplier: 1.5 });
      attributor15x.recordToolCall(makeRecord({ toolUseId: 'toolu_001', timestamp: 1000 }));
      attributor15x.recordTokenEvent(makeTokenEvent({ timestamp: 1100 }));

      const metrics1x = attributor1x.getMetrics();
      const metrics15x = attributor15x.getMetrics();

      expect(metrics15x.totalAttributedCost).toBeCloseTo(metrics1x.totalAttributedCost * 1.5, 10);
    });
  });
});

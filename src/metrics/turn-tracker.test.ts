import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TurnTracker } from './turn-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'r1',
    sessionId: 's1',
    toolName: 'Read',
    toolUseId: 'u1',
    timestamp: 1000,
    durationMs: 100,
    success: true,
    ...overrides,
  } as ToolCallRecord;
}

describe('TurnTracker', () => {
  it('returns empty metrics when no calls recorded', () => {
    const t = new TurnTracker();
    const m = t.getMetrics();
    expect(m.totalTurns).toBe(0);
    expect(m.avgToolsPerTurn).toBe(0);
    expect(m.maxToolsPerTurn).toBe(0);
    expect(m.avgTurnDurationMs).toBe(0);
    expect(m.avgParallelism).toBe(0);
    expect(m.recentTurns).toHaveLength(0);
    expect(m.turnsByToolCount).toEqual({});
  });

  it('groups tool calls within 2s into the same turn', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1020, durationMs: 80 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 1060, durationMs: 40 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(1);
    expect(m.recentTurns[0]!.toolCount).toBe(3);
  });

  it('starts a new turn when gap exceeds threshold', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 100 }));
    // End of first call: 1000 + 100 = 1100
    // Gap threshold: 2000ms, so next call at 3101 starts a new turn
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 3101, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(2);
    expect(m.recentTurns[0]!.toolCount).toBe(1);
    expect(m.recentTurns[1]!.toolCount).toBe(1);
  });

  it('does not start a new turn when call arrives within gap of previous end', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 1000 }));
    // End of first call: 1000 + 1000 = 2000
    // Next call at 3999 is within 2000ms gap of 2000
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 3999, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(1);
    expect(m.recentTurns[0]!.toolCount).toBe(2);
  });

  it('uses 500ms buffer when durationMs is null', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: null }));
    // End with null duration: 1000 + 500 = 1500
    // Call at 3501 exceeds gap threshold (3501 > 1500 + 2000)
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 3501, durationMs: 100 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(2);
  });

  it('calculates parallelism for overlapping calls', () => {
    const t = new TurnTracker();
    // Three overlapping calls: all start at nearly the same time with long durations
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 500 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1010, durationMs: 500 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 1020, durationMs: 500 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(1);
    expect(m.recentTurns[0]!.parallelism).toBe(3);
  });

  it('parallelism is 1 for sequential non-overlapping calls within same turn', () => {
    const t = new TurnTracker();
    // Call 1: [1000, 1050], Call 2: [1100, 1150] — no overlap but within gap threshold
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1100, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(1);
    expect(m.recentTurns[0]!.parallelism).toBe(1);
  });

  it('returns correct turnId for each recorded call', () => {
    const t = new TurnTracker();
    const id1 = t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    const id2 = t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1020, durationMs: 50 }));

    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(0);

    // New turn
    const id3 = t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 5000, durationMs: 50 }));
    expect(id3).not.toBe(id1);
  });

  it('tracks uniqueTools per turn', () => {
    const t = new TurnTracker();
    t.recordToolCall(
      makeRecord({ toolName: 'Read', toolUseId: 'u1', timestamp: 1000, durationMs: 50 }),
    );
    t.recordToolCall(
      makeRecord({ toolName: 'Read', toolUseId: 'u2', timestamp: 1020, durationMs: 50 }),
    );
    t.recordToolCall(
      makeRecord({ toolName: 'Bash', toolUseId: 'u3', timestamp: 1040, durationMs: 50 }),
    );

    const m = t.getMetrics();
    expect(m.recentTurns[0]!.uniqueTools).toEqual(expect.arrayContaining(['Read', 'Bash']));
    expect(m.recentTurns[0]!.uniqueTools).toHaveLength(2);
  });

  it('computes turnsByToolCount histogram', () => {
    const t = new TurnTracker();
    // Turn 1: 2 calls
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1020, durationMs: 50 }));
    // Turn 2: 1 call
    t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 5000, durationMs: 50 }));
    // Turn 3: 1 call
    t.recordToolCall(makeRecord({ toolUseId: 'u4', timestamp: 10000, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.turnsByToolCount[2]).toBe(1);
    expect(m.turnsByToolCount[1]).toBe(2);
  });

  it('computes avgToolsPerTurn and maxToolsPerTurn', () => {
    const t = new TurnTracker();
    // Turn 1: 3 calls
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1020, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 1040, durationMs: 50 }));
    // Turn 2: 1 call
    t.recordToolCall(makeRecord({ toolUseId: 'u4', timestamp: 5000, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.avgToolsPerTurn).toBe(2);
    expect(m.maxToolsPerTurn).toBe(3);
  });

  it('limits recentTurns to last 20', () => {
    const t = new TurnTracker();
    for (let i = 0; i < 25; i++) {
      t.recordToolCall(makeRecord({ toolUseId: `u${i}`, timestamp: i * 5000, durationMs: 50 }));
    }

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(25);
    expect(m.recentTurns).toHaveLength(20);
    expect(m.recentTurns[0]!.turnNumber).toBe(6);
  });

  it('reset clears all state', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 5000, durationMs: 50 }));

    t.reset('new-session');

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(0);
    expect(m.recentTurns).toHaveLength(0);
  });

  it('respects custom gapThresholdMs', () => {
    const t = new TurnTracker({ gapThresholdMs: 500 });
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 100 }));
    // End: 1100. Gap: 500. Next call at 1601 starts new turn.
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1601, durationMs: 50 }));

    const m = t.getMetrics();
    expect(m.totalTurns).toBe(2);
  });

  it('computes turn durationMs correctly', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 200 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1050, durationMs: 300 }));
    // endTime = max(1000+200, 1050+300) = 1350
    // durationMs = 1350 - 1000 = 350

    const m = t.getMetrics();
    expect(m.recentTurns[0]!.startTime).toBe(1000);
    expect(m.recentTurns[0]!.endTime).toBe(1350);
    expect(m.recentTurns[0]!.durationMs).toBe(350);
  });

  it('getCurrentTurnNumber returns 0 when no calls recorded', () => {
    const t = new TurnTracker();
    expect(t.getCurrentTurnNumber()).toBe(0);
  });

  it('getCurrentTurnNumber reflects the in-progress turn', () => {
    const t = new TurnTracker();
    t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
    expect(t.getCurrentTurnNumber()).toBe(1);

    // Start turn 2
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 5000, durationMs: 50 }));
    expect(t.getCurrentTurnNumber()).toBe(2);
  });

  describe('finalizeTurnAt()', () => {
    it('is a no-op when no turn is open', () => {
      const t = new TurnTracker();
      t.finalizeTurnAt(1000);
      expect(t.getMetrics().totalTurns).toBe(0);
    });

    it('finalizes the open turn immediately, without waiting for the gap threshold', () => {
      const t = new TurnTracker();
      t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
      t.finalizeTurnAt(1200);

      const m = t.getMetrics();
      expect(m.totalTurns).toBe(1);
      expect(m.recentTurns[0]!.toolCount).toBe(1);
      expect(t.getCurrentTurnNumber()).toBe(0);
    });

    it('extends the turn end time to the Stop timestamp when it is later than the last tool call', () => {
      const t = new TurnTracker();
      t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
      // Last tool call ends at 1050; Stop fires later, after response generation.
      t.finalizeTurnAt(1800);

      const m = t.getMetrics();
      expect(m.recentTurns[0]!.startTime).toBe(1000);
      expect(m.recentTurns[0]!.endTime).toBe(1800);
      expect(m.recentTurns[0]!.durationMs).toBe(800);
    });

    it('never shrinks the turn end time when the Stop timestamp is earlier (clock skew)', () => {
      const t = new TurnTracker();
      t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 500 }));
      // Last tool call ends at 1500; a skewed/late-arriving Stop claims an earlier time.
      t.finalizeTurnAt(1100);

      const m = t.getMetrics();
      expect(m.recentTurns[0]!.endTime).toBe(1500);
      expect(m.recentTurns[0]!.durationMs).toBe(500);
    });

    it('prevents two quick consecutive turns from merging into one', () => {
      const t = new TurnTracker();
      t.recordToolCall(makeRecord({ toolUseId: 'u1', timestamp: 1000, durationMs: 50 }));
      t.finalizeTurnAt(1100);

      // Second turn's first tool call arrives well within the gap threshold of
      // the first turn's end — without finalizeTurnAt, this would merge into turn 1.
      t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 1150, durationMs: 50 }));

      const m = t.getMetrics();
      expect(m.totalTurns).toBe(2);
      expect(m.recentTurns[0]!.toolCount).toBe(1);
      expect(m.recentTurns[1]!.toolCount).toBe(1);
      expect(t.getCurrentTurnNumber()).toBe(2);
    });
  });
});

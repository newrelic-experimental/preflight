import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LatencyTracker } from './latency-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('LatencyTracker', () => {
  function makeRecord(
    overrides: {
      toolName: string;
      durationMs: number;
      success: boolean;
    } & Partial<ToolCallRecord>,
  ): ToolCallRecord {
    return {
      id: 'r1',
      sessionId: 's1',
      toolUseId: 'u1',
      timestamp: 1000,
      ...overrides,
    } as ToolCallRecord;
  }

  it('returns null overall for empty tracker', () => {
    const t = new LatencyTracker();
    expect(t.getMetrics().overall).toBeNull();
  });

  it('single call sets p50/p95/p99 to that duration', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 200, success: true }));
    const m = t.getMetrics();
    expect(m.overall?.p50).toBe(200);
    expect(m.overall?.p95).toBe(200);
    expect(m.overall?.p99).toBe(200);
    expect(m.overall?.count).toBe(1);
    expect(m.overall?.min).toBe(200);
    expect(m.overall?.max).toBe(200);
  });

  it('ignores calls with null durationMs', () => {
    const t = new LatencyTracker();
    t.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: null as unknown as number, success: true }),
    );
    expect(t.getMetrics().overall).toBeNull();
  });

  it('ignores calls with undefined durationMs', () => {
    const t = new LatencyTracker();
    t.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: undefined as unknown as number, success: true }),
    );
    expect(t.getMetrics().overall).toBeNull();
  });

  it('multiple calls produce correct p50', () => {
    const t = new LatencyTracker();
    // sorted: [100, 200, 300, 400, 500] → p50 = index floor(5 * 0.5) = 2 → 300
    for (const d of [300, 100, 500, 200, 400]) {
      t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: d, success: true }));
    }
    const m = t.getMetrics();
    expect(m.overall?.p50).toBe(300);
    expect(m.overall?.min).toBe(100);
    expect(m.overall?.max).toBe(500);
    expect(m.overall?.count).toBe(5);
  });

  it('byTool breakdown uses tool-specific samples', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 50, success: true }));
    t.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 500, success: true }));
    const m = t.getMetrics();
    expect(m.byTool['Read']?.p50).toBe(50);
    expect(m.byTool['Bash']?.p50).toBe(500);
    expect(m.byTool['Read']?.count).toBe(1);
  });

  it('slowestCalls is sorted descending by duration', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 100, success: true }));
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 500, success: true }));
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 250, success: true }));
    const { slowestCalls } = t.getMetrics();
    expect(slowestCalls[0].durationMs).toBe(500);
    expect(slowestCalls[1].durationMs).toBe(250);
    expect(slowestCalls[2].durationMs).toBe(100);
  });

  it('slowestCalls is capped at 10 entries', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 15; i++) {
      t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: i * 10, success: true }));
    }
    const { slowestCalls } = t.getMetrics();
    expect(slowestCalls).toHaveLength(10);
    expect(slowestCalls[0].durationMs).toBe(150);
    expect(slowestCalls[9].durationMs).toBe(60);
  });

  it('slowestCalls includes filePath when present', () => {
    const t = new LatencyTracker();
    t.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: 200, success: true, filePath: '/src/app.ts' }),
    );
    expect(t.getMetrics().slowestCalls[0].filePath).toBe('/src/app.ts');
  });

  it('reset clears all state', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 100, success: true }));
    t.reset('new-session');
    expect(t.getMetrics().overall).toBeNull();
    expect(Object.keys(t.getMetrics().byTool)).toHaveLength(0);
    expect(t.getMetrics().slowestCalls).toHaveLength(0);
  });

  it('byTool does not include tools with no valid samples', () => {
    const t = new LatencyTracker();
    // Record invalid duration for Read — it returns early and is never added to byTool
    t.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: null as unknown as number, success: true }),
    );
    // Record valid duration for Bash
    t.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 100, success: true }));
    const m = t.getMetrics();
    // Read was never added to byTool because durationMs was null
    expect(m.byTool['Read']).toBeUndefined();
    // Bash recorded with valid sample — should have data, not null
    expect(m.byTool['Bash']).not.toBeNull();
    expect(m.byTool['Bash']?.p50).toBe(100);
  });

  it('overall is null when all recorded calls have null/undefined durationMs', () => {
    const t = new LatencyTracker();
    t.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: null as unknown as number, success: true }),
    );
    t.recordToolCall(
      makeRecord({ toolName: 'Edit', durationMs: undefined as unknown as number, success: true }),
    );
    const m = t.getMetrics();
    expect(m.overall).toBeNull();
  });
});

import { LiveEventBus } from './live-event-bus.js';

describe('LiveEventBus', () => {
  it('delivers tool-call events to subscribers', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    bus.on('tool-call', (e) => received.push(e));
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 12,
      costUsd: 0.001,
      ts: 1,
    });
    expect(received).toEqual([
      { id: 'a', sessionId: 's1', tool: 'Read', durationMs: 12, costUsd: 0.001, ts: 1 },
    ]);
  });

  it('supports multiple event types independently', () => {
    const bus = new LiveEventBus();
    const tools: unknown[] = [];
    const costs: unknown[] = [];
    bus.on('tool-call', (e) => tools.push(e));
    bus.on('cost-update', (e) => costs.push(e));
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('cost-update', {
      sessionId: 's1',
      sessionTotalUsd: 0.5,
      todayTotalUsd: 1.0,
      forecastEodUsd: 2.0,
    });
    expect(tools).toHaveLength(1);
    expect(costs).toHaveLength(1);
  });

  it('off() removes a listener', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    const handler = (e: unknown) => received.push(e);
    bus.on('tool-call', handler);
    bus.off('tool-call', handler);
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    expect(received).toHaveLength(0);
  });

  it('keeps a ring buffer of the last 100 events for replay', () => {
    const bus = new LiveEventBus({ replayBufferSize: 100 });
    for (let i = 0; i < 150; i++) {
      bus.emit('tool-call', {
        id: String(i),
        sessionId: 's1',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: i,
      });
    }
    const replay = bus.replayFrom(0);
    expect(replay.length).toBe(100);
    expect((replay[0]!.payload as { id: string }).id).toBe('50');
    expect((replay[99]!.payload as { id: string }).id).toBe('149');
  });

  it('replayFrom(seq) returns events with seq > given', () => {
    const bus = new LiveEventBus();
    for (let i = 0; i < 10; i++) {
      bus.emit('tool-call', {
        id: String(i),
        sessionId: 's1',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: i,
      });
    }
    // seq starts at 1, so events have seq 1..10. replayFrom(5) returns 6..10.
    const replay = bus.replayFrom(5);
    expect(replay.length).toBe(5);
    expect((replay[0]!.payload as { id: string }).id).toBe('5');
  });

  it('first emitted event has seq=1 so replayFrom(0) returns it', () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'first',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    const replay = bus.replayFrom(0);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.seq).toBe(1);
    expect((replay[0]!.payload as { id: string }).id).toBe('first');
  });

  // The live event schema requires sessionId on the events
  // that have a single owning session. The compile-time test below would
  // fail to type-check if the sessionId field were ever removed; the runtime
  // test confirms the bus carries the field through to subscribers.
  it('carries sessionId on tool-call, cost-update, anti-pattern, and context-update', () => {
    const bus = new LiveEventBus();
    const received: Array<{ event: string; sessionId?: string }> = [];
    bus.on('tool-call', (e) => received.push({ event: 'tool-call', sessionId: e.sessionId }));
    bus.on('cost-update', (e) => received.push({ event: 'cost-update', sessionId: e.sessionId }));
    bus.on('anti-pattern', (e) => received.push({ event: 'anti-pattern', sessionId: e.sessionId }));
    bus.on('context-update', (e) =>
      received.push({ event: 'context-update', sessionId: e.sessionId }),
    );
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 'sX',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('cost-update', {
      sessionId: 'sY',
      sessionTotalUsd: 0.5,
      todayTotalUsd: 1.0,
      forecastEodUsd: null,
    });
    bus.emit('anti-pattern', { sessionId: 'sZ', type: 'thrashing', target: 'auth.ts', count: 3 });
    bus.emit('context-update', {
      sessionId: 'sQ',
      turnNumber: 1,
      totalTokens: 100,
      fillPercent: 0.1,
      contextWindow: 200_000,
      breakdown: { system: 10, tools: 20, user: 30, assistant: 40 },
      growth: { startTokens: 0, currentTokens: 100, delta: 100 },
      topTools: [],
    });
    expect(received).toEqual([
      { event: 'tool-call', sessionId: 'sX' },
      { event: 'cost-update', sessionId: 'sY' },
      { event: 'anti-pattern', sessionId: 'sZ' },
      { event: 'context-update', sessionId: 'sQ' },
    ]);
  });

  // AlertEvent.sessionId is optional — system-level alerts
  // (e.g. dashboard-server health) have no owning session.
  it('AlertEvent.sessionId is optional', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    bus.on('alert', (e) => received.push(e));
    bus.emit('alert', {
      id: 'system-alert',
      // no sessionId
      state: 'firing',
      severity: 'info',
      title: 'System',
      description: 'no session',
      value: 1,
      threshold: 0,
      firedAt: 1,
    });
    expect(received).toHaveLength(1);
  });

  it('delivers and replays alert events', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    bus.on('alert', (e) => received.push(e));
    const payload = {
      id: 'session-cost-spike',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'Session cost above $5',
      description: 'Session spend crossed the $5 threshold',
      value: 5.42,
      threshold: 5,
      firedAt: 1700000000000,
    };
    bus.emit('alert', payload);
    expect(received).toEqual([payload]);

    const replay = bus.replayFrom(0);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.event).toBe('alert');
    expect(replay[0]!.payload).toEqual(payload);
  });
});

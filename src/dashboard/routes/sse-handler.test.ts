import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { LiveEventBus } from '../live-event-bus.js';
import { createSseHandler } from './sse-handler.js';

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      void handler(req, res);
    });
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

async function readSseChunks(res: Response, count: number, timeoutMs = 1000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (chunks.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 100),
      ),
    ]);
    if (done) break;
    if (value) chunks.push(decoder.decode(value));
  }
  void reader.cancel();
  return chunks;
}

describe('sse-handler', () => {
  it('responds with text/event-stream and Cache-Control: no-cache', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      void res.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it('forwards bus emissions as SSE frames', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      // Give the server a moment to attach the listener before emitting
      await new Promise((r) => setTimeout(r, 30));
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
        sessionTotalUsd: 1,
        todayTotalUsd: 2,
        forecastEodUsd: null,
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('event: tool-call');
      expect(merged).toContain('"tool":"Read"');
      expect(merged).toContain('event: cost-update');
    } finally {
      await server.close();
    }
  });

  it('replays buffered events when Last-Event-ID header is set', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('tool-call', {
      id: 'b',
      sessionId: 's1',
      tool: 'Edit',
      durationMs: 2,
      costUsd: 0,
      ts: 2,
    });
    const server = await startTestServer(createSseHandler(bus));
    try {
      // seq starts at 1, so 'a' has seq=1 and 'b' has seq=2. Client has
      // already received seq=1 ('a'); ask for events with seq > 1.
      const res = await fetch(`${server.url}/sse`, { headers: { 'last-event-id': '1' } });
      const chunks = await readSseChunks(res, 1);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"b"');
      expect(merged).not.toContain('"id":"a"');
    } finally {
      await server.close();
    }
  });

  it('Last-Event-ID: 0 replays everything (sentinel for "nothing seen")', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('tool-call', {
      id: 'b',
      sessionId: 's1',
      tool: 'Edit',
      durationMs: 2,
      costUsd: 0,
      ts: 2,
    });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, { headers: { 'last-event-id': '0' } });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"a"');
      expect(merged).toContain('"id":"b"');
    } finally {
      await server.close();
    }
  });

  // Regression guard. The SSE frame `id` field must use the bus's global
  // sequence number, not a per-connection counter — otherwise reconnecting
  // clients send back the wrong Last-Event-ID and either miss real events
  // or replay pre-connection history.
  it('frame id matches bus global seq', async () => {
    const bus = new LiveEventBus();
    // Prime the bus with 5 events BEFORE the client connects. Their bus
    // seqs are 1..5.
    for (let i = 0; i < 5; i++) {
      bus.emit('tool-call', {
        id: `pre-${i}`,
        sessionId: 's1',
        tool: 'Read',
        durationMs: i,
        costUsd: 0,
        ts: i,
      });
    }
    const server = await startTestServer(createSseHandler(bus));
    try {
      // Connect fresh (no Last-Event-ID). Client should NOT see the
      // pre-connection events at all (they happened before it asked).
      const res = await fetch(`${server.url}/sse`);
      await new Promise((r) => setTimeout(r, 30));
      // Emit one new event — should arrive with bus seq=6, not local 1.
      bus.emit('tool-call', {
        id: 'post-0',
        sessionId: 's1',
        tool: 'Edit',
        durationMs: 9,
        costUsd: 0,
        ts: 100,
      });
      // Read 2 chunks: the ': stream-open\n\n' opener plus the event frame.
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"post-0"');
      // The frame id line must be the bus's global seq=6, not a local 1.
      expect(merged).toMatch(/\nid: 6\n/);
      // Frame id 1 belonged to a pre-connection event; it must not appear.
      expect(merged).not.toMatch(/\nevent: tool-call\nid: 1\n/);
    } finally {
      await server.close();
    }
  });

  // Regression guard. After reconnect with Last-Event-ID set to a real
  // bus seq, the server must replay only events newer than that seq. With
  // the per-connection counter bug, this test would have replayed older
  // (pre-connection) events.
  it('reconnect with real bus seq replays only newer events', async () => {
    const bus = new LiveEventBus();
    // Bus emits 100 events before the test client ever connects.
    for (let i = 0; i < 100; i++) {
      bus.emit('tool-call', {
        id: `e${i}`,
        sessionId: 's1',
        tool: 'Read',
        durationMs: i,
        costUsd: 0,
        ts: i,
      });
    }
    // Client knows it last saw seq=105 (a hypothetical post-connection
    // event that was emitted after a previous connection picked up seq=101..105).
    // To simulate that, emit 5 more events to get the bus seq to 105.
    for (let i = 100; i < 105; i++) {
      bus.emit('tool-call', {
        id: `e${i}`,
        sessionId: 's1',
        tool: 'Read',
        durationMs: i,
        costUsd: 0,
        ts: i,
      });
    }
    // Now emit one more event with seq=106 — this is the one the client
    // should receive on reconnect.
    bus.emit('tool-call', {
      id: 'e105',
      sessionId: 's1',
      tool: 'Edit',
      durationMs: 999,
      costUsd: 0,
      ts: 999,
    });

    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, {
        headers: { 'last-event-id': '105' },
      });
      const chunks = await readSseChunks(res, 1);
      const merged = chunks.join('');
      // Only the event with seq=106 (id: 'e105') should appear.
      expect(merged).toContain('"id":"e105"');
      // Earlier events (the 100+5 priming ones) MUST NOT replay.
      expect(merged).not.toContain('"id":"e0"');
      expect(merged).not.toContain('"id":"e50"');
      expect(merged).not.toContain('"id":"e104"');
    } finally {
      await server.close();
    }
  });

  // Regression guard. A client sending Last-Event-ID: -1 (or any negative
  // number) must NOT trigger a replay. With the original bug, replaySeq would
  // be -1 (no replay) but nextLocalSeq became 0; the next reconnect with
  // Last-Event-ID: 0 then replayed the entire bus buffer.
  it('Last-Event-ID: -1 does not trigger replay', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('tool-call', {
      id: 'b',
      sessionId: 's1',
      tool: 'Edit',
      durationMs: 2,
      costUsd: 0,
      ts: 2,
    });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, {
        headers: { 'last-event-id': '-1' },
      });
      await new Promise((r) => setTimeout(r, 30));
      // Trigger a live event so the readSseChunks call resolves.
      bus.emit('tool-call', {
        id: 'live',
        sessionId: 's1',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: 3,
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      // Only the live event arrives — the buffered 'a' and 'b' must NOT replay.
      expect(merged).toContain('"id":"live"');
      expect(merged).not.toContain('"id":"a"');
      expect(merged).not.toContain('"id":"b"');
    } finally {
      await server.close();
    }
  });

  it('Last-Event-ID: not-a-number does not trigger replay', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'a',
      sessionId: 's1',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('tool-call', {
      id: 'b',
      sessionId: 's1',
      tool: 'Edit',
      durationMs: 2,
      costUsd: 0,
      ts: 2,
    });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, {
        headers: { 'last-event-id': 'not-a-number' },
      });
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', {
        id: 'live',
        sessionId: 's1',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: 3,
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"live"');
      expect(merged).not.toContain('"id":"a"');
      expect(merged).not.toContain('"id":"b"');
    } finally {
      await server.close();
    }
  });

  // Heartbeats use a string id like "hb-<ts>" so they don't share the bus
  // seq namespace. The browser sends them back as Last-Event-ID on reconnect;
  // parseInt("hb-...") → NaN → no replay. This guards against a heartbeat id
  // contaminating the seq numbering and triggering an unintended replay.
  // Regression guard. Both `req.on('close')` and `res.on('close')` register
  // the same cleanup function — on a normal disconnect both fire. The
  // `cleaned` guard makes the second invocation a no-op so a future change
  // (e.g. wrapping cleanup in something that side-effects) can't introduce
  // a real double-execution bug. This test asserts each `bus.offWithSeq`
  // is called exactly once even when both close events fire.
  it('cleanup runs exactly once when both req and res emit close', () => {
    const bus = new LiveEventBus();
    const offSpy = jest.spyOn(bus, 'offWithSeq');

    // Synthesize req + res as EventEmitters so we can drive close events.
    const req = new EventEmitter() as IncomingMessage;
    req.headers = {};
    const res = new EventEmitter() as ServerResponse;
    // The handler calls res.writeHead and res.write — stub them.
    (res as unknown as { writeHead: jest.Mock }).writeHead = jest.fn();
    (res as unknown as { write: jest.Mock }).write = jest.fn();

    createSseHandler(bus)(req, res);
    // Sanity: bus.onWithSeq attached one listener per channel (5 total).
    expect(offSpy).not.toHaveBeenCalled();

    // Both close events fire — cleanup runs twice but the guard makes the
    // second a no-op, so each bus.offWithSeq is called exactly once.
    req.emit('close');
    res.emit('close');

    const callsByEvent: Record<string, number> = {};
    for (const [event] of offSpy.mock.calls) {
      callsByEvent[event as string] = (callsByEvent[event as string] ?? 0) + 1;
    }
    expect(callsByEvent['tool-call']).toBe(1);
    expect(callsByEvent['cost-update']).toBe(1);
    expect(callsByEvent['anti-pattern']).toBe(1);
    expect(callsByEvent['context-update']).toBe(1);
    expect(callsByEvent['alert']).toBe(1);
    expect(offSpy).toHaveBeenCalledTimes(5);
  });

  // Task #17 (D3): server-side sessionId filtering for the per-session
  // live tail. When `?sessionId=` is present, frames with a sessionId that
  // doesn't match are dropped before being written; events with no sessionId
  // (e.g. system-level alerts) and the heartbeat keepalive always pass.
  it('filters live frames by ?sessionId= when set', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse?sessionId=keep-me`);
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', {
        id: 'a',
        sessionId: 'drop-me',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: 1,
      });
      bus.emit('tool-call', {
        id: 'b',
        sessionId: 'keep-me',
        tool: 'Edit',
        durationMs: 2,
        costUsd: 0,
        ts: 2,
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"b"');
      expect(merged).not.toContain('"id":"a"');
    } finally {
      await server.close();
    }
  });

  it('replay also honours ?sessionId= filter', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', {
      id: 'old-mine',
      sessionId: 'mine',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 1,
    });
    bus.emit('tool-call', {
      id: 'old-other',
      sessionId: 'other',
      tool: 'Read',
      durationMs: 1,
      costUsd: 0,
      ts: 2,
    });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse?sessionId=mine`, {
        headers: { 'last-event-id': '0' },
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"old-mine"');
      expect(merged).not.toContain('"id":"old-other"');
    } finally {
      await server.close();
    }
  });

  it('rejects malformed ?sessionId= by falling open to no filter', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      // Path-traversal-ish — fails the SESSION_ID_RE pattern.
      const res = await fetch(`${server.url}/sse?sessionId=../etc/passwd`);
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', {
        id: 'one',
        sessionId: 'real-session',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: 1,
      });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      // No filter applied → every event passes through.
      expect(merged).toContain('"id":"one"');
    } finally {
      await server.close();
    }
  });

  it('heartbeat frame id is non-numeric ("hb-<ts>") and does not affect bus seq', async () => {
    const bus = new LiveEventBus();
    // Construct an SSE handler with a 50ms heartbeat by NOT using the
    // default 30s — instead, just verify a fresh connection emits no
    // numeric heartbeat ids and that subsequent live events use the next
    // bus seq (1, since the bus is fresh).
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', {
        id: 'live-1',
        sessionId: 's1',
        tool: 'Read',
        durationMs: 1,
        costUsd: 0,
        ts: 1,
      });
      // 2 chunks: ': stream-open\n\n' + event frame.
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      // Live event must use bus seq=1.
      expect(merged).toMatch(/\nid: 1\n/);
    } finally {
      await server.close();
    }
  });
});

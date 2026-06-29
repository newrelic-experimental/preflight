import { IncomingMessage, ServerResponse } from 'node:http';

import { LiveEventBus, LiveEventMap, LiveEventName, SeqEntry } from '../live-event-bus.js';

const HEARTBEAT_MS = 30_000;
// Only validate the same character class the rest of the codebase uses for
// session_id (collector-script.ts, local-store.ts). A bad input is silently
// ignored — the filter falls open to "all events" rather than 400ing, since
// SSE clients can't easily react to a 4xx.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Narrow a payload to its sessionId field if present. ToolCall, AntiPattern,
// CostUpdate, and ContextUpdate all expose `sessionId: string`; AlertEvent has
// it as `sessionId?: string`. HeartbeatEvent has none (and is unfiltered).
function extractSessionId(payload: LiveEventMap[LiveEventName]): string | undefined {
  if (payload && typeof payload === 'object' && 'sessionId' in payload) {
    const sid = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  return undefined;
}

// Frame id is `string | number` so heartbeats can use a non-numeric id like
// "hb-<ts>". The browser sends it back as Last-Event-ID on reconnect; the
// server's parseInt will return NaN for "hb-..." which falls through to "no
// replay" — safer than letting a heartbeat id contaminate the bus seq
// namespace.
function frame(event: string, id: string | number, data: unknown): string {
  const safeEvent = event.replace(/[\r\n]/g, '');
  return `event: ${safeEvent}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHandler(
  bus: LiveEventBus,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': stream-open\n\n');

    // Optional `?sessionId=` query parameter scopes the stream to events
    // emitted from a single Claude Code session. Events without a `sessionId`
    // field (heartbeat) and AlertEvents whose sessionId is unset are always
    // delivered — heartbeat is a connection keepalive and unscoped alerts are
    // system-level. An invalid sessionId is treated as "no filter" so a typo
    // in the query string degrades to the existing global stream behavior
    // rather than a permanently silent connection.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rawSessionId = url.searchParams.get('sessionId');
    const filterSessionId =
      rawSessionId !== null && SESSION_ID_RE.test(rawSessionId) ? rawSessionId : null;

    // Parse Last-Event-ID. Heartbeats use string ids like "hb-<ts>" which
    // produce NaN here, falling through to no replay. Negative or invalid
    // values also fall through.
    const lastEventIdHeader = req.headers['last-event-id'];
    const rawSeq = typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : NaN;
    const replaySeq = Number.isFinite(rawSeq) && rawSeq >= 0 ? rawSeq : -1;
    if (replaySeq >= 0) {
      // Replay buffered events with global seq > lastSeq, using the bus's
      // own seq for the frame id. This keeps replay and live frames in the
      // same numbering namespace — where a per-connection
      // counter caused reconnect to either miss events or replay
      // pre-connection history.
      for (const entry of bus.replayFrom(replaySeq)) {
        const sid = extractSessionId(entry.payload);
        if (filterSessionId !== null && sid !== undefined && sid !== filterSessionId) {
          continue;
        }
        res.write(frame(entry.event, entry.seq, entry.payload));
      }
    }

    // Swallow EPIPE / ERR_HTTP_HEADERS_SENT from writes to a closed response.
    // The cleanup handlers remove these listeners, but there is a brief race
    // window between client disconnect and cleanup — the error handler prevents
    // that from reaching Node's unhandled-rejection handler.
    res.on('error', () => cleanup());

    // Live frames carry the bus's global seq (delivered via onWithSeq).
    // Skip frames whose sessionId doesn't match the optional filter — events
    // without a sessionId pass through (heartbeat, system-level alerts).
    const onAny =
      <E extends LiveEventName>(event: E) =>
      (entry: SeqEntry<E>): void => {
        if (res.destroyed) return;
        if (filterSessionId !== null) {
          const sid = extractSessionId(entry.payload);
          if (sid !== undefined && sid !== filterSessionId) return;
        }
        res.write(frame(event, entry.seq, entry.payload));
      };

    const handlers = {
      'tool-call': onAny('tool-call'),
      'cost-update': onAny('cost-update'),
      'anti-pattern': onAny('anti-pattern'),
      'context-update': onAny('context-update'),
      alert: onAny('alert'),
    } as const;
    bus.onWithSeq('tool-call', handlers['tool-call']);
    bus.onWithSeq('cost-update', handlers['cost-update']);
    bus.onWithSeq('anti-pattern', handlers['anti-pattern']);
    bus.onWithSeq('context-update', handlers['context-update']);
    bus.onWithSeq('alert', handlers['alert']);

    // Heartbeats use a string id ("hb-<ts>") so they don't share the bus
    // seq namespace. They aren't stored in the bus buffer, so a client that
    // last received a heartbeat will reconnect with Last-Event-ID: "hb-..."
    // → parseInt → NaN → no replay. Live events resume from whichever real
    // seq the client most recently saw before the heartbeat.
    const heartbeat = setInterval(() => {
      res.write(frame('heartbeat', `hb-${Date.now()}`, { ts: Date.now() }));
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      bus.offWithSeq('tool-call', handlers['tool-call']);
      bus.offWithSeq('cost-update', handlers['cost-update']);
      bus.offWithSeq('anti-pattern', handlers['anti-pattern']);
      bus.offWithSeq('context-update', handlers['context-update']);
      bus.offWithSeq('alert', handlers['alert']);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };
}

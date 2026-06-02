import { IncomingMessage, ServerResponse } from 'node:http';

import { LiveEventBus, LiveEventName, LiveEventMap } from '../live-event-bus.js';

const HEARTBEAT_MS = 30_000;

function frame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
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

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastSeq =
      typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : NaN;
    const replaySeq = Number.isFinite(lastSeq) ? lastSeq : -1;
    if (replaySeq >= 0) {
      for (const entry of bus.replayFrom(replaySeq)) {
        res.write(frame(entry.event, entry.seq, entry.payload));
      }
    }

    let nextLocalSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
    const onAny =
      <E extends LiveEventName>(event: E) =>
      (payload: LiveEventMap[E]): void => {
        const seq = nextLocalSeq++;
        res.write(frame(event, seq, payload));
      };

    const handlers = {
      'tool-call': onAny('tool-call'),
      'cost-update': onAny('cost-update'),
      'anti-pattern': onAny('anti-pattern'),
      'alert': onAny('alert'),
    } as const;
    bus.on('tool-call', handlers['tool-call']);
    bus.on('cost-update', handlers['cost-update']);
    bus.on('anti-pattern', handlers['anti-pattern']);
    bus.on('alert', handlers['alert']);

    const heartbeat = setInterval(() => {
      const seq = nextLocalSeq++;
      res.write(frame('heartbeat', seq, { ts: Date.now() }));
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      bus.off('tool-call', handlers['tool-call']);
      bus.off('cost-update', handlers['cost-update']);
      bus.off('anti-pattern', handlers['anti-pattern']);
      bus.off('alert', handlers['alert']);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };
}

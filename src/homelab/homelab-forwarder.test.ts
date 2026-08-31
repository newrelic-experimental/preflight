import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { HomelabForwarder } from './homelab-forwarder.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stderrSpy.mockRestore();
  jest.useRealTimers();
});

function makeRecord(tool = 'Read'): ToolCallRecord {
  return {
    id: `id-${Date.now()}`,
    sessionId: 'session-1',
    toolName: tool,
    toolUseId: `use-${Date.now()}`,
    timestamp: Date.now(),
    durationMs: 10,
    success: true,
  };
}

function startMockServer(
  handler: (body: unknown, authHeader: string | undefined) => number,
): Promise<{
  server: Server;
  url: string;
  requests: Array<{ body: unknown; auth: string | undefined }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ body: unknown; auth: string | undefined }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const auth = req.headers['authorization'];
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        requests.push({ body, auth });
        const status = handler(body, auth);
        res.writeHead(status);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

describe('HomelabForwarder SSRF protection', () => {
  it('allows a private LAN address at construction (the intended use case)', () => {
    expect(
      () =>
        new HomelabForwarder({
          serverUrl: 'http://192.168.1.100:7777',
          token: 't',
          developer: 'd',
          sessionId: 's',
        }),
    ).not.toThrow();
  });

  it('rejects a cloud metadata IP as the configured serverUrl', () => {
    expect(
      () =>
        new HomelabForwarder({
          serverUrl: 'http://169.254.169.254:7777',
          token: 't',
          developer: 'd',
          sessionId: 's',
        }),
    ).toThrow(/cloud metadata service endpoint/);
  });

  it('rejects a disallowed scheme', () => {
    expect(
      () =>
        new HomelabForwarder({
          serverUrl: 'ftp://192.168.1.100:7777',
          token: 't',
          developer: 'd',
          sessionId: 's',
        }),
    ).toThrow(/scheme "ftp:" is not allowed/);
  });
});

describe('HomelabForwarder', () => {
  it('posts events with correct auth header on flush', async () => {
    const { server, url, requests } = await startMockServer(() => 204);
    const forwarder = new HomelabForwarder({
      serverUrl: url,
      token: 'test-token',
      developer: 'alice',
      sessionId: 'session-1',
    });

    forwarder.enqueue(makeRecord('Read'));
    forwarder.enqueue(makeRecord('Edit'));
    await forwarder.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].auth).toBe('Bearer test-token');
    const payload = requests[0].body as {
      developer: string;
      sessionId: string;
      records: ToolCallRecord[];
    };
    expect(payload.developer).toBe('alice');
    expect(payload.sessionId).toBe('session-1');
    expect(payload.records).toHaveLength(2);

    await new Promise<void>((res) => server.close(() => res()));
  });

  it('drops oldest event when buffer overflows at 1000', () => {
    const forwarder = new HomelabForwarder({
      serverUrl: 'http://nowhere',
      token: 't',
      developer: 'd',
      sessionId: 's',
    });
    for (let i = 0; i < 1001; i++) {
      forwarder.enqueue({
        id: `id-${i}`,
        sessionId: 's',
        toolName: `tool-${i}`,
        toolUseId: `u-${i}`,
        timestamp: i,
        durationMs: 1,
        success: true,
      });
    }
    // Access internal buffer for test verification
    const buf = (forwarder as unknown as { buffer: ToolCallRecord[] }).buffer;
    expect(buf).toHaveLength(1000);
    expect(buf[0].toolName).toBe('tool-1'); // tool-0 was dropped
    expect(buf[999].toolName).toBe('tool-1000');
  });

  it('does not post when buffer is empty', async () => {
    const { server, url, requests } = await startMockServer(() => 204);
    const forwarder = new HomelabForwarder({
      serverUrl: url,
      token: 't',
      developer: 'd',
      sessionId: 's',
    });
    await forwarder.stop();
    expect(requests).toHaveLength(0);
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('logs a warning and continues on HTTP error', async () => {
    const { server, url } = await startMockServer(() => 500);
    const forwarder = new HomelabForwarder({
      serverUrl: url,
      token: 't',
      developer: 'd',
      sessionId: 's',
    });
    forwarder.enqueue(makeRecord());
    // flush() should not throw
    await expect(forwarder.flush()).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalled();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('does not enqueue after stop()', async () => {
    const { server, url, requests } = await startMockServer(() => 204);
    const forwarder = new HomelabForwarder({
      serverUrl: url,
      token: 't',
      developer: 'd',
      sessionId: 's',
    });
    forwarder.enqueue(makeRecord());
    await forwarder.stop();
    forwarder.enqueue(makeRecord()); // should be ignored
    expect(requests[0].body).toMatchObject({ records: expect.arrayContaining([]) });
    const flushedCount = (requests[0].body as { records: unknown[] }).records.length;
    expect(flushedCount).toBe(1);
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('flushes on start() interval', async () => {
    const { server, url, requests } = await startMockServer(() => 204);

    let capturedCallback: (() => void) | null = null;
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((cb) => {
      capturedCallback = cb as () => void;
      return 0 as unknown as ReturnType<typeof setInterval>;
    });

    const forwarder = new HomelabForwarder({
      serverUrl: url,
      token: 't',
      developer: 'd',
      sessionId: 's',
    });

    forwarder.enqueue(makeRecord('Read'));
    forwarder.start();

    expect(capturedCallback).not.toBeNull();
    // Manually fire the interval callback — simulates the 5s tick
    capturedCallback!();
    // Yield to microtask queue for the fetch promise to settle
    await new Promise((res) => setTimeout(res, 100));

    // Verify one request was made
    expect(requests).toHaveLength(1);
    expect((requests[0].body as { records: ToolCallRecord[] }).records).toHaveLength(1);
    expect((requests[0].body as { records: ToolCallRecord[] }).records[0].toolName).toBe('Read');

    setIntervalSpy.mockRestore();
    await forwarder.stop();
    await new Promise<void>((res) => server.close(() => res()));
  });
});

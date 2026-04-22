import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StdioUpstream } from './upstream-stdio.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeFakeRequest(method = 'POST'): IncomingMessage {
  return { method, headers: {}, url: '/proxy/test' } as unknown as IncomingMessage;
}

function makeFakeResponse(): {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => string;
  getHeaders: () => Record<string, string | string[]>;
} {
  let status = 0;
  let _headersSent = false;
  let _writableEnded = false;
  const chunks: Buffer[] = [];
  const headers: Record<string, string | string[]> = {};

  const res = {
    get headersSent() { return _headersSent; },
    get writableEnded() { return _writableEnded; },
    setHeader(key: string, value: string | string[]) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      _headersSent = true;
      if (h) Object.assign(headers, h);
      return res;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      _writableEnded = true;
      return res;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => status,
    getBody: () => Buffer.concat(chunks).toString(),
    getHeaders: () => headers,
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('StdioUpstream', () => {
  it('throws if config has no command', () => {
    expect(
      () => new StdioUpstream({ name: 'test', transportType: 'stdio' }),
    ).toThrow('requires a command');
  });

  it('stores name and transportType', () => {
    const upstream = new StdioUpstream({
      name: 'my-server',
      command: 'node',
      args: ['server.js'],
      transportType: 'stdio',
    });
    expect(upstream.name).toBe('my-server');
    expect(upstream.transportType).toBe('stdio');
  });
});

// ---------------------------------------------------------------------------
// forward() without connect()
// ---------------------------------------------------------------------------

describe('StdioUpstream.forward() without connect', () => {
  it('returns error when not connected', async () => {
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    const { res, getStatus, getBody } = makeFakeResponse();

    const result = await upstream.forward(
      makeFakeRequest(),
      res,
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    );

    expect(result.statusCode).toBe(500);
    expect(getStatus()).toBe(500);
    const body = JSON.parse(getBody());
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toBe('Upstream not connected');
  });

  it('returns parse error for invalid JSON', async () => {
    // Create a connected-like upstream by testing the parse path
    // We can test parse error without connect since the parse check comes first
    // after the connect check — so we need to mock the client field
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    // Bypass connect check by setting a fake client
    (upstream as unknown as Record<string, unknown>).client = {};

    const { res, getStatus, getBody } = makeFakeResponse();

    const result = await upstream.forward(
      makeFakeRequest(),
      res,
      Buffer.from('not json'),
    );

    expect(result.statusCode).toBe(400);
    expect(getStatus()).toBe(400);
    const body = JSON.parse(getBody());
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toContain('Parse error');
  });

  it('returns parse error for JSON without method field', async () => {
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    (upstream as unknown as Record<string, unknown>).client = {};

    const { res, getBody } = makeFakeResponse();

    const result = await upstream.forward(
      makeFakeRequest(),
      res,
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1 })),
    );

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(getBody());
    expect(body.error.code).toBe(-32700);
  });
});

// ---------------------------------------------------------------------------
// forward() with a mock client
// ---------------------------------------------------------------------------

describe('StdioUpstream.forward() with mock client', () => {
  function makeUpstreamWithMockClient(mockClient: Record<string, unknown>): StdioUpstream {
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    (upstream as unknown as Record<string, unknown>).client = mockClient;
    return upstream;
  }

  it('dispatches tools/list and returns result', async () => {
    const mockTools = { tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }] };
    const upstream = makeUpstreamWithMockClient({
      listTools: jest.fn<() => Promise<typeof mockTools>>().mockResolvedValue(mockTools),
    });

    const { res, getStatus, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

    const result = await upstream.forward(makeFakeRequest(), res, body);

    expect(result.statusCode).toBe(200);
    expect(getStatus()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result.tools).toHaveLength(1);
    expect(parsed.result.tools[0].name).toBe('test_tool');
  });

  it('dispatches tools/call and returns result', async () => {
    const mockResult = { content: [{ type: 'text', text: 'hello' }] };
    const upstream = makeUpstreamWithMockClient({
      callTool: jest.fn<() => Promise<typeof mockResult>>().mockResolvedValue(mockResult),
    });

    const { res, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'test_tool', arguments: { query: 'test' } },
    }));

    const result = await upstream.forward(makeFakeRequest(), res, body);

    expect(result.statusCode).toBe(200);
    expect(result.upstreamLatencyMs).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(getBody());
    expect(parsed.result.content[0].text).toBe('hello');
  });

  it('dispatches resources/list and returns result', async () => {
    const mockResources = { resources: [{ name: 'test', uri: 'test://resource' }] };
    const upstream = makeUpstreamWithMockClient({
      listResources: jest.fn<() => Promise<typeof mockResources>>().mockResolvedValue(mockResources),
    });

    const { res, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }));

    await upstream.forward(makeFakeRequest(), res, body);
    const parsed = JSON.parse(getBody());
    expect(parsed.result.resources).toHaveLength(1);
  });

  it('dispatches resources/read and returns result', async () => {
    const mockContent = { contents: [{ uri: 'test://resource', text: 'content here' }] };
    const upstream = makeUpstreamWithMockClient({
      readResource: jest.fn<() => Promise<typeof mockContent>>().mockResolvedValue(mockContent),
    });

    const { res, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'test://resource' },
    }));

    await upstream.forward(makeFakeRequest(), res, body);
    const parsed = JSON.parse(getBody());
    expect(parsed.result.contents[0].text).toBe('content here');
  });

  it('returns JSON-RPC error when client method throws', async () => {
    const upstream = makeUpstreamWithMockClient({
      listTools: jest.fn<() => Promise<never>>().mockRejectedValue(new Error('Process crashed')),
    });

    const { res, getStatus, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }));

    const result = await upstream.forward(makeFakeRequest(), res, body);

    expect(result.statusCode).toBe(500);
    expect(getStatus()).toBe(500);
    const parsed = JSON.parse(getBody());
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe('Process crashed');
    expect(result.upstreamLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles unknown methods via generic request', async () => {
    const mockResult = { status: 'ok' };
    const upstream = makeUpstreamWithMockClient({
      request: jest.fn<() => Promise<typeof mockResult>>().mockResolvedValue(mockResult),
    });

    const { res, getBody } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'custom/method',
      params: { foo: 'bar' },
    }));

    const result = await upstream.forward(makeFakeRequest(), res, body);
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.result.status).toBe('ok');
  });

  it('records response size in bytes', async () => {
    const upstream = makeUpstreamWithMockClient({
      listTools: jest.fn<() => Promise<{ tools: never[] }>>().mockResolvedValue({ tools: [] }),
    });

    const { res } = makeFakeResponse();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

    const result = await upstream.forward(makeFakeRequest(), res, body);
    expect(result.responseSizeBytes).toBeGreaterThan(0);
    expect(typeof result.responseSizeBytes).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// disconnect()
// ---------------------------------------------------------------------------

describe('StdioUpstream.disconnect()', () => {
  it('calls client.close() when connected', async () => {
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    (upstream as unknown as Record<string, unknown>).client = { close: mockClose };

    await upstream.disconnect();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when not connected', async () => {
    const upstream = new StdioUpstream({
      name: 'test',
      command: 'node',
      transportType: 'stdio',
    });
    await expect(upstream.disconnect()).resolves.toBeUndefined();
  });

  it('force-kills the process and resolves if client.close() hangs past timeout', async () => {
    jest.useFakeTimers();

    const upstream = new StdioUpstream({ name: 'hanging', command: 'node', transportType: 'stdio' });

    // client.close() never resolves — simulates a hung upstream
    const mockClose = jest.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
    const mockKill = jest.fn<(signal?: string) => void>();
    (upstream as unknown as Record<string, unknown>).client = { close: mockClose };
    (upstream as unknown as Record<string, unknown>).transport = { _process: { kill: mockKill } };

    const disconnectPromise = upstream.disconnect();

    // Advance past the 5-second disconnect timeout
    await jest.runAllTimersAsync();
    await disconnectPromise;

    expect(mockKill).toHaveBeenCalledWith('SIGKILL');

    jest.useRealTimers();
  });

  it('clears the timeout handle when client.close() resolves promptly', async () => {
    jest.useFakeTimers();

    const upstream = new StdioUpstream({ name: 'fast', command: 'node', transportType: 'stdio' });
    const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const mockKill = jest.fn<(signal?: string) => void>();
    (upstream as unknown as Record<string, unknown>).client = { close: mockClose };
    (upstream as unknown as Record<string, unknown>).transport = { _process: { kill: mockKill } };

    await upstream.disconnect();

    // Advancing past the timeout should NOT trigger kill (it was cleared)
    await jest.runAllTimersAsync();
    expect(mockKill).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});

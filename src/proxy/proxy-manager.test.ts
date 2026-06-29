import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createServer as createHttpServer,
  request as nodeRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { ProxyManager } from './proxy-manager.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

/** Create a mock MCP HTTP server that responds to JSON-RPC requests. */
function createMockMcpServer(
  handler?: (
    rpc: { method: string; id?: number; params?: unknown },
    req: IncomingMessage,
    res: ServerResponse,
  ) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let rpc: { method: string; id?: number; params?: unknown } = { method: '' };
        try {
          rpc = JSON.parse(body);
        } catch {
          // not JSON — still pass to handler
        }

        if (handler) {
          handler(rpc, req, res);
        } else {
          // Default: echo back a success response
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            result: { tools: [] },
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(response);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Simple HTTP request helper. */
function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = nodeRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ProxyManager basics
// ---------------------------------------------------------------------------

describe('ProxyManager', () => {
  let manager: ProxyManager;

  afterEach(async () => {
    if (manager) await manager.stop();
  });

  it('registers an upstream and exposes it via getUpstreamNames()', () => {
    manager = new ProxyManager({ port: 0 });
    manager.registerUpstream({
      name: 'test-server',
      url: 'http://localhost:1234',
      transportType: 'http',
      allowPrivateHosts: true,
    });
    expect(manager.getUpstreamNames()).toEqual(['test-server']);
  });

  it('registers multiple upstreams', () => {
    manager = new ProxyManager({ port: 0 });
    manager.registerUpstream({
      name: 'server-a',
      url: 'http://localhost:1',
      transportType: 'http',
      allowPrivateHosts: true,
    });
    manager.registerUpstream({
      name: 'server-b',
      url: 'http://localhost:2',
      transportType: 'http',
      allowPrivateHosts: true,
    });
    expect(manager.getUpstreamNames()).toEqual(['server-a', 'server-b']);
  });

  it('getUpstream() returns the registered upstream', () => {
    manager = new ProxyManager({ port: 0 });
    manager.registerUpstream({
      name: 'test',
      url: 'http://localhost:1',
      transportType: 'http',
      allowPrivateHosts: true,
    });
    const upstream = manager.getUpstream('test');
    expect(upstream).toBeDefined();
    expect(upstream!.name).toBe('test');
  });

  it('getUpstream() returns undefined for unknown names', () => {
    manager = new ProxyManager({ port: 0 });
    expect(manager.getUpstream('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP server routing
// ---------------------------------------------------------------------------

describe('ProxyManager HTTP server', () => {
  let manager: ProxyManager;
  let mockServer: Server;
  let proxyPort: number;

  afterEach(async () => {
    if (manager) await manager.stop();
    if (mockServer) await closeServer(mockServer);
  });

  async function setupProxy(
    mockPort: number,
    options?: Partial<{
      onToolCall: (r: ProxyToolCallRecord) => void;
      onRequest: (r: ProxyRequestRecord) => void;
    }>,
  ) {
    // Use port 0 to get a random available port
    manager = new ProxyManager({
      port: 0,
      ...options,
    });
    manager.registerUpstream({
      name: 'test-mcp',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    // Get the actual port the server is listening on
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  }

  it('responds to GET /health with upstream list', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    const mockPort = proxyPort;

    manager = new ProxyManager({ port: 0 });
    manager.registerUpstream({
      name: 'server-a',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    manager.registerUpstream({
      name: 'server-b',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/health`, { method: 'GET' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.upstreams).toEqual(['server-a', 'server-b']);
  });

  it('returns 404 for unknown upstream', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/unknown-server`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('upstream_not_found');
    // server name must not be disclosed to the client
    expect(body.message).toBeUndefined();
    expect(response.body).not.toContain('unknown-server');
  });

  it('returns 404 for unrecognized routes', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/something-else`, {
      body: '{}',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    // request URL must not be echoed back to the client
    expect(body.message).toBeUndefined();
    expect(response.body).not.toContain('something-else');
  });

  it('returns 400 for malformed percent-encoding in server name', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/%ZZbad`, {
      body: '{}',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('bad_request');
  });

  it('forwards tools/list to upstream and returns response unchanged', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] },
        }),
      );
    }));
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.result.tools[0].name).toBe('read_file');
  });

  it('forwards tools/call to upstream and returns response unchanged', async () => {
    const toolResult = { content: [{ type: 'text', text: 'file contents here' }] };

    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: toolResult }));
    }));
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.result.content[0].text).toBe('file contents here');
  });

  it('propagates upstream error (500) with same status and body', async () => {
    const errorBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });

    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(errorBody);
    }));
    await setupProxy(proxyPort);

    const response = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'bad_tool' },
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(errorBody);
  });

  it('forwards auth headers to upstream', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    }));
    await setupProxy(proxyPort);

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token-123',
        'mcp-session-id': 'session-abc',
        'x-custom-header': 'custom-value',
      },
    });

    expect(receivedHeaders['authorization']).toBe('Bearer test-token-123');
    expect(receivedHeaders['mcp-session-id']).toBe('session-abc');
    expect(receivedHeaders['x-custom-header']).toBe('custom-value');
  });
});

// ---------------------------------------------------------------------------
// Observability records
// ---------------------------------------------------------------------------

describe('ProxyManager observability', () => {
  let manager: ProxyManager;
  let mockServer: Server;
  let proxyPort: number;

  afterEach(async () => {
    if (manager) await manager.stop();
    if (mockServer) await closeServer(mockServer);
  });

  async function setupWithCallbacks(
    mockPort: number,
    callbacks: {
      onToolCall?: (r: ProxyToolCallRecord) => void;
      onRequest?: (r: ProxyRequestRecord) => void;
    },
  ) {
    manager = new ProxyManager({ port: 0, ...callbacks });
    manager.registerUpstream({
      name: 'test-mcp',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  }

  it('emits ProxyToolCallRecord for tools/call', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}');
    }));
    const mockPort = proxyPort;

    const records: ProxyToolCallRecord[] = [];
    await setupWithCallbacks(mockPort, { onToolCall: (r) => records.push(r) });

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/test' } },
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.serverName).toBe('test-mcp');
    expect(rec.toolName).toBe('read_file');
    expect(rec.toolUseId).toBe('1');
    expect(rec.success).toBe(true);
    expect(rec.durationMs).toBeGreaterThan(0);
    expect(rec.upstreamLatencyMs).toBeGreaterThan(0);
    expect(rec.proxyOverheadMs).toBeDefined();
    expect(typeof rec.proxyOverheadMs).toBe('number');
    expect(rec.inputSizeBytes).toBeGreaterThan(0);
    expect(rec.outputSizeBytes).toBeGreaterThan(0);
    expect(rec.id).toBeTruthy();
    expect(rec.timestamp).toBeGreaterThan(0);
  });

  it('emits ProxyRequestRecord for tools/list', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    }));
    const mockPort = proxyPort;

    const records: ProxyRequestRecord[] = [];
    await setupWithCallbacks(mockPort, { onRequest: (r) => records.push(r) });

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.serverName).toBe('test-mcp');
    expect(rec.method).toBe('tools/list');
    expect(rec.success).toBe(true);
    expect(rec.durationMs).toBeGreaterThan(0);
    expect(rec.upstreamLatencyMs).toBeGreaterThan(0);
  });

  it('does not emit records for non-tracked methods', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    }));
    const mockPort = proxyPort;

    const toolRecords: ProxyToolCallRecord[] = [];
    const reqRecords: ProxyRequestRecord[] = [];
    await setupWithCallbacks(mockPort, {
      onToolCall: (r) => toolRecords.push(r),
      onRequest: (r) => reqRecords.push(r),
    });

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(toolRecords).toHaveLength(0);
    expect(reqRecords).toHaveLength(0);
  });

  it('records success=false for upstream error responses', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"fail"}}');
    }));
    const mockPort = proxyPort;

    const records: ProxyToolCallRecord[] = [];
    await setupWithCallbacks(mockPort, { onToolCall: (r) => records.push(r) });

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'bad' },
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('computes proxyOverheadMs as totalDuration - upstreamLatency', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      // Small delay to ensure measurable upstream latency
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      }, 5);
    }));
    const mockPort = proxyPort;

    const records: ProxyRequestRecord[] = [];
    await setupWithCallbacks(mockPort, { onRequest: (r) => records.push(r) });

    await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(records).toHaveLength(1);
    const rec = records[0];
    // proxyOverheadMs = durationMs - upstreamLatencyMs
    const expected = rec.durationMs - rec.upstreamLatencyMs;
    expect(rec.proxyOverheadMs).toBeCloseTo(expected, 1);
  });
});

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe('ProxyManager performance', () => {
  let manager: ProxyManager;
  let mockServer: Server;
  let proxyPort: number;

  afterEach(async () => {
    if (manager) await manager.stop();
    if (mockServer) await closeServer(mockServer);
  });

  it('proxy overhead is <10ms p95 over 100 requests', async () => {
    // Mock server that responds instantly
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer((_rpc, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    }));
    const mockPort = proxyPort;

    const overheads: number[] = [];
    manager = new ProxyManager({
      port: 0,
      onToolCall: (r) => {
        if (r.proxyOverheadMs != null) overheads.push(r.proxyOverheadMs);
      },
    });
    manager.registerUpstream({
      name: 'bench',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fast_tool' },
    });

    // Warm up
    for (let i = 0; i < 5; i++) {
      await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/bench`, {
        body,
        headers: { 'content-type': 'application/json' },
      });
    }
    overheads.length = 0;

    // Measure
    for (let i = 0; i < 100; i++) {
      await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/bench`, {
        body,
        headers: { 'content-type': 'application/json' },
      });
    }

    overheads.sort((a, b) => a - b);
    const p95 = overheads[Math.floor(overheads.length * 0.95)];
    // Proxy overhead (JSON peek + record creation) should be well under 10ms
    expect(p95).toBeLessThan(10);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('ProxyManager unhandled request error handler', () => {
  it('sends 500 JSON when handleRequest rejects before headers are sent', async () => {
    const manager = new ProxyManager({ port: 0 });
    (manager as unknown as { handleRequest: () => Promise<void> }).handleRequest = async () => {
      throw new Error('test error before headers');
    };
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await httpRequest(`http://127.0.0.1:${port}/any`, { method: 'POST', body: '{}' });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    } finally {
      await manager.stop();
    }
  });

  it('destroys socket (not writing JSON) when handleRequest rejects after headers are sent', async () => {
    const manager = new ProxyManager({ port: 0 });
    (
      manager as unknown as {
        handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      }
    ).handleRequest = async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      throw new Error('error mid-stream');
    };
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const result = await new Promise<{
        statusCode: number;
        body: string;
        connectionReset: boolean;
      }>((resolve) => {
        const req = nodeRequest(
          { hostname: '127.0.0.1', port, method: 'POST', path: '/any' },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
                connectionReset: false,
              }),
            );
            res.on('close', () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
                connectionReset: true,
              }),
            );
          },
        );
        req.on('error', () => resolve({ statusCode: 0, body: '', connectionReset: true }));
        req.end();
      });

      // Socket was destroyed — connection reset, no JSON error body written
      expect(result.connectionReset).toBe(true);
      expect(result.body).not.toContain('internal_error');
    } finally {
      await manager.stop();
    }
  });
});

describe('ProxyManager error handling', () => {
  it('rejects with EADDRINUSE when port is already taken', async () => {
    // Occupy a port
    const blocker = createHttpServer();
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const manager = new ProxyManager({ port: blockerPort });
      await expect(manager.start()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('ProxyManager upstream connection failures', () => {
  it('throws when all upstreams fail to connect', async () => {
    const manager = new ProxyManager({ port: 0 });
    manager.registerUpstream({
      name: 'bad-server',
      url: 'http://127.0.0.1:1',
      transportType: 'stdio',
      command: '/nonexistent/binary',
    });
    // Override the upstream's connect to throw
    const upstream = manager.getUpstream('bad-server')!;
    upstream.connect = async () => {
      throw new Error('spawn failed');
    };

    await expect(manager.start()).rejects.toThrow('All upstreams failed to connect');
  });

  it('starts in degraded mode when some upstreams fail', async () => {
    const { server: mockServer, port: mockPort } = await createMockMcpServer();

    try {
      const manager = new ProxyManager({ port: 0 });
      manager.registerUpstream({
        name: 'good-server',
        url: `http://127.0.0.1:${mockPort}`,
        transportType: 'http',
        allowPrivateHosts: true,
      });
      manager.registerUpstream({
        name: 'bad-server',
        url: 'http://127.0.0.1:1',
        transportType: 'stdio',
        command: '/nonexistent/binary',
      });
      const badUpstream = manager.getUpstream('bad-server')!;
      badUpstream.connect = async () => {
        throw new Error('spawn failed');
      };

      // Should not throw — one upstream succeeded
      await manager.start();

      const logOutput = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
      expect(logOutput).toContain('degraded');

      await manager.stop();
    } finally {
      await closeServer(mockServer);
    }
  });
});

describe('ProxyManager lifecycle', () => {
  it('start and stop without upstreams', async () => {
    const manager = new ProxyManager({ port: 0 });
    await manager.start();
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('stop is idempotent', async () => {
    const manager = new ProxyManager({ port: 0 });
    await manager.start();
    await manager.stop();
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Body limits
// ---------------------------------------------------------------------------

describe('ProxyManager body limits', () => {
  let manager: ProxyManager;
  let mockServer: Server;
  let proxyPort: number;

  afterEach(async () => {
    if (manager) await manager.stop();
    if (mockServer) await closeServer(mockServer);
  });

  it('returns 413 when request body exceeds maxBodyBytes', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    const mockPort = proxyPort;

    manager = new ProxyManager({ port: 0, maxBodyBytes: 20 });
    manager.registerUpstream({
      name: 'test-mcp',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;

    // Body is well over 20 bytes
    const largeBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const res = await httpRequest(`http://127.0.0.1:${proxyPort}/proxy/test-mcp`, {
      body: largeBody,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('payload_too_large');
  });

  it('returns 408 when request body read times out (slow-loris)', async () => {
    ({ server: mockServer, port: proxyPort } = await createMockMcpServer());
    const mockPort = proxyPort;

    manager = new ProxyManager({ port: 0, bodyTimeoutMs: 150 });
    manager.registerUpstream({
      name: 'test-mcp',
      url: `http://127.0.0.1:${mockPort}`,
      transportType: 'http',
      allowPrivateHosts: true,
    });
    await manager.start();
    const addr = (
      manager as unknown as { httpServer: { address: () => { port: number } } }
    ).httpServer?.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;

    // Send headers only (chunked encoding) and never complete the body
    const reqHolder: { req: ClientRequest | null } = { req: null };
    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/proxy/test-mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      reqHolder.req = req;
      req.on('error', reject);
      // Send headers but never write body or call req.end()
      req.flushHeaders();
    });

    // Destroy the hanging connection so server.close() can complete in afterEach
    reqHolder.req?.destroy();

    expect(res.statusCode).toBe(408);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('request_timeout');
  }, 5_000);
});

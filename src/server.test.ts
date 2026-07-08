import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, NrMcpServer } from './server.js';
import { AuditTrailManager } from './security/audit-trail.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('NrMcpServer', () => {
  it('instantiates without error', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(NrMcpServer);
  });

  it('uses default name and version', () => {
    const server = createServer();
    expect(server.server).toBeDefined();
  });

  it('accepts custom name and version', () => {
    const server = createServer({ name: 'test-server', version: '9.9.9' });
    expect(server.server).toBeDefined();
  });

  it('close() completes without error on a non-connected server', async () => {
    const server = createServer();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('MCP protocol via InMemoryTransport', () => {
  let server: NrMcpServer;
  let client: Client;

  beforeEach(async () => {
    server = createServer({ name: 'test-mcp', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('responds to tools/list with health and install_hooks tools when no trackers configured', async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain('nr_observe_health');
    expect(toolNames).toContain('nr_observe_install_hooks');
  });

  it('responds to resources/list with an empty resource list', async () => {
    const result = await client.listResources();
    expect(result.resources).toEqual([]);
  });

  it('reports server info with correct name', async () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('test-mcp');
    expect(info?.version).toBe('0.0.1');
  });

  it('resources/list returns empty when auditTrailManager is not set', async () => {
    const result = await client.listResources();
    expect(result.resources).toHaveLength(0);
  });

  it('resources/list includes audit-log resource after auditTrailManager is assigned post-construction', async () => {
    // Simulate the stdio startup sequence: server created first, auditTrailManager wired later
    server.auditTrailManager = new AuditTrailManager({ developer: 'test', sessionId: null });

    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('nr-observe://session/audit-log');
  });

  it('resources/read returns audit log entries after auditTrailManager is assigned', async () => {
    server.auditTrailManager = new AuditTrailManager({ developer: 'test', sessionId: null });

    const result = await client.readResource({ uri: 'nr-observe://session/audit-log' });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    const text = 'text' in content ? content.text : '';
    const parsed = JSON.parse(text) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });
});

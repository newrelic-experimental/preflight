import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseArgs } from './index.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('parseArgs()', () => {
  // Commander expects argv[0]=node binary, argv[1]=script name
  const base = ['node', 'nr-ai-mcp-server'];

  it('defaults port to 9847', () => {
    const opts = parseArgs([...base]);
    expect(opts.port).toBe(9847);
  });

  it('parses --port flag', () => {
    const opts = parseArgs([...base, '--port', '3000']);
    expect(opts.port).toBe(3000);
  });

  it('parses -p shorthand for port', () => {
    const opts = parseArgs([...base, '-p', '4000']);
    expect(opts.port).toBe(4000);
  });

  it('defaults stdio to false', () => {
    const opts = parseArgs([...base]);
    expect(opts.stdio).toBe(false);
  });

  it('parses --stdio flag', () => {
    const opts = parseArgs([...base, '--stdio']);
    expect(opts.stdio).toBe(true);
  });

  it('defaults config to null', () => {
    const opts = parseArgs([...base]);
    expect(opts.config).toBeNull();
  });

  it('parses --config path', () => {
    const opts = parseArgs([...base, '--config', '/path/to/config.json']);
    expect(opts.config).toBe('/path/to/config.json');
  });

  it('parses -c shorthand for config', () => {
    const opts = parseArgs([...base, '-c', '/etc/nr.json']);
    expect(opts.config).toBe('/etc/nr.json');
  });

  it('defaults log-level to info', () => {
    const opts = parseArgs([...base]);
    expect(opts.logLevel).toBe('info');
  });

  it('parses --log-level flag', () => {
    const opts = parseArgs([...base, '--log-level', 'debug']);
    expect(opts.logLevel).toBe('debug');
  });

  it('parses -l shorthand for log-level', () => {
    const opts = parseArgs([...base, '-l', 'warn']);
    expect(opts.logLevel).toBe('warn');
  });

  it('parses all flags combined', () => {
    const opts = parseArgs([
      ...base,
      '--port', '9847',
      '--stdio',
      '--config', '/etc/nr.json',
      '--log-level', 'error',
    ]);
    expect(opts.port).toBe(9847);
    expect(opts.stdio).toBe(true);
    expect(opts.config).toBe('/etc/nr.json');
    expect(opts.logLevel).toBe('error');
  });
});

describe('stdio integration', () => {
  it('responds to MCP initialize handshake and lists tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );
    const { resolve } = await import('node:path');

    // Resolve from this test file's directory (src/) up to the package root,
    // then into dist/. Works regardless of process.cwd().
    const binPath = resolve(__dirname, '..', 'dist', 'index.js');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe('nr-ai-observability');

    const tools = await client.listTools();
    expect(tools.tools).toEqual([]);

    await client.close();
  }, 10000);
});

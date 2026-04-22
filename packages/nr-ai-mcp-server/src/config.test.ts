import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpConfig, redactSensitive } from './config.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let savedEnv: NodeJS.ProcessEnv;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  savedEnv = { ...process.env };
  tmpDir = resolve(tmpdir(), `nr-mcp-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Clear all relevant env vars to isolate tests
  delete process.env.NEW_RELIC_LICENSE_KEY;
  delete process.env.NEW_RELIC_ACCOUNT_ID;
  delete process.env.NEW_RELIC_AI_MCP_APP_NAME;
  delete process.env.NEW_RELIC_AI_MCP_DEVELOPER;
  delete process.env.NEW_RELIC_AI_MCP_ENABLED;
  delete process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT;
  delete process.env.NEW_RELIC_AI_MCP_STORAGE_PATH;
  delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
  delete process.env.NEW_RELIC_AI_MCP_PORT;
  delete process.env.NEW_RELIC_AI_MCP_LOG_LEVEL;
  delete process.env.NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS;
  delete process.env.NEW_RELIC_AI_MCP_HARVEST_METRICS_MS;
  delete process.env.NEW_RELIC_HOST;
  delete process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS;
});

afterEach(() => {
  process.env = savedEnv;
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfigFile(data: Record<string, unknown>): string {
  const path = resolve(tmpDir, 'config.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe('loadMcpConfig()', () => {
  it('throws with descriptive error when licenseKey is missing', () => {
    const configPath = writeConfigFile({ accountId: '12345' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: licenseKey/,
    );
  });

  it('throws with descriptive error when accountId is missing', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: accountId/,
    );
  });

  it('loads required fields from config file', () => {
    const configPath = writeConfigFile({
      licenseKey: 'file-key-123',
      accountId: '99999',
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.licenseKey).toBe('file-key-123');
    expect(config.accountId).toBe('99999');
  });

  it('env vars override config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'env-key-456';
    process.env.NEW_RELIC_ACCOUNT_ID = '11111';
    const configPath = writeConfigFile({
      licenseKey: 'file-key-123',
      accountId: '99999',
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.licenseKey).toBe('env-key-456');
    expect(config.accountId).toBe('11111');
  });

  it('CLI options override env vars and config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PORT = '5555';
    process.env.NEW_RELIC_AI_MCP_LOG_LEVEL = 'debug';
    const configPath = writeConfigFile({ port: 3333, logLevel: 'warn' });

    const config = loadMcpConfig({
      config: configPath,
      port: 7777,
      logLevel: 'error',
    });
    expect(config.port).toBe(7777);
    expect(config.logLevel).toBe('error');
  });

  it('uses correct default values', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });

    expect(config.appName).toBe('nr-ai-mcp-server');
    expect(config.enabled).toBe(true);
    expect(config.recordContent).toBe(false);
    expect(config.port).toBe(9847);
    expect(config.logLevel).toBe('info');
    expect(config.harvestIntervalMs.events).toBe(5000);
    expect(config.harvestIntervalMs.metrics).toBe(60000);
    expect(config.collectorHost).toBeNull();
  });

  it('developer defaults to $USER env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.USER = 'testuser';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('testuser');
  });

  it('developer from env overrides $USER', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.USER = 'testuser';
    process.env.NEW_RELIC_AI_MCP_DEVELOPER = 'alice';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('alice');
  });

  it('developer from config file overrides $USER', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.USER = 'testuser';
    const configPath = writeConfigFile({ developer: 'bob' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('bob');
  });

  it('EU license key sets collectorHost to eu', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'eu01xx-key-123456';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.collectorHost).toBe('eu');
  });

  it('US license key leaves collectorHost null', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us-key-123456';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.collectorHost).toBeNull();
  });

  it('explicit collectorHost overrides license key detection', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us-key-123456';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_HOST = 'custom-collector.example.com';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.collectorHost).toBe('custom-collector.example.com');
  });

  it('boolean env vars work correctly', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_ENABLED = 'false';
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.enabled).toBe(false);
    expect(config.recordContent).toBe(true);
  });

  it('returns a frozen object', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(() => {
      (config as Record<string, unknown>).appName = 'hacked';
    }).toThrow();
  });

  it('gracefully handles missing config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const config = loadMcpConfig({ config: '/nonexistent/path/config.json' });
    expect(config.licenseKey).toBe('test-key');
  });

  it('gracefully handles invalid JSON in config file and logs a warning', () => {
    const path = resolve(tmpDir, 'bad.json');
    writeFileSync(path, 'not json{{{');
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const config = loadMcpConfig({ config: path });
    expect(config.licenseKey).toBe('test-key');
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/warn/);
    expect(stderrOutput).toMatch(/Failed to parse config file/);
  });

  it('silently ignores missing config file without a warning', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const config = loadMcpConfig({ config: resolve(tmpDir, 'nonexistent.json') });
    expect(config.licenseKey).toBe('test-key');
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).not.toMatch(/Failed to parse config file/);
  });

  it('harvest interval env vars override file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS = '10000';
    process.env.NEW_RELIC_AI_MCP_HARVEST_METRICS_MS = '120000';
    const configPath = writeConfigFile({
      harvestEventsMs: 1000,
      harvestMetricsMs: 30000,
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.harvestIntervalMs.events).toBe(10000);
    expect(config.harvestIntervalMs.metrics).toBe(120000);
  });

  it('proxyUpstreams defaults to empty array', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual([]);
  });

  it('proxyUpstreams loaded from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const upstreams = [
      { name: 'server-a', url: 'http://localhost:3000', transportType: 'http' },
      { name: 'server-b', command: 'node', args: ['server.js'], transportType: 'stdio' },
    ];
    const configPath = writeConfigFile({ proxyUpstreams: upstreams });
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual(upstreams);
  });

  it('proxyUpstreams from env var overrides config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const envUpstreams = [{ name: 'env-server', url: 'http://localhost:4000', transportType: 'http' }];
    process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS = JSON.stringify(envUpstreams);
    const configPath = writeConfigFile({
      proxyUpstreams: [{ name: 'file-server', url: 'http://localhost:3000', transportType: 'http' }],
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual(envUpstreams);
  });

  it('invalid proxyUpstreams env var falls back to file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS = 'not-json';
    const upstreams = [{ name: 'server-a', url: 'http://localhost:3000', transportType: 'http' }];
    const configPath = writeConfigFile({ proxyUpstreams: upstreams });
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual(upstreams);
  });

  it('non-array JSON in proxyUpstreams env var falls back to file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS = JSON.stringify({ name: 'forgot-brackets' });
    const upstreams = [{ name: 'file-server', url: 'http://localhost:3001', transportType: 'http' }];
    const configPath = writeConfigFile({ proxyUpstreams: upstreams });
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual(upstreams);
  });

  it('filters out upstream entries missing required fields', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const upstreams = [
      { name: 'valid', url: 'http://localhost:3000', transportType: 'http' },
      { name: 'missing-type' },
      { transportType: 'http', url: 'http://localhost:3001' },
    ];
    const configPath = writeConfigFile({ proxyUpstreams: upstreams });
    const config = loadMcpConfig({ config: configPath });
    expect(config.proxyUpstreams).toEqual([
      { name: 'valid', url: 'http://localhost:3000', transportType: 'http' },
    ]);
  });
});

describe('redactSensitive()', () => {
  it('redacts API_KEY=value patterns', () => {
    const input = 'some config API_KEY=sk-abc123 and more';
    const result = redactSensitive(input);
    expect(result).toBe('some config [REDACTED] and more');
    expect(result).not.toContain('sk-abc123');
  });

  it('redacts SECRET=value patterns', () => {
    const input = 'SECRET=mysecretvalue';
    const result = redactSensitive(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts TOKEN=value patterns', () => {
    const input = 'header TOKEN: bearer-xyz-123';
    const result = redactSensitive(input);
    expect(result).not.toContain('bearer-xyz-123');
  });

  it('redacts GitHub personal access tokens', () => {
    const input = 'auth: ghp_abc123def456ghi789';
    const result = redactSensitive(input);
    expect(result).not.toContain('ghp_abc123def456ghi789');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const result = redactSensitive(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts OpenAI-style API keys', () => {
    const input = 'key: sk-proj-abc123def456';
    const result = redactSensitive(input);
    expect(result).not.toContain('sk-proj-abc123def456');
  });

  it('redacts PEM private keys', () => {
    const input = 'data -----BEGIN RSA PRIVATE KEY-----\nMIIE...base64...\n-----END RSA PRIVATE KEY----- end';
    const result = redactSensitive(input);
    expect(result).not.toContain('MIIE');
    expect(result).toContain('[REDACTED]');
  });

  it('accepts custom patterns', () => {
    const input = 'foo=bar baz=qux';
    const result = redactSensitive(input, [/foo=\S+/g]);
    expect(result).toBe('[REDACTED] baz=qux');
  });

  it('returns original string when no patterns match', () => {
    const input = 'just a normal string with no secrets';
    const result = redactSensitive(input);
    expect(result).toBe(input);
  });

  it('handles multiple matches in one string', () => {
    const input = 'API_KEY=first SECRET=second PASSWORD=third';
    const result = redactSensitive(input);
    expect(result).not.toContain('first');
    expect(result).not.toContain('second');
    expect(result).not.toContain('third');
  });
});

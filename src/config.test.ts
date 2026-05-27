import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpConfig, redactSensitive, sanitizeDeveloper, normalizeDeveloperName } from './config.js';

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
  delete process.env.NEW_RELIC_AI_HIGH_SECURITY;
  delete process.env.NEW_RELIC_AI_MODEL;
  delete process.env.NEW_RELIC_AI_SESSION_BUDGET_USD;
  delete process.env.NEW_RELIC_AI_DAILY_BUDGET_USD;
  delete process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD;
  delete process.env.NEW_RELIC_AI_TEAM_ID;
  delete process.env.NEW_RELIC_AI_PROJECT_ID;
  delete process.env.NEW_RELIC_AI_ORG_ID;
  delete process.env.NEW_RELIC_API_KEY;
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

  // S-03: accountId format validation
  it('throws when accountId contains path-traversal characters', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '123/../other';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /accountId must be 1–12 decimal digits/,
    );
  });

  it('throws when accountId is non-numeric', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({ accountId: 'not-a-number' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /accountId must be 1–12 decimal digits/,
    );
  });

  it('throws when accountId exceeds 12 digits', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({ accountId: '1234567890123' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /accountId must be 1–12 decimal digits/,
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

  // S-06: envInt bounds clamping for harvest intervals and port
  it('clamps harvest events interval to minimum 100ms', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS = '-1';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.harvestIntervalMs.events).toBe(100);
  });

  it('clamps harvest metrics interval to minimum 100ms', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_HARVEST_METRICS_MS = '0';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.harvestIntervalMs.metrics).toBe(100);
  });

  it('clamps harvest interval to maximum 3_600_000ms', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS = '999999999';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.harvestIntervalMs.events).toBe(3_600_000);
  });

  it('clamps port to valid TCP range 1–65535', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PORT = '99999';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.port).toBe(65535);
  });

  it('clamps port to minimum 1', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PORT = '0';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.port).toBe(1);
  });

  it('accepts a valid port within range', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_PORT = '8080';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.port).toBe(8080);
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
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.enabled).toBe(true);
    expect(config.recordContent).toBe(false);
    expect(config.port).toBe(9847);
    expect(config.logLevel).toBe('info');
    expect(config.harvestIntervalMs.events).toBe(5000);
    expect(config.harvestIntervalMs.metrics).toBe(60000);
    expect(config.collectorHost).toBeNull();
  });

  it('model can be overridden via NEW_RELIC_AI_MODEL env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MODEL = 'claude-opus-4-7';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.model).toBe('claude-opus-4-7');
  });

  it('model can be set via config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ model: 'claude-haiku-4-5' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.model).toBe('claude-haiku-4-5');
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

  it('throws on invalid JSON in config file (F-033)', () => {
    const path = resolve(tmpDir, 'bad.json');
    writeFileSync(path, 'not json{{{');
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).toThrow(/Config file parsing failed/);
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/error/);
    expect(stderrOutput).toMatch(/Invalid JSON in config file/);
  });

  it('throws on invalid config file schema (F-036)', () => {
    const path = resolve(tmpDir, 'bad-schema.json');
    writeFileSync(path, JSON.stringify({
      sessionBudgetUsd: 'not-a-number', // should be number
      licenseKey: 'test-key',
      accountId: '12345',
    }));
    process.env.NEW_RELIC_LICENSE_KEY = 'ignored';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).toThrow(/Config file validation failed/);
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/error/);
    expect(stderrOutput).toMatch(/validation failed/);
  });

  it('rejects unknown fields in config file (F-036)', () => {
    const path = resolve(tmpDir, 'unknown-fields.json');
    writeFileSync(path, JSON.stringify({
      licenseKey: 'test-key',
      accountId: '12345',
      unknownField: 'should-fail',
    }));
    process.env.NEW_RELIC_LICENSE_KEY = 'ignored';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).toThrow(/Config file validation failed/);
  });

  it('accepts valid config file with all optional numeric fields (F-036)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const path = resolve(tmpDir, 'valid-numeric.json');
    writeFileSync(path, JSON.stringify({
      sessionBudgetUsd: 10.5,
      dailyBudgetUsd: 50,
      weeklyBudgetUsd: 300,
      port: 9847,
      harvestEventsMs: 5000,
      harvestMetricsMs: 60000,
    }));
    const config = loadMcpConfig({ config: path });
    expect(config.sessionBudgetUsd).toBe(10.5);
    expect(config.dailyBudgetUsd).toBe(50);
    expect(config.weeklyBudgetUsd).toBe(300);
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

  // N-10: highSecurity mode
  it('highSecurity defaults to false', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(false);
  });

  it('highSecurity=true set via env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
  });

  it('highSecurity=true from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ highSecurity: true });
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
  });

  it('highSecurity forces recordContent to false even when env var says true (N-10)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('highSecurity env var overrides highSecurity=false in config file (N-10)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    const configPath = writeConfigFile({ highSecurity: false, recordContent: true });
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('recordContent is respected when highSecurity is false (N-10)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(false);
    expect(config.recordContent).toBe(true);
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

  it('redacts AWS access key IDs', () => {
    const input = 'key: AKIAIOSFODNN7EXAMPLE and more';
    const result = redactSensitive(input);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Google API keys', () => {
    // AIzaSy (6) + exactly 33 chars = 39 char key
    const input = 'apiKey: AIzaSyDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const result = redactSensitive(input);
    expect(result).not.toContain('AIzaSy');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts bare JWT tokens', () => {
    const input = 'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactSensitive(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts npm auth tokens', () => {
    const input = 'npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const result = redactSensitive(input);
    expect(result).not.toContain('npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts all Slack token types', () => {
    const inputs = [
      'xoxa-123-456-789-abc',
      'xoxb-123-456-789-abc',
      'xoxp-123-456-789-abc',
      'xoxr-123-456-789-abc',
    ];
    for (const input of inputs) {
      const result = redactSensitive(input);
      expect(result).not.toContain(input);
      expect(result).toContain('[REDACTED]');
    }
  });

  // N-02: ReDoS protection
  it('truncates input over 1 MB before applying patterns (N-02)', () => {
    const overLimit = 'A'.repeat(1_048_577);
    const result = redactSensitive(overLimit);
    expect(result.length).toBeLessThanOrEqual(1_048_576);
  });

  it('still redacts secrets that appear within the first 1 MB of a large input (N-02)', () => {
    const secret = 'sk-secretvalue12345';
    const padding = 'x'.repeat(100_000);
    const result = redactSensitive(`${padding}${secret}${padding}`);
    expect(result).not.toContain(secret);
  });

  it('does not match an unterminated PEM block — bounded pattern prevents ReDoS (N-02)', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----' + 'A'.repeat(200);
    const result = redactSensitive(input);
    expect(result).toBe(input);
  });
});

describe('sanitizeDeveloper() (N-07)', () => {
  it('strips ASCII control characters', () => {
    expect(sanitizeDeveloper('alice\x00bob')).toBe('alicebob');
    expect(sanitizeDeveloper('user\x1fname')).toBe('username');
    expect(sanitizeDeveloper('name\x7f!')).toBe('name!');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeDeveloper('  alice  ')).toBe('alice');
    expect(sanitizeDeveloper('\t bob \n')).toBe('bob');
  });

  it('truncates to 128 characters', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeDeveloper(long)).toBe('a'.repeat(128));
  });

  it('returns "unknown" for an empty string', () => {
    expect(sanitizeDeveloper('')).toBe('unknown');
  });

  it('returns "unknown" for a control-character-only string', () => {
    expect(sanitizeDeveloper('\x00\x01\x02\x1f\x7f')).toBe('unknown');
  });

  it('leaves normal names unchanged', () => {
    expect(sanitizeDeveloper('alice')).toBe('alice');
    expect(sanitizeDeveloper('John Doe')).toBe('John Doe');
  });
});

describe('budget fields', () => {
  it('budget fields default to null when not configured', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.sessionBudgetUsd).toBeNull();
    expect(config.dailyBudgetUsd).toBeNull();
    expect(config.weeklyBudgetUsd).toBeNull();
  });

  it('loads sessionBudgetUsd from env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_SESSION_BUDGET_USD = '5.00';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.sessionBudgetUsd).toBe(5.0);
  });

  it('loads dailyBudgetUsd from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dailyBudgetUsd: 20 });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dailyBudgetUsd).toBe(20);
  });

  it('env var overrides config file for budget fields', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD = '100';
    const configPath = writeConfigFile({ weeklyBudgetUsd: 50 });
    const config = loadMcpConfig({ config: configPath });
    expect(config.weeklyBudgetUsd).toBe(100);
  });

  it('handles decimal budget values', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_SESSION_BUDGET_USD = '12.50';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.sessionBudgetUsd).toBe(12.5);
  });

  it('treats invalid (non-numeric) budget env var as null', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_SESSION_BUDGET_USD = 'abc';
    process.env.NEW_RELIC_AI_DAILY_BUDGET_USD = 'NaN';
    process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD = '-5';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.sessionBudgetUsd).toBeNull();
    expect(config.dailyBudgetUsd).toBeNull();
    expect(config.weeklyBudgetUsd).toBeNull();
  });
});

describe('developer sanitization via loadMcpConfig() (N-07)', () => {
  it('strips control characters from NEW_RELIC_AI_MCP_DEVELOPER env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_DEVELOPER = 'alice\x00\x1f';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('alice');
  });

  it('truncates a developer name over 64 chars from env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_MCP_DEVELOPER = 'a'.repeat(200);
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('a'.repeat(64));
  });

  it('strips control characters from developer in config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.USER = 'ignored';
    const configPath = writeConfigFile({ developer: 'bob\x0d\x0a' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('bob');
  });

  it('strips control characters from $USER env var path', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.USER = 'charlie\x07';
    delete process.env.NEW_RELIC_AI_MCP_DEVELOPER;
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.developer).toBe('charlie');
  });

  it('teamId loaded from NEW_RELIC_AI_TEAM_ID env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_TEAM_ID = 'my-team';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.teamId).toBe('my-team');
  });

  it('teamId defaults to null when not set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.teamId).toBeNull();
  });

  it('projectId uses config file value when no env var set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ projectId: 'myorg/myrepo' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.projectId).toBe('myorg/myrepo');
  });

  it('projectId is null when git remote throws', () => {
    const origDir = process.cwd();
    try {
      process.chdir(tmpDir); // non-git directory → git remote get-url origin throws
      process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
      process.env.NEW_RELIC_ACCOUNT_ID = '12345';
      const configPath = writeConfigFile({});
      const config = loadMcpConfig({ config: configPath });
      expect(config.projectId).toBeNull();
    } finally {
      process.chdir(origDir);
    }
  });

  it('orgId loaded from NEW_RELIC_AI_ORG_ID env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_ORG_ID = 'acme-corp';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.orgId).toBe('acme-corp');
  });

  it('orgId defaults to null when not set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.orgId).toBeNull();
  });

  it('nrApiKey loaded from NEW_RELIC_API_KEY env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-abc123';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.nrApiKey).toBe('NRAK-abc123');
  });

  it('nrApiKey is null when not set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.nrApiKey).toBeNull();
  });
});

describe('normalizeDeveloperName', () => {
  it('lowercases the input', () => {
    expect(normalizeDeveloperName('JohnDoe')).toBe('johndoe');
  });

  it('replaces spaces with underscores', () => {
    expect(normalizeDeveloperName('John Doe')).toBe('john_doe');
  });

  it('collapses multiple non-alphanumeric chars to a single underscore', () => {
    expect(normalizeDeveloperName('john.doe@example.com')).toBe('john_doe_example_com');
  });

  it('strips leading and trailing underscores', () => {
    expect(normalizeDeveloperName('  john  ')).toBe('john');
  });

  it('preserves hyphens', () => {
    expect(normalizeDeveloperName('john-doe')).toBe('john-doe');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(normalizeDeveloperName(long)).toHaveLength(64);
  });

  it('returns unknown for empty or whitespace-only input', () => {
    expect(normalizeDeveloperName('')).toBe('unknown');
    expect(normalizeDeveloperName('   ')).toBe('unknown');
  });

  it('strips control characters', () => {
    expect(normalizeDeveloperName('john\x00doe')).toBe('johndoe');
    expect(normalizeDeveloperName('john\x1fdoe')).toBe('johndoe');
  });

  it('handles $USER-style values consistently across machines', () => {
    expect(normalizeDeveloperName('cdehaan')).toBe('cdehaan');
    expect(normalizeDeveloperName('CDEHAAN')).toBe('cdehaan');
  });
});

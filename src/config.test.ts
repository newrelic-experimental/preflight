import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMcpConfig,
  redactSensitive,
  sanitizeDeveloper,
  normalizeDeveloperName,
  validateConfigFile,
} from './config.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let savedEnv: NodeJS.ProcessEnv;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
  delete process.env.NR_AI_MODE;
  delete process.env.NR_AI_DASHBOARD_PORT;
  delete process.env.NR_AI_DASHBOARD_HOST;
  delete process.env.NR_AI_DASHBOARD_OPEN;
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

  // accountId format validation
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

  // envInt bounds clamping for harvest intervals and port
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

    expect(config.appName).toBe('preflight');
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

  it('platformTarget is read from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ platformTarget: 'wsl-linux-cc' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.platformTarget).toBe('wsl-linux-cc');
  });

  it('platformTarget is undefined when absent from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.platformTarget).toBeUndefined();
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

  it('throws on invalid JSON in config file', () => {
    const path = resolve(tmpDir, 'bad.json');
    writeFileSync(path, 'not json{{{');
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).toThrow(/Config file parsing failed/);
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/error/);
    expect(stderrOutput).toMatch(/Invalid JSON in config file/);
  });

  it('throws on invalid config file schema', () => {
    const path = resolve(tmpDir, 'bad-schema.json');
    writeFileSync(
      path,
      JSON.stringify({
        sessionBudgetUsd: 'not-a-number', // should be number
        licenseKey: 'test-key',
        accountId: '12345',
      }),
    );
    process.env.NEW_RELIC_LICENSE_KEY = 'ignored';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).toThrow(/Config file validation failed/);
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/error/);
    expect(stderrOutput).toMatch(/validation failed/);
  });

  // Pre-launch: schema-evolution friendliness. Unknown keys must NOT brick
  // the server on upgrade. We log a warning and keep going (the unknown key
  // is dropped from the resolved config).
  it('tolerates unknown top-level fields in config file and warns (task #22)', () => {
    const path = resolve(tmpDir, 'unknown-fields.json');
    writeFileSync(
      path,
      JSON.stringify({
        licenseKey: 'test-key',
        accountId: '12345',
        unknownField: 'should-be-ignored',
        anotherFutureField: 42,
      }),
    );
    process.env.NEW_RELIC_LICENSE_KEY = 'ignored';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    expect(() => loadMcpConfig({ config: path })).not.toThrow();
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/Unknown keys in config file/);
    expect(stderrOutput).toContain('unknownField');
    expect(stderrOutput).toContain('anotherFutureField');
  });

  it('loads an empty {} config file successfully (task #22)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const path = resolve(tmpDir, 'empty.json');
    writeFileSync(path, JSON.stringify({}));
    const config = loadMcpConfig({ config: path });
    expect(config.licenseKey).toBe('test-key');
    expect(config.accountId).toBe('12345');
    // No unknown-keys warning when file is empty
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).not.toMatch(/Unknown keys in config file/);
  });

  it('does not warn for recognized keys in config file (task #22)', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const path = resolve(tmpDir, 'all-known.json');
    writeFileSync(
      path,
      JSON.stringify({
        licenseKey: 'test-key',
        accountId: '12345',
        mode: 'local',
        sessionBudgetUsd: 5,
      }),
    );
    loadMcpConfig({ config: path });
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).not.toMatch(/Unknown keys in config file/);
  });

  it('accepts valid config file with all optional numeric fields', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const path = resolve(tmpDir, 'valid-numeric.json');
    writeFileSync(
      path,
      JSON.stringify({
        sessionBudgetUsd: 10.5,
        dailyBudgetUsd: 50,
        weeklyBudgetUsd: 300,
        port: 9847,
        harvestEventsMs: 5000,
        harvestMetricsMs: 60000,
      }),
    );
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
    const envUpstreams = [
      { name: 'env-server', url: 'http://localhost:4000', transportType: 'http' },
    ];
    process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS = JSON.stringify(envUpstreams);
    const configPath = writeConfigFile({
      proxyUpstreams: [
        { name: 'file-server', url: 'http://localhost:3000', transportType: 'http' },
      ],
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
    const upstreams = [
      { name: 'file-server', url: 'http://localhost:3001', transportType: 'http' },
    ];
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

  // highSecurity mode
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

  it('highSecurity forces recordContent to false even when env var says true', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('highSecurity env var overrides highSecurity=false in config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    const configPath = writeConfigFile({ highSecurity: false, recordContent: true });
    const config = loadMcpConfig({ config: configPath });
    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('recordContent is respected when highSecurity is false', () => {
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
    const input = 'auth: ghp_abc123def456ghi789jklmnopqr';
    const result = redactSensitive(input);
    expect(result).not.toContain('ghp_abc123def456ghi789jklmnopqr');
  });

  it('redacts GitHub App installation tokens', () => {
    const input = 'token: ghs_16c7e42f292c6912191abc123def456';
    const result = redactSensitive(input);
    expect(result).not.toContain('ghs_16c7e42f292c6912191abc123def456');
  });

  it('redacts Bearer tokens (JWT format)', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const result = redactSensitive(input);
    // JWT pattern should catch the dots, not the Bearer pattern with bounded chars
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts Bearer tokens (alphanumeric format)', () => {
    const input = 'Authorization: Bearer abc123def456ghi789jklmnopqrstuvwxyz01';
    const result = redactSensitive(input);
    expect(result).not.toContain('abc123def456ghi789jklmnopqrstuvwxyz01');
  });

  it('redacts OpenAI-style API keys', () => {
    const input = 'key: sk-proj-abc123def456789012345678';
    const result = redactSensitive(input);
    expect(result).not.toContain('sk-proj-abc123def456789012345678');
  });

  it('redacts Stripe live keys', () => {
    const input = 'stripe_key: sk_live_51H7mVA1234567890abcdefghijklmn';
    const result = redactSensitive(input);
    expect(result).not.toContain('sk_live_51H7mVA1234567890abcdefghijklmn');
  });

  it('redacts Stripe test keys', () => {
    const input = 'stripe_key: sk_test_51H7mVA1234567890abcdefghijklmn';
    const result = redactSensitive(input);
    expect(result).not.toContain('sk_test_51H7mVA1234567890abcdefghijklmn');
  });

  it('redacts Stripe restricted keys', () => {
    const input = 'stripe_key: rk_live_51H7mVA1234567890abcdefghijklmn';
    const result = redactSensitive(input);
    expect(result).not.toContain('rk_live_51H7mVA1234567890abcdefghijklmn');
  });

  it('redacts PyPI tokens', () => {
    const input = 'pypi_token: pypi-AgEIcHlwLm9yZzoxMjM0NTY3ODkwYWJjZGVmZ2hpams';
    const result = redactSensitive(input);
    expect(result).not.toContain('pypi-AgEIcHlwLm9yZzoxMjM0NTY3ODkwYWJjZGVmZ2hpams');
  });

  it('redacts Hugging Face tokens', () => {
    const input = 'hf_token: hf_abcdefghijklmnopqrstuvwxyz01234567';
    const result = redactSensitive(input);
    expect(result).not.toContain('hf_abcdefghijklmnopqrstuvwxyz01234567');
  });

  it('redacts PostgreSQL connection strings with credentials', () => {
    const input = 'db: postgres://admin:secretpassword@db.example.com/mydb';
    const result = redactSensitive(input);
    expect(result).not.toContain('admin:secretpassword');
  });

  it('redacts MongoDB connection strings with credentials', () => {
    const input = 'db: mongodb://user:password@cluster.mongodb.net/db';
    const result = redactSensitive(input);
    expect(result).not.toContain('user:password');
  });

  it('redacts MongoDB+srv connection strings with credentials', () => {
    const input = 'db: mongodb+srv://admin:mypassword123@cluster.mongodb.net/db';
    const result = redactSensitive(input);
    expect(result).not.toContain('admin:mypassword123');
  });

  it('redacts MySQL connection strings with credentials', () => {
    const input = 'db: mysql://root:rootpass@localhost/db';
    const result = redactSensitive(input);
    expect(result).not.toContain('root:rootpass');
  });

  it('redacts Redis connection strings with credentials', () => {
    const input = 'db: redis://admin:redispass@redis.example.com';
    const result = redactSensitive(input);
    expect(result).not.toContain('admin:redispass');
  });

  it('redacts HTTP basic-auth credentials in URLs', () => {
    const input = 'url: http://user:password@api.example.com/endpoint';
    const result = redactSensitive(input);
    expect(result).not.toContain('user:password');
  });

  it('redacts HTTPS basic-auth credentials in URLs', () => {
    const input = 'url: https://admin:secretpass@secure.example.com/api';
    const result = redactSensitive(input);
    expect(result).not.toContain('admin:secretpass');
  });

  it('redacts Twilio Account SID', () => {
    const input = 'twilio_sid: ACa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const result = redactSensitive(input);
    expect(result).not.toContain('ACa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  });

  it('redacts Twilio API key', () => {
    const input = 'twilio_key: SK1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
    const result = redactSensitive(input);
    expect(result).not.toContain('SK1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');
  });

  it('redacts PEM private keys', () => {
    const input =
      'data -----BEGIN RSA PRIVATE KEY-----\nMIIE...base64...\n-----END RSA PRIVATE KEY----- end';
    const result = redactSensitive(input);
    expect(result).not.toContain('MIIE');
    expect(result).toContain('[REDACTED]');
  });

  it('does not over-redact special characters after tokens', () => {
    const input = 'github_auth: ghp_abc123defghijklmnopqrstuvwxyz1234@example.com';
    const result = redactSensitive(input);
    // Token part is redacted, but @example.com should be preserved
    expect(result).toContain('@example.com');
    expect(result).toContain('[REDACTED]');
  });

  it('stops redaction at non-matching characters', () => {
    const input = 'credential: sk-proj-abc123defghijklmnopqrstuvwxyz123/path/to/file';
    const result = redactSensitive(input);
    // Token is redacted, but /path/to/file should remain
    expect(result).toContain('/path/to/file');
  });

  it('does not consume unbounded characters beyond 200', () => {
    const input = 'github_key: ghp_' + 'a'.repeat(250);
    const result = redactSensitive(input);
    // Only up to 200 characters after ghp_ should be redacted
    // The test verifies that we don't consume everything with unbounded \S+
    expect(result).toContain('[REDACTED]');
    const afterRedaction = result.split('[REDACTED]')[1];
    expect(afterRedaction.length).toBeGreaterThan(0);
    expect(afterRedaction).toContain('aaa');
  });

  it('redacts Azure SAS token with sv parameter', () => {
    const input =
      'url: https://storage.blob.core.windows.net/container/blob?sv=2021-06-08&ss=bfqt&srt=sco&sig=abcdef123456';
    const result = redactSensitive(input);
    expect(result).not.toContain('sv=2021-06-08');
    expect(result).not.toContain('sig=abcdef123456');
  });

  it('redacts Azure SAS token with se parameter', () => {
    const input =
      'url: https://storage.blob.core.windows.net?se=2021-12-31T23:59:59Z&sig=token123456789';
    const result = redactSensitive(input);
    expect(result).not.toContain('se=2021-12-31T23:59:59Z');
    expect(result).not.toContain('sig=token123456789');
  });

  it('redacts Azure SAS token with sp parameter', () => {
    const input =
      'url: https://storage.blob.core.windows.net/blob?sp=racwd&sig=secrettoken123456789';
    const result = redactSensitive(input);
    expect(result).not.toContain('sp=racwd');
    expect(result).not.toContain('sig=secrettoken123456789');
  });

  it('redacts Vercel tokens', () => {
    const input = 'vercel_token: vercel_abc123def456ghi789jklmnopqrstuvwxyz012345';
    const result = redactSensitive(input);
    expect(result).not.toContain('vercel_abc123def456ghi789jklmnopqrstuvwxyz012345');
  });

  it('redacts Heroku tokens', () => {
    const input = 'heroku_key: heroku_abc123def456ghi789jklmnopqrstuvwxyz012345';
    const result = redactSensitive(input);
    expect(result).not.toContain('heroku_abc123def456ghi789jklmnopqrstuvwxyz012345');
  });

  it('redacts Datadog tokens', () => {
    const input = 'dd_token: dd_abc123def456ghi789jklmnopqrstuvwxyz01234567';
    const result = redactSensitive(input);
    expect(result).not.toContain('dd_abc123def456ghi789jklmnopqrstuvwxyz01234567');
  });

  it('redacts PagerDuty tokens', () => {
    const input = 'pagerduty_key: pk_abc123def456ghi789jklmnopqrstuvwxyz01234567';
    const result = redactSensitive(input);
    expect(result).not.toContain('pk_abc123def456ghi789jklmnopqrstuvwxyz01234567');
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
    const input =
      'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
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

  // ReDoS protection
  it('truncates input over 1 MB before applying patterns', () => {
    const overLimit = 'A'.repeat(1_048_577);
    const result = redactSensitive(overLimit);
    expect(result.length).toBeLessThanOrEqual(1_048_576);
  });

  it('still redacts secrets that appear within the first 1 MB of a large input', () => {
    const secret = 'sk-secretvalue12345';
    const padding = 'x'.repeat(100_000);
    const result = redactSensitive(`${padding}${secret}${padding}`);
    expect(result).not.toContain(secret);
  });

  it('does not match an unterminated PEM block — bounded pattern prevents ReDoS', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----' + 'A'.repeat(200);
    const result = redactSensitive(input);
    expect(result).toBe(input);
  });
});

describe('sanitizeDeveloper()', () => {
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

describe('developer sanitization via loadMcpConfig()', () => {
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
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
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

describe('mode field', () => {
  it("defaults to 'cloud' when unset", () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.mode).toBe('cloud');
  });

  it('reads mode from NR_AI_MODE env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_MODE = 'local';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.mode).toBe('local');
  });

  it('file value beats default but loses to env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_MODE = 'local';
    const configPath = writeConfigFile({ mode: 'both' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.mode).toBe('local');
  });

  it('file value wins when env var unset', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ mode: 'both' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.mode).toBe('both');
  });
});

describe('licenseKey gating', () => {
  it("throws when mode='cloud' and licenseKey missing", () => {
    const configPath = writeConfigFile({ accountId: '12345' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: licenseKey/,
    );
  });

  it("does NOT throw when mode='local' and licenseKey missing", () => {
    process.env.NR_AI_MODE = 'local';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).not.toThrow();
  });

  it("throws when mode='both' and licenseKey missing", () => {
    process.env.NR_AI_MODE = 'both';
    const configPath = writeConfigFile({ accountId: '12345' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: licenseKey/,
    );
  });

  it("does NOT throw when mode='local' and accountId missing", () => {
    process.env.NR_AI_MODE = 'local';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).not.toThrow();
  });

  it("throws when mode='cloud' and accountId missing", () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: accountId/,
    );
  });

  it("throws when mode='both' and accountId missing", () => {
    process.env.NR_AI_MODE = 'both';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Missing required configuration: accountId/,
    );
  });

  it('throws when NR_AI_MODE is set to an invalid value', () => {
    process.env.NR_AI_MODE = 'offline';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '1234';
    const configPath = writeConfigFile({});
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Invalid NR_AI_MODE='offline'.*cloud, local, both/,
    );
  });

  it('treats NR_AI_MODE empty string as unset and falls back to file/default', () => {
    process.env.NR_AI_MODE = '';
    const configPath = writeConfigFile({ mode: 'local' });
    const config = loadMcpConfig({ config: configPath });
    expect(config.mode).toBe('local');
  });

  it('throws when config file mode is invalid (caught by zod)', () => {
    const configPath = writeConfigFile({ mode: 'offline' as 'cloud' });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(
      /Config file validation failed.*mode.*Invalid option: expected one of "cloud"\|"local"\|"both"/,
    );
  });
});

describe('OTLP forward gating on mode=local', () => {
  beforeEach(() => {
    delete process.env.NR_AI_OTLP_FORWARD_ENDPOINT;
    delete process.env.NR_AI_OTLP_FORWARD_HEADERS;
  });

  it("does NOT synthesize NR OTLP defaults when mode='local' and licenseKey is set", () => {
    process.env.NR_AI_MODE = 'local';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.otlpForwardEndpoint).toBeNull();
    expect(config.otlpForwardHeaders).toEqual({});
  });

  it("DOES synthesize NR OTLP defaults when mode='cloud' and licenseKey is set", () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.otlpForwardEndpoint).toBe('https://otlp.nr-data.net');
    expect(config.otlpForwardHeaders).toEqual({ 'api-key': 'test-key-1234567890' });
  });

  it("DOES synthesize NR OTLP defaults when mode='both' and licenseKey is set", () => {
    process.env.NR_AI_MODE = 'both';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.otlpForwardEndpoint).toBe('https://otlp.nr-data.net');
    expect(config.otlpForwardHeaders).toEqual({ 'api-key': 'test-key-1234567890' });
  });

  it("respects explicit env override even when mode='local'", () => {
    process.env.NR_AI_MODE = 'local';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    process.env.NR_AI_OTLP_FORWARD_ENDPOINT = 'https://collector.example.com';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.otlpForwardEndpoint).toBe('https://collector.example.com');
  });

  it("respects explicit file value even when mode='local'", () => {
    process.env.NR_AI_MODE = 'local';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key-1234567890';
    const configPath = writeConfigFile({
      otlpForwardEndpoint: 'https://collector.example.com',
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.otlpForwardEndpoint).toBe('https://collector.example.com');
  });
});

describe('dashboard config', () => {
  it("defaults port=7777, host='127.0.0.1', openOnStart=false", () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(7777);
    expect(config.dashboard.host).toBe('127.0.0.1');
    expect(config.dashboard.openOnStart).toBe(false);
  });

  it('reads dashboard.port from NR_AI_DASHBOARD_PORT', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_PORT = '9999';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(9999);
  });

  it('reads dashboard.port from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dashboard: { port: 8888 } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(8888);
  });

  it('env var NR_AI_DASHBOARD_PORT overrides config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_PORT = '9999';
    const configPath = writeConfigFile({ dashboard: { port: 8888 } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(9999);
  });

  it('passes dashboard port 0 through as OS-assigned ephemeral', () => {
    // Port 0 is special-cased: Node's server.listen(0) lets the OS pick an
    // ephemeral port. Required for parallel test runs and useful for users
    // who want to avoid port conflicts. Negative values still fall back to
    // the default 7777 (see test below).
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_PORT = '0';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(0);
  });

  it('falls back to default 7777 when dashboard port is negative', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_PORT = '-1';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(7777);
  });

  it('falls back to default 7777 when dashboard port exceeds 65535', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_PORT = '99999';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.port).toBe(7777);
  });

  it('reads dashboard.host from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dashboard: { host: '127.0.0.1' } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.host).toBe('127.0.0.1');
  });

  it('reads dashboard.host from NR_AI_DASHBOARD_HOST env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_HOST = 'localhost';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.host).toBe('127.0.0.1');
  });

  it('normalizes localhost to 127.0.0.1 without warning', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dashboard: { host: 'localhost' } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.host).toBe('127.0.0.1');
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).not.toMatch(/non-loopback/);
  });

  it("warns and forces host to 127.0.0.1 when non-loopback '0.0.0.0' configured", () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dashboard: { host: '0.0.0.0' } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.host).toBe('127.0.0.1');
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/non-loopback/);
    expect(stderrOutput).toMatch(/0\.0\.0\.0/);
  });

  it('warns and forces host to 127.0.0.1 when non-loopback env var set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_HOST = '192.168.1.1';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.host).toBe('127.0.0.1');
    const stderrOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/non-loopback/);
    expect(stderrOutput).toMatch(/192\.168\.1\.1/);
  });

  it('reads dashboard.openOnStart from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ dashboard: { openOnStart: true } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.openOnStart).toBe(true);
  });

  it('reads dashboard.openOnStart from NR_AI_DASHBOARD_OPEN env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_OPEN = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.openOnStart).toBe(true);
  });

  it('env var NR_AI_DASHBOARD_OPEN overrides config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_OPEN = 'true';
    const configPath = writeConfigFile({ dashboard: { openOnStart: false } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.openOnStart).toBe(true);
  });

  it('NR_AI_DASHBOARD_OPEN=false does not set openOnStart to true', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_OPEN = 'false';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.openOnStart).toBe(false);
  });

  it('NR_AI_DASHBOARD_OPEN=1 enables openOnStart', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_DASHBOARD_OPEN = '1';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.dashboard.openOnStart).toBe(true);
  });
});

describe('alerts config (Phase 4 task 25)', () => {
  beforeEach(() => {
    delete process.env.NR_AI_ALERTS_ENABLED;
    delete process.env.NR_AI_ALERTS_INTERVAL_SECONDS;
    delete process.env.NR_AI_ALERTS_OS_NOTIFICATIONS;
    delete process.env.NR_AI_ALERTS_LOG_RETENTION_MB;
    delete process.env.NR_AI_ALERTS_RULES_PATH;
  });

  it('applies sensible defaults when alerts block is missing', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    // Cloud mode default → enabled=false (alerts only apply locally).
    expect(config.alerts.enabled).toBe(false);
    expect(config.alerts.evaluationIntervalSeconds).toBe(30);
    expect(config.alerts.osNotifications).toBe(false);
    expect(config.alerts.logRetentionMb).toBe(10);
    expect(config.alerts.rulesPath).toMatch(/alerts[\/\\]rules\.json$/);
  });

  it("defaults enabled=true when mode='local'", () => {
    process.env.NR_AI_MODE = 'local';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.enabled).toBe(true);
  });

  it("defaults enabled=true when mode='both'", () => {
    process.env.NR_AI_MODE = 'both';
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.enabled).toBe(true);
  });

  it('reads enabled from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ alerts: { enabled: true } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.enabled).toBe(true);
  });

  it('NR_AI_ALERTS_ENABLED env var overrides file', () => {
    process.env.NR_AI_MODE = 'local';
    process.env.NR_AI_ALERTS_ENABLED = 'false';
    const configPath = writeConfigFile({ alerts: { enabled: true } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.enabled).toBe(false);
  });

  it('reads evaluationIntervalSeconds from env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_INTERVAL_SECONDS = '60';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.evaluationIntervalSeconds).toBe(60);
  });

  it('clamps evaluationIntervalSeconds to min 5', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_INTERVAL_SECONDS = '1';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.evaluationIntervalSeconds).toBe(5);
  });

  it('clamps evaluationIntervalSeconds to max 300', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_INTERVAL_SECONDS = '99999';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.evaluationIntervalSeconds).toBe(300);
  });

  it('reads evaluationIntervalSeconds from config file', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({ alerts: { evaluationIntervalSeconds: 90 } });
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.evaluationIntervalSeconds).toBe(90);
  });

  it('rejects file evaluationIntervalSeconds outside the bounds at validation time', () => {
    const configPath = writeConfigFile({ alerts: { evaluationIntervalSeconds: 9000 } });
    expect(() => loadMcpConfig({ config: configPath })).toThrow(/Config file validation failed/);
  });

  it('reads osNotifications from env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_OS_NOTIFICATIONS = 'true';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.osNotifications).toBe(true);
  });

  it('reads logRetentionMb from env var with bounds', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_LOG_RETENTION_MB = '50';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.logRetentionMb).toBe(50);
  });

  it('reads rulesPath from env var when it lives under storagePath', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const c1 = loadMcpConfig({ config: configPath });
    const customRules = resolve(c1.storagePath, 'alerts', 'custom.json');
    process.env.NR_AI_ALERTS_RULES_PATH = customRules;
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.rulesPath).toBe(customRules);
  });

  it('rejects rulesPath that does not end in .json — falls back to default', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_RULES_PATH = '/etc/hosts';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.rulesPath).toMatch(/alerts[\/\\]rules\.json$/);
    expect(config.alerts.rulesPath).not.toBe('/etc/hosts');
  });

  it('rejects rulesPath that resolves outside storagePath — falls back to default', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_ALERTS_RULES_PATH = '/tmp/elsewhere.json';
    const configPath = writeConfigFile({});
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.rulesPath).toMatch(/alerts[\/\\]rules\.json$/);
    expect(config.alerts.rulesPath).not.toBe('/tmp/elsewhere.json');
  });

  it('rejects rulesPath with a path-traversal segment', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({});
    const c1 = loadMcpConfig({ config: configPath });
    process.env.NR_AI_ALERTS_RULES_PATH = resolve(c1.storagePath, '..', 'evil.json');
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.rulesPath).toMatch(/alerts[\/\\]rules\.json$/);
  });

  it('does NOT clobber the personalAlertThresholds branch when alerts.* is set', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    const configPath = writeConfigFile({
      alerts: {
        enabled: true,
        personal: { dailyCostUsd: 99 },
      },
    });
    const config = loadMcpConfig({ config: configPath });
    expect(config.alerts.enabled).toBe(true);
    expect(config.personalAlertThresholds.dailyCostUsd).toBe(99);
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
    expect(normalizeDeveloperName('jdoe')).toBe('jdoe');
    expect(normalizeDeveloperName('JDOE')).toBe('jdoe');
  });
});

describe('validateConfigFile()', () => {
  it('returns fileExists:false with no errors for a missing file', () => {
    const result = validateConfigFile(resolve(tmpDir, 'nonexistent.json'));
    expect(result.fileExists).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports a read error separately from a JSON parse error', () => {
    // Write a directory where a file is expected (unreadable as JSON)
    mkdirSync(resolve(tmpDir, 'notafile.json'));
    const result = validateConfigFile(resolve(tmpDir, 'notafile.json'));
    expect(result.fileExists).toBe(true);
    expect(result.errors[0]).toMatch(/Could not read file/);
  });

  it('reports invalid JSON', () => {
    writeFileSync(resolve(tmpDir, 'bad.json'), 'not json{{{');
    const result = validateConfigFile(resolve(tmpDir, 'bad.json'));
    expect(result.errors[0]).toMatch(/Invalid JSON/);
  });

  it('reports a non-object root value', () => {
    writeFileSync(resolve(tmpDir, 'arr.json'), '[1, 2, 3]');
    const result = validateConfigFile(resolve(tmpDir, 'arr.json'));
    expect(result.errors[0]).toMatch(/JSON object/);
  });

  it('returns no errors or warnings for a valid config', () => {
    writeFileSync(
      resolve(tmpDir, 'valid.json'),
      JSON.stringify({ licenseKey: 'abc', accountId: '12345', mode: 'cloud' }),
    );
    const result = validateConfigFile(resolve(tmpDir, 'valid.json'));
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports a Zod type error for a wrong-type field', () => {
    writeFileSync(resolve(tmpDir, 'badtype.json'), JSON.stringify({ enabled: 'yes' }));
    const result = validateConfigFile(resolve(tmpDir, 'badtype.json'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('enabled');
  });

  it('reports a Zod enum error for an invalid mode value', () => {
    writeFileSync(resolve(tmpDir, 'badmode.json'), JSON.stringify({ mode: 'clod' }));
    const result = validateConfigFile(resolve(tmpDir, 'badmode.json'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('mode');
  });

  it('warns about an unknown top-level key with a did-you-mean suggestion', () => {
    writeFileSync(resolve(tmpDir, 'typo.json'), JSON.stringify({ licensekey: 'abc' }));
    const result = validateConfigFile(resolve(tmpDir, 'typo.json'));
    expect(result.warnings[0]).toContain('licensekey');
    expect(result.warnings[0]).toContain('licenseKey');
  });

  it('warns about an unknown key with no suggestion when there is no close match', () => {
    writeFileSync(resolve(tmpDir, 'unknown.json'), JSON.stringify({ completelyWrong: true }));
    const result = validateConfigFile(resolve(tmpDir, 'unknown.json'));
    expect(result.warnings[0]).toContain('completelyWrong');
    expect(result.warnings[0]).not.toContain('did you mean');
  });

  it('warns about unknown keys in nested alerts and dashboard objects', () => {
    writeFileSync(
      resolve(tmpDir, 'nested.json'),
      JSON.stringify({
        alerts: { enabledd: true },
        dashboard: { openOnStarrt: false },
      }),
    );
    const result = validateConfigFile(resolve(tmpDir, 'nested.json'));
    const allWarnings = result.warnings.join('\n');
    expect(allWarnings).toContain('alerts.enabledd');
    expect(allWarnings).toContain('dashboard.openOnStarrt');
  });

  it('never throws, even on empty file', () => {
    writeFileSync(resolve(tmpDir, 'empty.json'), '');
    expect(() => validateConfigFile(resolve(tmpDir, 'empty.json'))).not.toThrow();
  });
});

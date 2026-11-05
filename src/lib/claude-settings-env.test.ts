import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findReceiverDoubleCount, resolveCompanionMode } from '../config.js';
import type { McpServerConfig } from '../config.js';
import { withClaudeSettingsEnv } from './claude-settings-env.js';

describe('withClaudeSettingsEnv', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let managedDir: string;

  const write = (dir: string, name: string, body: unknown): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const load = (env: NodeJS.ProcessEnv) =>
    withClaudeSettingsEnv(env, {
      cwd,
      home,
      managedSettingsPath: join(managedDir, 'managed-settings.json'),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-settings-env-'));
    home = join(root, 'home');
    cwd = join(root, 'repo');
    managedDir = join(root, 'managed');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the shell env unchanged when no settings file exists', () => {
    expect(load({ FOO: 'shell' })).toEqual({ FOO: 'shell' });
  });

  it('lets user settings override the shell and managed settings override user settings', () => {
    write(join(home, '.claude'), 'settings.json', { env: { A: 'user', B: 'user' } });
    write(managedDir, 'managed-settings.json', { env: { B: 'managed' } });
    expect(load({ A: 'shell', C: 'shell' })).toEqual({ A: 'user', B: 'managed', C: 'shell' });
  });

  it('applies managed-settings.d drop-ins alphabetically after managed-settings.json', () => {
    write(managedDir, 'managed-settings.json', { env: { A: 'main', B: 'main', C: 'main' } });
    write(join(managedDir, 'managed-settings.d'), '20-late.json', { env: { B: '20', C: '20' } });
    write(join(managedDir, 'managed-settings.d'), '10-early.json', { env: { A: '10', C: '10' } });
    write(join(managedDir, 'managed-settings.d'), 'notes.txt', 'ignored');
    expect(load({})).toEqual({ A: '10', B: '20', C: '20' });
  });

  it('ignores project and project-local env values, which Claude Code drops', () => {
    write(join(home, '.claude'), 'settings.json', { env: { OTEL_METRICS_EXPORTER: 'otlp' } });
    write(join(cwd, '.claude'), 'settings.json', {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      },
    });
    write(join(cwd, '.claude'), 'settings.local.json', {
      env: { OTEL_METRICS_EXPORTER: 'console' },
    });
    expect(load({})).toEqual({ OTEL_METRICS_EXPORTER: 'otlp' });
  });

  it('still honors a project or project-local exporter of none, which turns export off', () => {
    write(join(home, '.claude'), 'settings.json', { env: { OTEL_METRICS_EXPORTER: 'otlp' } });
    write(join(cwd, '.claude'), 'settings.json', { env: { OTEL_METRICS_EXPORTER: 'none' } });
    expect(load({}).OTEL_METRICS_EXPORTER).toBe('none');
    write(join(cwd, '.claude'), 'settings.json', { env: {} });
    write(join(cwd, '.claude'), 'settings.local.json', { env: { OTEL_LOGS_EXPORTER: 'none' } });
    expect(load({}).OTEL_LOGS_EXPORTER).toBe('none');
  });

  it('reads the user settings from CLAUDE_CONFIG_DIR when set', () => {
    const custom = join(root, 'custom');
    write(custom, 'settings.json', { env: { A: 'custom' } });
    write(join(home, '.claude'), 'settings.json', { env: { A: 'default-home' } });
    expect(load({ CLAUDE_CONFIG_DIR: custom }).A).toBe('custom');
  });

  it('ignores malformed files and non-string env values', () => {
    write(join(home, '.claude'), 'settings.json', '{not json');
    write(managedDir, 'managed-settings.json', { env: { N: 1, S: 'ok', NULLED: null } });
    expect(load({})).toEqual({ S: 'ok' });
  });

  it('lets a settings-file env block drive companion-mode detection and the double-count warning', () => {
    const config = {
      companionMode: false,
      otlp: {
        receiverEnabled: true,
        receiverPort: 4318,
        receiverBindAddress: '127.0.0.1',
        forwardEndpoint: 'https://otlp.nr-data.net',
      },
    } as unknown as McpServerConfig;
    const projectOnly = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      },
    };
    write(join(cwd, '.claude'), 'settings.json', projectOnly);
    expect(findReceiverDoubleCount(load({}), config)).toBeNull();
    write(join(home, '.claude'), 'settings.json', {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      },
    });
    const env = load({});
    expect(findReceiverDoubleCount({}, config)).toBeNull();
    expect(findReceiverDoubleCount(env, config)).toEqual({ grpc: false });

    write(join(home, '.claude'), 'settings.json', {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.nr-data.net',
      },
    });
    expect(resolveCompanionMode(load({}), undefined)).toEqual({
      value: true,
      source: 'detected Claude Code OTel export',
    });
  });
});

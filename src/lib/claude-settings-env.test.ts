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

  const write = (dir: string, name: string, body: unknown): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const load = (env: NodeJS.ProcessEnv) =>
    withClaudeSettingsEnv(env, { cwd, home, platform: 'aix' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-settings-env-'));
    home = join(root, 'home');
    cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the shell env unchanged when no settings file exists', () => {
    expect(load({ FOO: 'shell' })).toEqual({ FOO: 'shell' });
  });

  it('layers user, project, and project-local env blocks in precedence order', () => {
    write(join(home, '.claude'), 'settings.json', { env: { A: 'user', B: 'user', C: 'user' } });
    write(join(cwd, '.claude'), 'settings.json', { env: { B: 'project', C: 'project' } });
    write(join(cwd, '.claude'), 'settings.local.json', { env: { C: 'local' } });
    expect(load({ A: 'shell', D: 'shell' })).toEqual({
      A: 'user',
      B: 'project',
      C: 'local',
      D: 'shell',
    });
  });

  it('reads the user settings from CLAUDE_CONFIG_DIR when set', () => {
    const custom = join(root, 'custom');
    write(custom, 'settings.json', { env: { A: 'custom' } });
    write(join(home, '.claude'), 'settings.json', { env: { A: 'default-home' } });
    expect(load({ CLAUDE_CONFIG_DIR: custom }).A).toBe('custom');
  });

  it('ignores malformed files and non-string env values', () => {
    write(join(home, '.claude'), 'settings.json', '{not json');
    write(join(cwd, '.claude'), 'settings.json', { env: { N: 1, S: 'ok', NULLED: null } });
    expect(load({})).toEqual({ S: 'ok' });
  });

  it('lets a settings-file env block drive companion-mode detection and the double-count warning', () => {
    write(join(home, '.claude'), 'settings.json', {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      },
    });
    const env = load({});
    const config = {
      companionMode: false,
      otlp: {
        receiverEnabled: true,
        receiverPort: 4318,
        receiverBindAddress: '127.0.0.1',
        forwardEndpoint: 'https://otlp.nr-data.net',
      },
    } as unknown as McpServerConfig;
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

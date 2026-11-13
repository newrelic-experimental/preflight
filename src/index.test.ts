import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArgs,
  maskCredential,
  buildProxyTelemetryCallbacks,
  classifyDashboardStartError,
  startDashboardRepoll,
  setupDashboardPostBind,
  getDashboardRepollIntervalMs,
  DEFAULT_DASHBOARD_REPOLL_MS,
  getSessionPersistIntervalMs,
  DEFAULT_SESSION_PERSIST_INTERVAL_MS,
  getPendingConfirmationCapMs,
  DEFAULT_PENDING_CONFIRMATION_CAP_MS,
  startRetentionSweep,
  startMaintenanceGc,
  dispatchSubcommand,
} from './index.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DashboardServer } from './dashboard/dashboard-server.js';
import { sanitizeCwdForFilename } from './hooks/session-resolver.js';
import { SessionStore } from './storage/session-store.js';
import { appendToHookBuffer } from './storage/hook-buffer.js';
import type { LocalStore } from './storage/index.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from './proxy/index.js';
import type { NrIngestManager } from './transport/nr-ingest.js';
import { UNFORWARDED_SESSIONS_HINT } from './transport/unforwarded-session-monitor.js';
import { breadcrumbRoot } from './hooks/session-breadcrumbs.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('parseArgs()', () => {
  // Commander expects argv[0]=node binary, argv[1]=script name
  const base = ['node', 'preflight'];

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

  it('throws on non-numeric port', () => {
    expect(() => parseArgs([...base, '--port', 'foo'])).toThrow(/Invalid port/);
  });

  it('throws on out-of-range port', () => {
    expect(() => parseArgs([...base, '--port', '99999'])).toThrow(/Invalid port/);
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
      '--port',
      '9847',
      '--stdio',
      '--config',
      '/etc/nr.json',
      '--log-level',
      'error',
    ]);
    expect(opts.port).toBe(9847);
    expect(opts.stdio).toBe(true);
    expect(opts.config).toBe('/etc/nr.json');
    expect(opts.logLevel).toBe('error');
  });

  it('defaults validate to false', () => {
    const opts = parseArgs([...base]);
    expect(opts.validate).toBe(false);
  });

  it('parses --validate flag', () => {
    const opts = parseArgs([...base, '--validate']);
    expect(opts.validate).toBe(true);
  });

  it('--validate combined with --config is accepted', () => {
    const opts = parseArgs([...base, '--validate', '--config', '/etc/nr.json']);
    expect(opts.validate).toBe(true);
    expect(opts.config).toBe('/etc/nr.json');
  });

  it('--validate and --stdio are mutually exclusive', () => {
    expect(() => parseArgs([...base, '--validate', '--stdio'])).toThrow(/mutually exclusive/);
  });

  it('--validate and --local are mutually exclusive', () => {
    expect(() => parseArgs([...base, '--validate', '--local'])).toThrow(/mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// maskCredential()
// ---------------------------------------------------------------------------

describe('maskCredential()', () => {
  it('masks a normal-length key to first-4...last-4', () => {
    expect(maskCredential('ABCD1234567890WXYZ')).toBe('ABCD...WXYZ');
  });

  it('returns *** for keys of exactly 8 characters (would fully expose if unguarded)', () => {
    expect(maskCredential('ABCD1234')).toBe('***');
  });

  it('returns *** for keys shorter than 8 characters', () => {
    expect(maskCredential('SHORT')).toBe('***');
    expect(maskCredential('X')).toBe('***');
    expect(maskCredential('')).toBe('***');
  });

  it('masks a typical 40-char NR license key', () => {
    const key = 'a'.repeat(32) + 'b'.repeat(8);
    const result = maskCredential(key);
    expect(result).toBe('aaaa...bbbb');
    expect(result).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// classifyDashboardStartError() — multi-instance launch, EADDRINUSE handling
// ---------------------------------------------------------------------------

describe('classifyDashboardStartError()', () => {
  it("returns 'skip' with a host:port message when error code is EADDRINUSE", () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const decision = classifyDashboardStartError(err, '127.0.0.1', 7777);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') {
      expect(decision.message).toContain('http://127.0.0.1:7777');
      expect(decision.message).toContain('continuing without dashboard');
    }
  });

  it("returns 'skip' for EADDRINUSE on a non-default host/port", () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const decision = classifyDashboardStartError(err, '127.0.0.1', 9000);
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') {
      expect(decision.message).toContain('http://127.0.0.1:9000');
    }
  });

  it("returns 'rethrow' for non-EADDRINUSE Error objects", () => {
    const err = Object.assign(new Error('some other failure'), { code: 'EACCES' });
    const decision = classifyDashboardStartError(err, '127.0.0.1', 7777);
    expect(decision.kind).toBe('rethrow');
    if (decision.kind === 'rethrow') {
      expect(decision.error).toBe(err);
    }
  });

  it("returns 'rethrow' for errors without a code property", () => {
    const err = new Error('plain error');
    const decision = classifyDashboardStartError(err, '127.0.0.1', 7777);
    expect(decision.kind).toBe('rethrow');
  });

  it("returns 'rethrow' for null and undefined", () => {
    expect(classifyDashboardStartError(null, '127.0.0.1', 7777).kind).toBe('rethrow');
    expect(classifyDashboardStartError(undefined, '127.0.0.1', 7777).kind).toBe('rethrow');
  });

  it("returns 'rethrow' for non-object thrown values (e.g. strings)", () => {
    const decision = classifyDashboardStartError('boom', '127.0.0.1', 7777);
    expect(decision.kind).toBe('rethrow');
    if (decision.kind === 'rethrow') {
      expect(decision.error).toBe('boom');
    }
  });
});

// buildProxyTelemetryCallbacks() — proxy-mode telemetry wiring
// ---------------------------------------------------------------------------

describe('buildProxyTelemetryCallbacks()', () => {
  function makeToolCallRecord(): ProxyToolCallRecord {
    return {
      id: 'call-1',
      sessionId: null,
      toolName: 'search',
      toolUseId: 'use-1',
      timestamp: Date.now(),
      durationMs: 12,
      success: true,
      serverName: 'github',
      upstreamLatencyMs: 8,
    };
  }

  function makeRequestRecord(): ProxyRequestRecord {
    return {
      id: 'req-1',
      serverName: 'github',
      method: 'tools/list',
      timestamp: Date.now(),
      durationMs: 5,
      upstreamLatencyMs: 3,
      success: true,
    };
  }

  it('forwards tool-call records to nrIngest.ingestToolCall when nrIngest is provided', () => {
    const ingestToolCall = jest.fn();
    const ingestProxyRequest = jest.fn();
    const { onToolCall } = buildProxyTelemetryCallbacks({
      ingestToolCall,
      ingestProxyRequest,
    } as unknown as NrIngestManager);

    const record = makeToolCallRecord();
    onToolCall(record);

    expect(ingestToolCall).toHaveBeenCalledTimes(1);
    expect(ingestToolCall).toHaveBeenCalledWith(record);
  });

  it('forwards request records to nrIngest.ingestProxyRequest when nrIngest is provided', () => {
    const ingestToolCall = jest.fn();
    const ingestProxyRequest = jest.fn();
    const { onRequest } = buildProxyTelemetryCallbacks({
      ingestToolCall,
      ingestProxyRequest,
    } as unknown as NrIngestManager);

    const record = makeRequestRecord();
    onRequest(record);

    expect(ingestProxyRequest).toHaveBeenCalledTimes(1);
    expect(ingestProxyRequest).toHaveBeenCalledWith(record);
  });

  it('does not throw when nrIngest is undefined (local-mode proxy)', () => {
    const { onToolCall, onRequest } = buildProxyTelemetryCallbacks(undefined);

    expect(() => onToolCall(makeToolCallRecord())).not.toThrow();
    expect(() => onRequest(makeRequestRecord())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI argument edge cases
// ---------------------------------------------------------------------------

describe('CLI argument edge cases', () => {
  const base = ['node', 'preflight'];

  it('--port=0 throws (zero is not a valid port)', () => {
    expect(() => parseArgs([...base, '--port', '0'])).toThrow(/Invalid port/);
  });

  it('--port=-1 throws (negative port)', () => {
    // Use = form so Commander doesn't interpret -1 as a flag token
    expect(() => parseArgs([...base, '--port=-1'])).toThrow(/Invalid port/);
  });

  it('--port=65536 throws (one above maximum)', () => {
    expect(() => parseArgs([...base, '--port', '65536'])).toThrow(/Invalid port/);
  });

  it('--port=1 is accepted (minimum valid port)', () => {
    const opts = parseArgs([...base, '--port', '1']);
    expect(opts.port).toBe(1);
  });

  it('--port=65535 is accepted (maximum valid port)', () => {
    const opts = parseArgs([...base, '--port', '65535']);
    expect(opts.port).toBe(65535);
  });

  it('--stdio combined with --port is accepted (no conflict in parseArgs)', () => {
    const opts = parseArgs([...base, '--stdio', '--port', '8080']);
    expect(opts.stdio).toBe(true);
    expect(opts.port).toBe(8080);
  });

  it('--config path with spaces is preserved verbatim', () => {
    const opts = parseArgs([...base, '--config', '/path/with spaces/config.json']);
    expect(opts.config).toBe('/path/with spaces/config.json');
  });

  it('--help causes process.exit(0)', () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        throw new Error(`exit:${_code}`);
      });
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(() => parseArgs([...base, '--help'])).toThrow('exit:0');
    } finally {
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('unknown flag causes Commander to exit with code 1', () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        throw new Error(`exit:${_code}`);
      });
    try {
      expect(() => parseArgs([...base, '--totally-unknown-flag'])).toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dashboard ownership re-poll — startDashboardRepoll() +
// setupDashboardPostBind() + getDashboardRepollIntervalMs()
// ---------------------------------------------------------------------------

describe('getDashboardRepollIntervalMs()', () => {
  const ORIGINAL = process.env.NR_AI_DASHBOARD_REPOLL_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.NR_AI_DASHBOARD_REPOLL_MS;
    } else {
      process.env.NR_AI_DASHBOARD_REPOLL_MS = ORIGINAL;
    }
  });

  it('returns DEFAULT_DASHBOARD_REPOLL_MS (30s) when env is unset', () => {
    delete process.env.NR_AI_DASHBOARD_REPOLL_MS;
    expect(getDashboardRepollIntervalMs()).toBe(DEFAULT_DASHBOARD_REPOLL_MS);
    expect(DEFAULT_DASHBOARD_REPOLL_MS).toBe(30_000);
  });

  it('parses a numeric override from NR_AI_DASHBOARD_REPOLL_MS', () => {
    process.env.NR_AI_DASHBOARD_REPOLL_MS = '50';
    expect(getDashboardRepollIntervalMs()).toBe(50);
  });

  it('falls back to default for non-numeric / non-positive overrides', () => {
    process.env.NR_AI_DASHBOARD_REPOLL_MS = 'abc';
    expect(getDashboardRepollIntervalMs()).toBe(DEFAULT_DASHBOARD_REPOLL_MS);
    process.env.NR_AI_DASHBOARD_REPOLL_MS = '0';
    expect(getDashboardRepollIntervalMs()).toBe(DEFAULT_DASHBOARD_REPOLL_MS);
    process.env.NR_AI_DASHBOARD_REPOLL_MS = '-100';
    expect(getDashboardRepollIntervalMs()).toBe(DEFAULT_DASHBOARD_REPOLL_MS);
  });
});

describe('getSessionPersistIntervalMs()', () => {
  const ORIGINAL = process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS;
    } else {
      process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS = ORIGINAL;
    }
  });

  it('returns DEFAULT_SESSION_PERSIST_INTERVAL_MS (30s) when env is unset', () => {
    delete process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS;
    expect(getSessionPersistIntervalMs()).toBe(DEFAULT_SESSION_PERSIST_INTERVAL_MS);
    expect(DEFAULT_SESSION_PERSIST_INTERVAL_MS).toBe(30_000);
  });

  it('parses a numeric override from NR_AI_SESSION_PERSIST_INTERVAL_MS', () => {
    process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS = '50';
    expect(getSessionPersistIntervalMs()).toBe(50);
  });

  it('falls back to default for non-numeric / non-positive overrides', () => {
    process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS = 'abc';
    expect(getSessionPersistIntervalMs()).toBe(DEFAULT_SESSION_PERSIST_INTERVAL_MS);
    process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS = '0';
    expect(getSessionPersistIntervalMs()).toBe(DEFAULT_SESSION_PERSIST_INTERVAL_MS);
    process.env.NR_AI_SESSION_PERSIST_INTERVAL_MS = '-100';
    expect(getSessionPersistIntervalMs()).toBe(DEFAULT_SESSION_PERSIST_INTERVAL_MS);
  });
});

describe('getPendingConfirmationCapMs()', () => {
  const ORIGINAL = process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS;
    } else {
      process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS = ORIGINAL;
    }
  });

  it('returns DEFAULT_PENDING_CONFIRMATION_CAP_MS (2 minutes) when env is unset', () => {
    delete process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS;
    expect(getPendingConfirmationCapMs()).toBe(DEFAULT_PENDING_CONFIRMATION_CAP_MS);
    expect(DEFAULT_PENDING_CONFIRMATION_CAP_MS).toBe(120_000);
  });

  it('parses a numeric override from NR_AI_PENDING_CONFIRMATION_CAP_MS', () => {
    process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS = '50';
    expect(getPendingConfirmationCapMs()).toBe(50);
  });

  it('falls back to default for non-numeric / non-positive overrides', () => {
    process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS = 'abc';
    expect(getPendingConfirmationCapMs()).toBe(DEFAULT_PENDING_CONFIRMATION_CAP_MS);
    process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS = '0';
    expect(getPendingConfirmationCapMs()).toBe(DEFAULT_PENDING_CONFIRMATION_CAP_MS);
    process.env.NR_AI_PENDING_CONFIRMATION_CAP_MS = '-100';
    expect(getPendingConfirmationCapMs()).toBe(DEFAULT_PENDING_CONFIRMATION_CAP_MS);
  });
});

describe('setupDashboardPostBind()', () => {
  function makeLocalStore(): {
    store: LocalStore;
    writeLocalDashboardPid: ReturnType<typeof jest.fn>;
  } {
    const writeLocalDashboardPid = jest.fn();
    const store = { writeLocalDashboardPid } as unknown as LocalStore;
    return { store, writeLocalDashboardPid };
  }

  it('writes the local-dashboard pid file when isLocalMode is true', () => {
    const { store, writeLocalDashboardPid } = makeLocalStore();
    setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, openOnStart: false, isLocalMode: true },
    );
    expect(writeLocalDashboardPid).toHaveBeenCalledWith(process.argv.slice(1), process.cwd());
  });

  it('does not write the local-dashboard pid file when isLocalMode is false (--stdio)', () => {
    const { store, writeLocalDashboardPid } = makeLocalStore();
    setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, openOnStart: false, isLocalMode: false },
    );
    expect(writeLocalDashboardPid).not.toHaveBeenCalled();
  });

  it('warns that openOnStart is not implemented when set', () => {
    const { store } = makeLocalStore();
    setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, openOnStart: true, isLocalMode: false },
    );
    const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged.some((l: string) => l.includes('openOnStart is not implemented'))).toBe(true);
  });
});

describe('startMaintenanceGc()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeLocalStore(): {
    store: LocalStore;
    gcStaleBreadcrumbs: ReturnType<typeof jest.fn>;
    gcOrphanBuffers: ReturnType<typeof jest.fn>;
    getActiveSessionIdsFromHeartbeats: ReturnType<typeof jest.fn>;
    gcDeadLocalInstances: ReturnType<typeof jest.fn>;
    gcCountedToolUseIds: ReturnType<typeof jest.fn>;
  } {
    const gcStaleBreadcrumbs = jest.fn();
    const gcOrphanBuffers = jest.fn();
    const getActiveSessionIdsFromHeartbeats = jest.fn(() => new Set<string>());
    const gcDeadLocalInstances = jest.fn(() => 0);
    const gcCountedToolUseIds = jest.fn();
    const store = {
      gcCountedToolUseIds,
      gcStaleBreadcrumbs,
      gcOrphanBuffers,
      getActiveSessionIdsFromHeartbeats,
      gcDeadLocalInstances,
    } as unknown as LocalStore;
    return {
      store,
      gcStaleBreadcrumbs,
      gcOrphanBuffers,
      getActiveSessionIdsFromHeartbeats,
      gcDeadLocalInstances,
      gcCountedToolUseIds,
    };
  }

  it('runs a GC pass immediately and returns an unref-able interval', () => {
    const { store, gcStaleBreadcrumbs, gcOrphanBuffers } = makeLocalStore();
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry: undefined });
    expect(gcStaleBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(gcOrphanBuffers).toHaveBeenCalledTimes(1);
    expect(typeof handle.unref).toBe('function');
    clearInterval(handle);
  });

  it('schedules subsequent GC passes on the 5-minute interval', () => {
    const { store, gcStaleBreadcrumbs } = makeLocalStore();
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry: undefined });
    expect(gcStaleBreadcrumbs).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(gcStaleBreadcrumbs).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(gcStaleBreadcrumbs).toHaveBeenCalledTimes(3);
    clearInterval(handle);
  });

  it('merges live session ids from registry into the GC live-set', () => {
    const { store, gcOrphanBuffers, getActiveSessionIdsFromHeartbeats } = makeLocalStore();
    getActiveSessionIdsFromHeartbeats.mockReturnValue(new Set(['heartbeat-only']));
    const liveSessionRegistry = {
      getLiveSessions: jest.fn(() => new Set(['registry-only'])),
      getTodaySessionIds: jest.fn(() => []),
    } as unknown as Parameters<typeof startMaintenanceGc>[0]['liveSessionRegistry'];
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry });
    const liveArg = gcOrphanBuffers.mock.calls[0]?.[0] as Set<string>;
    expect(liveArg.has('heartbeat-only')).toBe(true);
    expect(liveArg.has('registry-only')).toBe(true);
    clearInterval(handle);
  });

  it('requests synthetic session ids from the registry so their buffers survive GC', () => {
    // getLiveSessions() now defaults to filtering out local-*/proxy-*/pending-
    // ids for dashboard display, but the orphan-buffer GC pass must keep
    // seeing every live session — including synthetic ones still mid-flight
    // in --local / proxy mode — or it would delete their active buffer files.
    const { store, gcOrphanBuffers } = makeLocalStore();
    const getLiveSessions = jest.fn(
      (_options?: { includeSynthetic?: boolean }) => new Set(['proxy-1234567890']),
    );
    const liveSessionRegistry = {
      getLiveSessions,
      getTodaySessionIds: jest.fn(() => []),
    } as unknown as Parameters<typeof startMaintenanceGc>[0]['liveSessionRegistry'];
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry });
    expect(getLiveSessions).toHaveBeenCalledWith({ includeSynthetic: true });
    const liveArg = gcOrphanBuffers.mock.calls[0]?.[0] as Set<string>;
    expect(liveArg.has('proxy-1234567890')).toBe(true);
    clearInterval(handle);
  });

  it("merges today-seen session ids from the registry into the GC live-set, so an idle-but-open window is not GC'd as orphaned", () => {
    const { store, gcOrphanBuffers } = makeLocalStore();
    const liveSessionRegistry = {
      getLiveSessions: jest.fn(() => []),
      getTodaySessionIds: jest.fn((_options?: { includeSynthetic?: boolean }) => [
        'idle-but-open-today',
      ]),
    } as unknown as Parameters<typeof startMaintenanceGc>[0]['liveSessionRegistry'];
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry });
    expect(liveSessionRegistry?.getTodaySessionIds).toHaveBeenCalledWith({
      includeSynthetic: true,
    });
    const liveArg = gcOrphanBuffers.mock.calls[0]?.[0] as Set<string>;
    expect(liveArg.has('idle-but-open-today')).toBe(true);
    clearInterval(handle);
  });

  it('runs gcDeadLocalInstances and gcCountedToolUseIds as part of the GC pass', () => {
    const { store, gcDeadLocalInstances, gcCountedToolUseIds } = makeLocalStore();
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry: undefined });
    expect(gcDeadLocalInstances).toHaveBeenCalledTimes(1);
    expect(gcCountedToolUseIds).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(gcDeadLocalInstances).toHaveBeenCalledTimes(2);
    clearInterval(handle);
  });
});

describe('startRetentionSweep()', () => {
  let storagePath: string;

  beforeEach(() => {
    jest.useFakeTimers();
    storagePath = mkdtempSync(join(tmpdir(), 'nr-retention-sweep-'));
    mkdirSync(resolve(storagePath, 'sessions'), { recursive: true });
    mkdirSync(resolve(storagePath, 'weekly_summaries'), { recursive: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    rmSync(storagePath, { recursive: true, force: true });
  });

  function writeOldFile(subdir: string, name: string): string {
    const path = resolve(storagePath, subdir, name);
    writeFileSync(path, '{}', { mode: 0o600 });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(path, oldDate, oldDate);
    return path;
  }

  it('returns null and schedules nothing when retainSessionsDays is null', () => {
    const handle = startRetentionSweep({ storagePath, retainSessionsDays: null });
    expect(handle).toBeNull();
  });

  it('purges old session and weekly-summary files immediately on start', () => {
    const oldSession = writeOldFile('sessions', '2026-01-01_old.json');
    const oldSummary = writeOldFile('weekly_summaries', '2026-W01.json');

    const handle = startRetentionSweep({ storagePath, retainSessionsDays: 90 });

    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(oldSummary)).toBe(false);
    expect(typeof (handle as NodeJS.Timeout).unref).toBe('function');
    clearInterval(handle as NodeJS.Timeout);
  });

  it('prunes billed-turn ledger generations older than the retention window and keeps the current one', () => {
    const ledgerDir = resolve(storagePath, 'billed-turns');
    mkdirSync(ledgerDir, { recursive: true });
    const currentGeneration = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const oldLedger = resolve(ledgerDir, 'g1-0.jsonl');
    const currentLedger = resolve(ledgerDir, `g${currentGeneration}-0.jsonl`);
    writeFileSync(oldLedger, '', { mode: 0o600 });
    writeFileSync(currentLedger, '', { mode: 0o600 });

    const handle = startRetentionSweep({ storagePath, retainSessionsDays: 90 });

    expect(existsSync(oldLedger)).toBe(false);
    expect(existsSync(currentLedger)).toBe(true);
    clearInterval(handle as NodeJS.Timeout);
  });

  it('re-runs the sweep every 6 hours', () => {
    const handle = startRetentionSweep({ storagePath, retainSessionsDays: 90 });

    const secondOldSession = writeOldFile('sessions', '2026-01-02_old2.json');
    jest.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(existsSync(secondOldSession)).toBe(false);

    clearInterval(handle as NodeJS.Timeout);
  });
});

describe('startDashboardRepoll()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeServer(start: () => Promise<{ address: string; port: number }>): DashboardServer {
    return { start } as unknown as DashboardServer;
  }

  function silentLogger(): NonNullable<Parameters<typeof startDashboardRepoll>[0]['logger']> {
    return {
      info: jest.fn() as (msg: string, meta?: Record<string, unknown>) => void,
      warn: jest.fn() as (msg: string, meta?: Record<string, unknown>) => void,
    };
  }

  it('returns an unref-able interval when scheduled', () => {
    const server = makeServer(() =>
      Promise.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })),
    );
    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: () => setInterval(() => undefined, 10_000),
      logger: silentLogger(),
    });
    expect(typeof (handle as NodeJS.Timeout).unref).toBe('function');
    clearInterval(handle);
  });

  it('on takeover success: clears the interval, runs postBind', async () => {
    const start = jest.fn(() => Promise.resolve({ address: '127.0.0.1', port: 7777 }));
    const server = makeServer(start);
    const postBind = jest.fn((_addr: { address: string; port: number }) => undefined);
    const log = silentLogger();

    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: postBind as Parameters<typeof startDashboardRepoll>[0]['postBind'],
      logger: log,
    });

    // Drive the timer once and let the awaited start() resolve.
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(postBind).toHaveBeenCalledWith({ address: '127.0.0.1', port: 7777 });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('taken over'));

    // After takeover the interval should be cleared — advance time and
    // confirm start() is NOT called a second time.
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    clearInterval(handle);
  });

  it('keeps polling silently when the port is still EADDRINUSE', async () => {
    const start = jest.fn(() =>
      Promise.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })),
    );
    const server = makeServer(start);
    const postBind = jest.fn((_addr: { address: string; port: number }) =>
      setInterval(() => undefined, 10_000),
    );
    const log = silentLogger();

    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: postBind as Parameters<typeof startDashboardRepoll>[0]['postBind'],
      logger: log,
    });

    // Tick three times — every attempt fails with EADDRINUSE, postBind is
    // never called, and the warn channel stays quiet (we only log at info
    // for the takeover; EADDRINUSE retries are silent by design).
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(start.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(postBind).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();

    clearInterval(handle);
  });

  it('stops polling and warns once when start() fails with a non-EADDRINUSE error', async () => {
    const start = jest.fn(() =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    );
    const server = makeServer(start);
    const postBind = jest.fn((_addr: { address: string; port: number }) =>
      setInterval(() => undefined, 10_000),
    );
    const log = silentLogger();

    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: postBind as Parameters<typeof startDashboardRepoll>[0]['postBind'],
      logger: log,
    });

    jest.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dashboard re-poll stopped'),
      expect.any(Object),
    );

    // The interval should have been cleared internally — extra ticks
    // should not increment the call count.
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    clearInterval(handle);
  });

  it('clearInterval on the returned handle prevents further attempts (shutdown path)', async () => {
    const start = jest.fn(() =>
      Promise.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })),
    );
    const server = makeServer(start);
    const log = silentLogger();
    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: () => setInterval(() => undefined, 10_000),
      logger: log,
    });

    // Simulate shutdown calling clearInterval(handle) before any tick.
    clearInterval(handle);
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });
});

const PLATFORM_SIGNAL_ENV_RE =
  /^(CLAUDE|CURSOR_|WINDSURF_|ZED_|CONTINUE_|KIRO_|AMAZON_Q_|Q_DEVELOPER_|AWS_CODEWHISPERER_|PI_CODING_AGENT$|MCP_CLIENT|NEW_RELIC_AI_PLATFORM$)/;

function envWithoutTerminalPlatform(platformEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !PLATFORM_SIGNAL_ENV_RE.test(name)),
  );
  return { ...env, NEW_RELIC_AI_COPILOT_DIR: join(tmpdir(), 'nr-no-copilot-app'), ...platformEnv };
}

describe('stdio integration', () => {
  /**
   * Connects and waits for the engine's configured tool set. The engine answers
   * the handshake before its trackers exist, and until they do its tools return
   * errors or refusals, so a call made that early reads no real value.
   */
  async function connectToConfiguredEngine(
    client: Client,
    transport: Parameters<Client['connect']>[0],
  ): Promise<void> {
    await client.connect(transport);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { tools } = await client.listTools();
      if (tools.some((tool) => tool.name === 'nr_observe_get_config')) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('engine never registered its configured tools');
  }

  it('responds to MCP initialize handshake and lists tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');

    // Provide a synthetic CLAUDE_JOB_DIR so resolveFromJobDir() resolves
    // synchronously and all tools are registered before listTools() is called.
    const tmpJobDir = mkdtempSync(join(tmpdir(), 'nr-stdio-job-'));
    writeFileSync(
      resolve(tmpJobDir, 'state.json'),
      JSON.stringify({ linkScanPath: '/tmp/stdio-test-session.jsonl' }),
    );

    // Isolate storage to a temp directory to prevent GC operations from
    // affecting the real ~/.newrelic-preflight storage.
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-stdio-storage-'));

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      // NR_AI_DASHBOARD_PORT=0 → OS-assigned ephemeral, so this test is
      // safe to run when port 7777 is occupied (e.g. a developer running
      // their production instance on the same host).
      // NR_AI_MODE=local → skip licenseKey validation so the test runs
      // without a real NR config file present.
      env: {
        ...envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' }),
        NR_AI_DASHBOARD_PORT: '0',
        CLAUDE_JOB_DIR: tmpJobDir,
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe('preflight');

      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain('nr_observe_get_session_stats');
      expect(toolNames).toContain('nr_observe_get_session_timeline');
      expect(toolNames).toContain('nr_observe_report_tokens');

      await client.close();
    } finally {
      rmSync(tmpJobDir, { recursive: true, force: true });
      rmSync(tmpStoragePath, { recursive: true, force: true });
    }
  }, 30000);

  it('resolves session_id synchronously from the cwd breadcrumb when no CLAUDE_JOB_DIR or PPID breadcrumb is available', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { resolveFromCwd } = await import('./hooks/session-resolver.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-cwd-sync-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-cwd-sync-project-'));
    // The spawned child's process.cwd() returns the *canonicalized* path
    // (e.g. macOS resolves /var/folders/... to /private/var/folders/...) —
    // resolve that here too so the breadcrumb filename matches what the
    // child's own resolveFromCwd() call derives, not the raw temp path.
    const realProjectCwd = realpathSync(tmpProjectCwd);

    // Pre-write a cwd breadcrumb (as the hook collector would, via
    // writeCwdBreadcrumb()) for the spawned MCP's own working directory —
    // this is the platform-independent equivalent of "native Windows, where
    // the PPID breadcrumb never matches, but the cwd one does". Deliberately
    // omit CLAUDE_JOB_DIR and any PPID breadcrumb so only the cwd fallback in
    // the *synchronous* resolution chain can succeed.
    const breadcrumbDir = resolve(breadcrumbRoot(tmpStoragePath, 'claude-code'), 'session-by-cwd');
    mkdirSync(breadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(breadcrumbDir, `${sanitizedCwd}.txt`), 'resolved-via-cwd-session-id');

    // Sanity check against the real resolver so this test fails loudly (not
    // mysteriously) if the sanitization scheme ever drifts between the
    // collector's write side and resolveFromCwd()'s read side.
    expect(resolveFromCwd(breadcrumbRoot(tmpStoragePath, 'claude-code'), realProjectCwd)).toBe(
      'resolved-via-cwd-session-id',
    );

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      // The cwd fallback resolved synchronously, so the configured tool set is
      // the full one, with no pending-tools window to poll through.
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain('nr_observe_get_session_stats');

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  describe("an engine adopts only its own hooks' session breadcrumbs", () => {
    async function startEngine(platformEnv: Record<string, string>) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const storagePath = mkdtempSync(join(tmpdir(), 'nr-engine-writer-storage-'));
      const projectCwd = mkdtempSync(join(tmpdir(), 'nr-engine-writer-project-'));
      const sanitizedCwd = sanitizeCwdForFilename(realpathSync(projectCwd));
      const writeCrumb = (writer: string | null, kind: 'ppid' | 'cwd', sessionId: string) => {
        const root = writer === null ? storagePath : breadcrumbRoot(storagePath, writer);
        const dir = resolve(root, `session-by-${kind}`);
        mkdirSync(dir, { recursive: true });
        const key = kind === 'ppid' ? String(process.pid) : sanitizedCwd;
        writeFileSync(resolve(dir, `${key}.txt`), sessionId);
      };
      const transport = new StdioClientTransport({
        command: 'node',
        args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio'],
        cwd: projectCwd,
        stderr: 'pipe',
        env: {
          ...envWithoutTerminalPlatform(platformEnv),
          NR_AI_DASHBOARD_PORT: '0',
          NR_AI_MODE: 'local',
          NEW_RELIC_AI_MCP_STORAGE_PATH: storagePath,
        },
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const stats = async (): Promise<{
        session_id: string;
        session_name: string | null;
      } | null> => {
        const { tools } = await client.listTools();
        if (!tools.some((t) => t.name === 'nr_observe_get_session_stats')) return null;
        const result = await client.callTool({
          name: 'nr_observe_get_session_stats',
          arguments: {},
        });
        const content = result.content as Array<{ type: string; text: string }>;
        return JSON.parse(content[0]?.text ?? '{}');
      };
      const sessionId = async (): Promise<string | null> => (await stats())?.session_id ?? null;
      const waitForSessionId = async (expected: string): Promise<string | null> => {
        let seen: string | null = null;
        for (let i = 0; i < 40 && seen !== expected; i++) {
          await new Promise((r) => setTimeout(r, 250));
          seen = await sessionId();
        }
        return seen;
      };
      return {
        writeCrumb,
        stats,
        sessionId,
        waitForSessionId,
        stderr: () => stderr,
        connect: () => client.connect(transport),
        close: async () => {
          await client.close();
          rmSync(storagePath, { recursive: true, force: true });
          rmSync(projectCwd, { recursive: true, force: true });
        },
      };
    }

    const pastSeveralPollTicks = () => new Promise((r) => setTimeout(r, 1500));

    it("leaves a Cursor engine unresolved and unpolled beside a Claude Code session's breadcrumbs", async () => {
      const engine = await startEngine({ MCP_CLIENT: 'cursor' });
      try {
        engine.writeCrumb('claude-code', 'cwd', 'claude-session-id');
        engine.writeCrumb(null, 'cwd', 'claude-session-id');
        await engine.connect();
        engine.writeCrumb('claude-code', 'ppid', 'claude-session-id');
        engine.writeCrumb(null, 'ppid', 'claude-session-id');
        await pastSeveralPollTicks();
        expect(await engine.sessionId()).toBeNull();
        expect(engine.stderr()).not.toContain('breadcrumb poll');
      } finally {
        await engine.close();
      }
    }, 30000);

    it("keeps a Kiro engine off a Claude Code session's breadcrumbs until its own hooks write one", async () => {
      const engine = await startEngine({ MCP_CLIENT: 'kiro' });
      try {
        engine.writeCrumb('claude-code', 'cwd', 'claude-session-id');
        await engine.connect();
        engine.writeCrumb('claude-code', 'ppid', 'claude-session-id');
        await pastSeveralPollTicks();
        expect(await engine.sessionId()).toBeNull();
        engine.writeCrumb('kiro', 'ppid', 'kiro-session-id');
        expect(await engine.waitForSessionId('kiro-session-id')).toBe('kiro-session-id');
      } finally {
        await engine.close();
      }
    }, 30000);

    it.each([
      [{ MCP_CLIENT: 'claude-code' }, 'claude-session-id', 'claude job name'],
      [{ MCP_CLIENT: 'kiro' }, 'kiro-session-id', null],
    ])(
      "names a %j engine from an inherited Claude job's state only when it is Claude Code",
      async (platformEnv, expectedId, expectedJobName) => {
        const jobDir = mkdtempSync(join(tmpdir(), 'nr-engine-writer-job-'));
        writeFileSync(
          resolve(jobDir, 'state.json'),
          JSON.stringify({
            linkScanPath: '/tmp/claude-session-id.jsonl',
            name: 'claude job name',
            nameSource: 'user',
          }),
        );
        const engine = await startEngine({ ...platformEnv, CLAUDE_JOB_DIR: jobDir });
        try {
          engine.writeCrumb('kiro', 'cwd', 'kiro-session-id');
          await engine.connect();
          const stats = await engine.stats();
          expect(stats?.session_id).toBe(expectedId);
          if (expectedJobName) expect(stats?.session_name).toBe(expectedJobName);
          else {
            let name = stats?.session_name ?? null;
            for (let i = 0; i < 40 && name === null; i++) {
              await new Promise((r) => setTimeout(r, 250));
              name = (await engine.stats())?.session_name ?? null;
            }
            expect(name).not.toBeNull();
            expect(name).not.toBe('claude job name');
          }
        } finally {
          await engine.close();
          rmSync(jobDir, { recursive: true, force: true });
        }
      },
      30000,
    );

    it("keeps Claude Code run from Cursor's terminal off a Kiro session, then adopts its own", async () => {
      const engine = await startEngine({ CLAUDECODE: '1', CURSOR_TRACE_ID: 'cursor-terminal' });
      try {
        engine.writeCrumb('kiro', 'cwd', 'kiro-session-id');
        await engine.connect();
        engine.writeCrumb('kiro', 'ppid', 'kiro-session-id');
        await pastSeveralPollTicks();
        expect(await engine.sessionId()).toBeNull();
        engine.writeCrumb('claude-code', 'ppid', 'claude-session-id');
        expect(await engine.waitForSessionId('claude-session-id')).toBe('claude-session-id');
      } finally {
        await engine.close();
      }
    }, 30000);
  });

  it('self-corrects a synchronously-resolved cwd session id once the real PPID breadcrumb appears', async () => {
    // A stale cwd breadcrumb (leftover from an unrelated prior session in
    // the same directory) can win the synchronous resolution race at
    // startup; it must self-correct once the real, precise ppid breadcrumb
    // shows up moments later.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-cwd-correction-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-cwd-correction-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    // Pre-write only a cwd breadcrumb — deliberately a value that looks
    // like it belongs to a different, unrelated session — and no
    // CLAUDE_JOB_DIR or ppid breadcrumb, so only the synchronous cwd
    // fallback can resolve at startup.
    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-cwd-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      // The full tool set confirms this is the synchronous cwd entry point
      // (isProvisional === false), not the pending/async one.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('nr_observe_get_session_stats');

      const readSessionId = async (): Promise<string> => {
        const result = await client.callTool({
          name: 'nr_observe_get_session_stats',
          arguments: {},
        });
        const content = result.content as Array<{ type: string; text: string }>;
        const text = content[0]?.text ?? '{}';
        return (JSON.parse(text) as { session_id: string }).session_id;
      };

      // Confirms the stale cwd value really was adopted before correction.
      expect(await readSessionId()).toBe('stale-cwd-session-id');

      // The spawned child sees this test process as its ppid, matching
      // resolveSessionId()'s default `options.ppid ?? process.ppid` inside
      // the child — same convention as the existing pending-tools test.
      const ppidBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(resolve(ppidBreadcrumbDir, `${process.pid}.txt`), 'corrected-ppid-session-id');

      let corrected = false;
      for (let i = 0; i < 20; i++) {
        if ((await readSessionId()) === 'corrected-ppid-session-id') {
          corrected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(corrected).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('serves the pending tool set immediately when session_id cannot resolve synchronously, then swaps to the full set once the breadcrumb resolves', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-provisional-storage-'));

    // Deliberately omit CLAUDE_JOB_DIR and pre-write no breadcrumb, so neither
    // resolveFromJobDir() nor resolveFromBreadcrumb() can resolve synchronously
    // at startup — main() falls back to the provisional `pending-<ts>` session
    // id and registers the pending tool set (registerPendingTools) immediately.
    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await client.connect(transport);

      const pendingTools = await client.listTools();
      const pendingNames = pendingTools.tools.map((t) => t.name);
      expect(pendingNames).toContain('nr_observe_health');
      expect(pendingNames).toContain('nr_observe_install_hooks');
      expect(pendingNames).not.toContain('nr_observe_get_session_stats');

      // Supply the breadcrumb asynchronously. The spawned child sees this
      // test process as its ppid (direct child_process.spawn), so
      // resolveFromBreadcrumb() looks for <storagePath>/session-by-ppid/<our
      // own process.pid>.txt — matching resolveSessionId()'s default
      // `options.ppid ?? process.ppid` inside the child.
      const breadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(breadcrumbDir, { recursive: true });
      writeFileSync(resolve(breadcrumbDir, `${process.pid}.txt`), 'resolved-real-session-id');

      // Poll listTools() until the full tool set (registerTools) replaces the
      // pending one — resolution happens on resolveSessionId()'s backoff
      // schedule (100/200/500/1000/2000ms, then steady 2s).
      let sawFullSet = false;
      for (let i = 0; i < 20; i++) {
        const result = await client.listTools();
        if (result.tools.map((t) => t.name).includes('nr_observe_get_session_stats')) {
          sawFullSet = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(sawFullSet).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
    }
  }, 30000);

  it.each([
    {
      title: 'saves a call still running at shutdown before it marks the call counted',
      sessionsMode: 0o700,
      toolCallCounts: [1],
      countedFiles: ['["toolu_running"]'],
    },
    {
      title: 'does not mark a call counted when its session could not be saved',
      sessionsMode: 0o500,
      toolCallCounts: [],
      countedFiles: [],
    },
  ])(
    '$title',
    async ({ sessionsMode, toolCallCounts, countedFiles }) => {
      if (sessionsMode === 0o500 && process.getuid?.() === 0) return; // root ignores the mode
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const storage = mkdtempSync(join(tmpdir(), 'nr-shutdown-in-flight-'));
      const ownId = 'own-real-session';
      const buffer = resolve(storage, `buffer-${ownId}.jsonl`);
      const heartbeat = resolve(storage, `active-${ownId}.pid`);
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        for (let i = 0; i < 40 && !predicate(); i++) await new Promise((r) => setTimeout(r, 250));
        expect(predicate()).toBe(true);
      };
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
      delete env.CLAUDE_JOB_DIR;
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const sessions = resolve(storage, 'sessions');
      mkdirSync(sessions, { mode: sessionsMode });
      try {
        await client.connect(
          new StdioClientTransport({
            command: 'node',
            args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio'],
            env: {
              ...env,
              NR_AI_DASHBOARD_PORT: '0',
              NR_AI_MODE: 'local',
              NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
            },
          }),
        );
        mkdirSync(resolve(storage, 'session-by-ppid'), { recursive: true });
        writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), ownId);
        await waitFor(() => existsSync(heartbeat));
        const pre = { mode: 'pre', tool: 'Read', timestamp: Date.now(), sessionId: ownId };
        writeFileSync(buffer, JSON.stringify({ ...pre, toolUseId: 'toolu_running' }) + '\n');
        await waitFor(() => !existsSync(buffer));
        await client.close();
        await waitFor(() => !existsSync(heartbeat));

        const saved = readdirSync(sessions).map((f) => readFileSync(resolve(sessions, f), 'utf-8'));
        expect(
          saved.map((json) => (JSON.parse(json) as { toolCallCount: number }).toolCallCount),
        ).toEqual(toolCallCounts);
        const counted = resolve(storage, 'counted');
        const files = existsSync(counted) ? readdirSync(counted) : [];
        expect(files.map((f) => readFileSync(resolve(counted, f), 'utf-8'))).toEqual(countedFiles);
      } finally {
        chmodSync(sessions, 0o700);
        rmSync(storage, { recursive: true, force: true });
      }
    },
    30000,
  );

  it('amends a timed-out call in the saved session when its post arrives late', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const storage = mkdtempSync(join(tmpdir(), 'nr-late-post-'));
    const ownId = 'own-real-session';
    const buffer = resolve(storage, `buffer-${ownId}.jsonl`);
    const heartbeat = resolve(storage, `active-${ownId}.pid`);
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 40 && !predicate(); i++) await new Promise((r) => setTimeout(r, 250));
      expect(predicate()).toBe(true);
    };
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
    delete env.CLAUDE_JOB_DIR;
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: 'node',
          args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio'],
          env: {
            ...env,
            NR_AI_DASHBOARD_PORT: '0',
            NR_AI_MODE: 'local',
            NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
          },
        }),
      );
      mkdirSync(resolve(storage, 'session-by-ppid'), { recursive: true });
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), ownId);
      await waitFor(() => existsSync(heartbeat));
      const call = { tool: 'Read', sessionId: ownId, toolUseId: 'toolu_late' };
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      writeFileSync(
        buffer,
        JSON.stringify({ ...call, mode: 'pre', timestamp: twoHoursAgo }) + '\n',
      );
      await waitFor(() => !existsSync(buffer));
      writeFileSync(
        buffer,
        JSON.stringify({ ...call, mode: 'post', timestamp: Date.now() }) + '\n',
      );
      await waitFor(() => !existsSync(buffer));
      await client.close();
      await waitFor(() => !existsSync(heartbeat));

      const sessions = resolve(storage, 'sessions');
      expect(
        readdirSync(sessions).map((f) => {
          const saved = JSON.parse(readFileSync(resolve(sessions, f), 'utf-8')) as {
            toolCallCount: number;
            toolSuccessRate: number;
          };
          return [saved.toolCallCount, saved.toolSuccessRate];
        }),
      ).toEqual([[1, 1]]);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  }, 30000);

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 40 && !predicate(); i++) await new Promise((r) => setTimeout(r, 250));
    expect(predicate()).toBe(true);
  };
  const savedField = (storage: string, id: string, field: string): unknown => {
    const dir = resolve(storage, 'sessions');
    const name = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`_${id}.json`)) : '';
    return name ? JSON.parse(readFileSync(resolve(dir, name), 'utf-8'))[field] : null;
  };
  const savedCalls = (storage: string, id: string): unknown =>
    savedField(storage, id, 'toolCallCount');

  describe('an engine that adopts its session after draining others', () => {
    const storages: string[] = [];
    afterEach(() => {
      for (const dir of storages.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const CHECKPOINT_OFTEN = { NR_AI_SESSION_PERSIST_INTERVAL_MS: '200' };
    const makeStorage = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'nr-adopt-'));
      storages.push(dir);
      mkdirSync(resolve(dir, 'session-by-ppid'), { recursive: true });
      return dir;
    };
    const startEngine = async (storage: string, cwd?: string, envOverrides = {}) => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
      delete env.CLAUDE_JOB_DIR;
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await connectToConfiguredEngine(
        client,
        new StdioClientTransport({
          command: 'node',
          args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio'],
          ...(cwd !== undefined && { cwd }),
          env: {
            ...env,
            NR_AI_DASHBOARD_PORT: '0',
            NR_AI_MODE: 'local',
            NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
            ...envOverrides,
          },
        }),
      );
      return client;
    };
    const drainCalls = async (storage: string, sessionId: string, count: number) => {
      const buffer = resolve(storage, `buffer-${sessionId}.jsonl`);
      const lines = Array.from({ length: count }, (_, n) => {
        const call = {
          tool: 'Read',
          timestamp: Date.now() + n,
          sessionId,
          toolUseId: `toolu_${n}`,
        };
        return [
          { mode: 'pre', ...call },
          { mode: 'post', ...call, success: true },
        ];
      });
      for (const event of lines.flat()) appendToHookBuffer(buffer, JSON.stringify(event) + '\n');
      await waitFor(() => !existsSync(buffer));
    };
    const adoptAndStop = async (
      storage: string,
      client: { close(): Promise<void> },
      id: string,
    ) => {
      const heartbeat = resolve(storage, `active-${id}.pid`);
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), id);
      await waitFor(() => existsSync(heartbeat));
      await client.close();
      await waitFor(() => !existsSync(heartbeat));
    };

    it('saves a call drained for another session under that session, not its own', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage);
      await drainCalls(storage, 'other-real-session', 1);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'other-real-session')).toBe(1);
      expect(savedCalls(storage, 'own-real-session') ?? 0).toBe(0);
    }, 30000);

    it('counts its own calls once when it saved them before adopting their session', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage, undefined, CHECKPOINT_OFTEN);
      await drainCalls(storage, 'own-real-session', 2);
      await waitFor(() => savedCalls(storage, 'own-real-session') === 2);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'own-real-session')).toBe(2);
    }, 30000);

    const guessFromCwd = (storage: string, cwd: string): void => {
      const crumbs = resolve(breadcrumbRoot(storage, 'claude-code'), 'session-by-cwd');
      mkdirSync(crumbs, { recursive: true });
      const breadcrumb = `${realpathSync(cwd).replace(/[\\/:]/g, '-')}.txt`;
      writeFileSync(resolve(crumbs, breadcrumb), 'guessed-session');
    };
    const makeCwd = (): string => {
      const cwd = mkdtempSync(join(tmpdir(), 'nr-adopt-cwd-'));
      storages.push(cwd);
      return cwd;
    };

    it("saves the guessed session's calls when the ppid breadcrumb corrects the guess", async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const client = await startEngine(storage, cwd);
      await drainCalls(storage, 'guessed-session', 1);
      await adoptAndStop(storage, client, 'corrected-session');

      expect(savedCalls(storage, 'guessed-session')).toBe(1);
      expect(savedCalls(storage, 'corrected-session') ?? 0).toBe(0);
    }, 30000);

    // Writes token events until `adopted` holds, so the store swap's final drain reaches some.
    const writeTokensUntil = async (
      storage: string,
      buffer: string,
      sessionId: string,
      adopted: () => boolean,
    ) => {
      let n = 0;
      const writer = setInterval(() => {
        const token = { mode: 'token', timestamp: Date.now(), sessionId, messageId: `msg_${n++}` };
        appendToHookBuffer(
          resolve(storage, `buffer-${buffer}.jsonl`),
          JSON.stringify({
            ...token,
            inputTokens: 1000,
            outputTokens: 100,
            model: 'claude-sonnet-5',
          }) + '\n',
        );
      }, 2);
      try {
        await waitFor(adopted);
      } finally {
        clearInterval(writer);
      }
    };

    it("keeps the guessed session's tokens out of the corrected session's cost", async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const client = await startEngine(storage, cwd);
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), 'corrected-session');
      const heartbeat = resolve(storage, 'active-corrected-session.pid');
      await writeTokensUntil(storage, 'guessed-session', 'guessed-session', () =>
        existsSync(heartbeat),
      );
      await client.close();
      await waitFor(() => !existsSync(heartbeat));

      expect(savedField(storage, 'corrected-session', 'estimatedCostUsd') ?? 0).toBe(0);
    }, 30000);

    it('records its own tokens that the store swap drains at adoption', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage);
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), 'own-real-session');
      const heartbeat = resolve(storage, 'active-own-real-session.pid');
      await writeTokensUntil(storage, 'other-real-session', 'own-real-session', () =>
        existsSync(heartbeat),
      );
      await client.close();
      await waitFor(() => !existsSync(heartbeat));

      expect(savedField(storage, 'own-real-session', 'estimatedCostUsd')).toBeGreaterThan(0);
    }, 30000);

    it('saves no session but the guessed one when the ppid breadcrumb corrects the guess', async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      const client = await startEngine(storage, cwd);
      await drainCalls(storage, 'other-real-session', 1);
      guessFromCwd(storage, cwd);
      await waitFor(() => savedCalls(storage, 'other-real-session') === 1);
      rmSync(resolve(storage, 'sessions'), { recursive: true });
      await adoptAndStop(storage, client, 'corrected-session');

      expect(savedCalls(storage, 'other-real-session')).toBeNull();
    }, 30000);

    it('keeps its count when its checkpoint saved the cwd guess before the ppid confirmed it', async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const client = await startEngine(storage, cwd, {
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        NR_AI_PENDING_CONFIRMATION_CAP_MS: '200',
      });
      await drainCalls(storage, 'guessed-session', 2);
      await waitFor(() => savedCalls(storage, 'guessed-session') === 2);
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), 'guessed-session');
      // The watch ticks at most 2s apart, and a checkpoint follows within 200ms.
      await new Promise((r) => setTimeout(r, 3500));
      await adoptAndStop(storage, client, 'guessed-session');

      expect(savedCalls(storage, 'guessed-session')).toBe(2);
    }, 30000);

    it('saves the other sessions it drained when one of their saves throws', async () => {
      const storage = makeStorage();
      mkdirSync(resolve(storage, 'sessions'));
      writeFileSync(
        resolve(storage, 'sessions', '2026-01-01_broken-session.json'),
        JSON.stringify({ sessionId: 'broken-session', startTime: -1e20, toolCallCount: 1 }),
      );
      const client = await startEngine(storage);
      await drainCalls(storage, 'broken-session', 1);
      await drainCalls(storage, 'other-real-session', 1);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'other-real-session')).toBe(1);
    }, 30000);

    const writeHook = (storage: string, sessionId: string, mode: string, toolUseId: string) =>
      appendToHookBuffer(
        resolve(storage, `buffer-${sessionId}.jsonl`),
        JSON.stringify({ mode, tool: 'Read', timestamp: Date.now(), sessionId, toolUseId }) + '\n',
      );
    const drained = (storage: string, sessionId: string) => () =>
      !existsSync(resolve(storage, `buffer-${sessionId}.jsonl`));
    const settle = async <T>(read: () => T, want: T): Promise<T> => {
      for (let i = 0; i < 20 && read() !== want; i++) await new Promise((r) => setTimeout(r, 250));
      return read();
    };
    const startOwner = async (storage: string, id: string) => {
      const jobDir = mkdtempSync(join(tmpdir(), 'nr-adopt-job-'));
      storages.push(jobDir);
      writeFileSync(
        resolve(jobDir, 'state.json'),
        JSON.stringify({ linkScanPath: `/x/${id}.jsonl` }),
      );
      const client = await startEngine(storage, undefined, { CLAUDE_JOB_DIR: jobDir });
      await waitFor(() => existsSync(resolve(storage, `active-${id}.pid`)));
      return client;
    };
    const stopOwner = async (storage: string, client: { close(): Promise<void> }, id: string) => {
      await client.close();
      await waitFor(() => !existsSync(resolve(storage, `active-${id}.pid`)));
    };

    it("saves another session's call in flight at adoption once, under that session", async () => {
      const storage = makeStorage();
      const pending = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'pre', 'toolu_a');
      await waitFor(drained(storage, 'other-real-session'));
      await adoptAndStop(storage, pending, 'own-real-session');
      expect(savedCalls(storage, 'other-real-session')).toBe(1);
      const owner = await startOwner(storage, 'other-real-session');
      writeHook(storage, 'other-real-session', 'post', 'toolu_a');
      await waitFor(drained(storage, 'other-real-session'));
      await stopOwner(storage, owner, 'other-real-session');

      expect(savedCalls(storage, 'own-real-session') ?? 0).toBe(0);
      expect(savedCalls(storage, 'other-real-session')).toBe(1);
    }, 30000);

    const splitCallAcrossSwap = async (storage: string): Promise<unknown> => {
      const breadcrumb = resolve(storage, 'session-by-ppid', `${process.pid}.txt`);
      const adopted = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'pre', 'toolu_x');
      await waitFor(drained(storage, 'other-real-session'));
      writeFileSync(breadcrumb, 'own-real-session');
      await waitFor(() => existsSync(resolve(storage, 'active-own-real-session.pid')));
      rmSync(breadcrumb);
      const atSwap = savedCalls(storage, 'other-real-session');
      const drainer = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'post', 'toolu_x');
      await waitFor(drained(storage, 'other-real-session'));
      await adoptAndStop(storage, drainer, 'other-real-session');
      await stopOwner(storage, adopted, 'own-real-session');
      return atSwap;
    };

    it("counts another session's call once when a second process drains its post after the swap", async () => {
      const storage = makeStorage();
      await splitCallAcrossSwap(storage);

      expect(savedCalls(storage, 'other-real-session')).toBe(1);
      expect(savedCalls(storage, 'own-real-session') ?? 0).toBe(0);
    }, 30000);

    const saveCalls = async (storage: string, id: string, count: number): Promise<void> => {
      const owner = await startOwner(storage, id);
      await drainCalls(storage, id, count);
      await stopOwner(storage, owner, id);
      expect(savedCalls(storage, id)).toBe(count);
    };

    it("adds the calls it drained for a session with a file to that file's count", async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 3);
      const client = await startEngine(storage);
      await drainCalls(storage, 'other-real-session', 2);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'other-real-session')).toBe(5);
    }, 30000);

    it("counts another session's call in flight once when that session has a file", async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 3);

      expect(await splitCallAcrossSwap(storage)).toBe(3);
      expect(savedCalls(storage, 'other-real-session')).toBe(4);
    }, 30000);

    it('adds no call that another process marked counted after this one drained its post', async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 1);
      const client = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'post', 'toolu_x');
      await waitFor(drained(storage, 'other-real-session'));
      mkdirSync(resolve(storage, 'counted'), { recursive: true });
      writeFileSync(resolve(storage, 'counted', 'other-real-session.1.json'), '["toolu_x"]');
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'other-real-session')).toBe(1);
    }, 30000);

    it('counts a guess once when a correction saves what its own checkpoint already saved', async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const client = await startEngine(storage, cwd, {
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        NR_AI_PENDING_CONFIRMATION_CAP_MS: '200',
      });
      await drainCalls(storage, 'guessed-session', 2);
      await waitFor(() => savedCalls(storage, 'guessed-session') === 2);
      await adoptAndStop(storage, client, 'corrected-session');

      expect(savedCalls(storage, 'guessed-session')).toBe(2);
    }, 30000);

    it('counts its own call drained while pending once it adopts its session', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage);
      await drainCalls(storage, 'own-real-session', 1);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'own-real-session')).toBe(1);
    }, 30000);

    it("saves another session's rollup as in progress at adoption, since that session may be live", async () => {
      const storage = makeStorage();
      const client = await startEngine(storage);
      await drainCalls(storage, 'other-real-session', 1);
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedField(storage, 'other-real-session', 'outcome')).toBe('in progress');
    }, 30000);

    it('saves a pending checkpoint in progress and its shutdown save completed', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage, undefined, CHECKPOINT_OFTEN);
      await drainCalls(storage, 'other-real-session', 1);
      await waitFor(() => savedCalls(storage, 'other-real-session') === 1);
      const atCheckpoint = savedField(storage, 'other-real-session', 'outcome');
      await client.close();
      await waitFor(() => savedField(storage, 'other-real-session', 'outcome') === 'completed');

      expect(atCheckpoint).toBe('in progress');
    }, 30000);

    it('keeps a call with no session id across its first adoption', async () => {
      const storage = makeStorage();
      const client = await startEngine(storage);
      const buffer = resolve(storage, 'buffer-no-id.jsonl');
      for (const mode of ['pre', 'post']) {
        const call = { tool: 'Read', timestamp: Date.now(), toolUseId: 'toolu_no_id' };
        appendToHookBuffer(buffer, JSON.stringify({ mode, ...call }) + '\n');
      }
      await waitFor(() => !existsSync(buffer));
      await adoptAndStop(storage, client, 'own-real-session');

      expect(savedCalls(storage, 'own-real-session')).toBe(1);
    }, 30000);

    it("leaves a call's id unmarked when saving its session throws", async () => {
      const storage = makeStorage();
      mkdirSync(resolve(storage, 'sessions'));
      writeFileSync(
        resolve(storage, 'sessions', '2026-01-01_broken-session.json'),
        JSON.stringify({ sessionId: 'broken-session', startTime: -1e20, toolCallCount: 0 }),
      );
      const client = await startEngine(storage);
      writeHook(storage, 'broken-session', 'pre', 'toolu_x');
      await waitFor(drained(storage, 'broken-session'));
      await adoptAndStop(storage, client, 'own-real-session');

      const counted = resolve(storage, 'counted');
      expect(existsSync(counted) ? readdirSync(counted) : []).toEqual([]);
    }, 30000);

    it("keeps adding to a session's file across its later checkpoints", async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 3);
      const client = await startEngine(storage, undefined, CHECKPOINT_OFTEN);
      await drainCalls(storage, 'other-real-session', 1);
      await waitFor(() => savedCalls(storage, 'other-real-session') === 4);
      await drainCalls(storage, 'other-real-session', 1);
      await waitFor(() => savedCalls(storage, 'other-real-session') === 5);
      await adoptAndStop(storage, client, 'own-real-session');
    }, 30000);

    it('adds to the file after a checkpoint that failed to write it', async () => {
      if (process.getuid?.() === 0) return; // root ignores the mode
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 3);
      const client = await startEngine(storage, undefined, CHECKPOINT_OFTEN);
      chmodSync(resolve(storage, 'sessions'), 0o500);
      await drainCalls(storage, 'other-real-session', 1);
      await new Promise((r) => setTimeout(r, 500));
      chmodSync(resolve(storage, 'sessions'), 0o700);
      await waitFor(() => savedCalls(storage, 'other-real-session') === 4);
      await adoptAndStop(storage, client, 'own-real-session');
    }, 30000);

    it('logs a session with a file among the sessions it saved at shutdown', async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'other-real-session', 3);
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
      delete env.CLAUDE_JOB_DIR;
      const transport = new StdioClientTransport({
        command: 'node',
        args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio'],
        stderr: 'pipe',
        env: {
          ...env,
          NR_AI_DASHBOARD_PORT: '0',
          NR_AI_MODE: 'local',
          NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
        },
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await connectToConfiguredEngine(client, transport);
      await drainCalls(storage, 'other-real-session', 1);
      await client.close();
      await waitFor(() => stderr.includes('Persisted observed sessions'));

      expect(stderr).toMatch(/"persistedSessions":1\b.*Persisted observed sessions/);
    }, 30000);

    it('writes no file for a cwd guess it adopts until the guess is confirmed', async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      const client = await startEngine(storage, cwd);
      await drainCalls(storage, 'guessed-session', 1);
      guessFromCwd(storage, cwd);
      await waitFor(() => existsSync(resolve(storage, 'active-guessed-session.pid')));
      const atAdoption = savedCalls(storage, 'guessed-session');
      await client.close();

      expect(atAdoption).toBeNull();
    }, 30000);

    it("keeps a call's id unmarked when the adoption could not save its session", async () => {
      if (process.getuid?.() === 0) return; // root ignores the mode
      const storage = makeStorage();
      const sessions = resolve(storage, 'sessions');
      mkdirSync(sessions, { mode: 0o500 });
      const client = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'pre', 'toolu_unsaved');
      await waitFor(drained(storage, 'other-real-session'));
      await adoptAndStop(storage, client, 'own-real-session');
      chmodSync(sessions, 0o700);

      const counted = resolve(storage, 'counted');
      expect(existsSync(counted) ? readdirSync(counted) : []).toEqual([]);
    }, 30000);

    it("seeds the corrected session from its file before this engine's first save", async () => {
      const storage = makeStorage();
      await saveCalls(storage, 'real-session', 1);

      const cwd = makeCwd();
      const client = await startEngine(storage, cwd, CHECKPOINT_OFTEN);
      await drainCalls(storage, 'real-session', 2);
      await waitFor(() => savedCalls(storage, 'real-session') === 3);
      guessFromCwd(storage, cwd);
      await waitFor(() => existsSync(resolve(storage, 'active-guessed-session.pid')));
      await adoptAndStop(storage, client, 'real-session');

      expect(savedCalls(storage, 'real-session')).toBe(3);
    }, 30000);

    it('counts a call once when its owner recorded the post and restarted before adoption', async () => {
      const storage = makeStorage();
      const pending = await startEngine(storage);
      writeHook(storage, 'other-real-session', 'pre', 'toolu_c');
      await waitFor(drained(storage, 'other-real-session'));
      const owner = await startOwner(storage, 'other-real-session');
      writeHook(storage, 'other-real-session', 'post', 'toolu_c');
      await waitFor(drained(storage, 'other-real-session'));
      await stopOwner(storage, owner, 'other-real-session');
      const restarted = await startOwner(storage, 'other-real-session');
      await adoptAndStop(storage, pending, 'own-real-session');
      await waitFor(drained(storage, 'other-real-session'));
      await stopOwner(storage, restarted, 'other-real-session');

      expect(savedCalls(storage, 'other-real-session')).toBe(1);
      expect(savedCalls(storage, 'own-real-session') ?? 0).toBe(0);
    }, 30000);

    const adoptedId = async (client: Awaited<ReturnType<typeof startEngine>>): Promise<string> => {
      for (let i = 0; i < 80; i++) {
        const result = await client
          .callTool({ name: 'nr_observe_get_session_stats', arguments: {} })
          .catch(() => null);
        const content = result?.content as Array<{ text?: string }> | undefined;
        const id = content
          ? (JSON.parse(content[0]?.text ?? '{}') as { session_id?: string }).session_id
          : '';
        if (id && !id.startsWith('pending-')) return id;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('engine never adopted a session');
    };

    it("leaves a live engine's heartbeat alone when it adopts that session from a cwd guess", async () => {
      const storage = makeStorage();
      const owner = await startOwner(storage, 'guessed-session');
      const heartbeat = resolve(storage, 'active-guessed-session.pid');
      const ownerPid = readFileSync(heartbeat, 'utf-8');
      const cwd = makeCwd();
      const guessing = await startEngine(storage, cwd);
      guessFromCwd(storage, cwd);
      expect(await adoptedId(guessing)).toBe('guessed-session');
      const afterAdoption = readFileSync(heartbeat, 'utf-8');
      await guessing.close();
      await stopOwner(storage, owner, 'guessed-session');

      expect(afterAdoption).toBe(ownerPid);
    }, 30000);

    it("lets another process drain the guessed session's buffer after a correction", async () => {
      const storage = makeStorage();
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const guessing = await startEngine(storage, cwd);
      const breadcrumb = resolve(storage, 'session-by-ppid', `${process.pid}.txt`);
      writeFileSync(breadcrumb, 'corrected-session');
      await waitFor(() => existsSync(resolve(storage, 'active-corrected-session.pid')));
      rmSync(breadcrumb);
      const drainer = await startEngine(storage, undefined, {
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
      });
      writeHook(storage, 'guessed-session', 'pre', 'toolu_b');
      writeHook(storage, 'guessed-session', 'post', 'toolu_b');
      const saved = await settle(() => savedCalls(storage, 'guessed-session'), 1);
      await drainer.close();
      await stopOwner(storage, guessing, 'corrected-session');

      expect(saved).toBe(1);
    }, 30000);

    it("keeps the heartbeat of the guessed session's own engine through the correction", async () => {
      const storage = makeStorage();
      const owner = await startOwner(storage, 'guessed-session');
      const heartbeat = resolve(storage, 'active-guessed-session.pid');
      const ownerPid = readFileSync(heartbeat, 'utf-8');
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const guessing = await startEngine(storage, cwd);
      const guessedPid = readFileSync(heartbeat, 'utf-8');
      await adoptAndStop(storage, guessing, 'corrected-session');
      const afterCorrection = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf-8') : null;
      await stopOwner(storage, owner, 'guessed-session');

      expect([guessedPid, afterCorrection]).toEqual([ownerPid, ownerPid]);
    }, 30000);

    it('takes the heartbeat of its guessed session once the ppid breadcrumb confirms it', async () => {
      const storage = makeStorage();
      const previous = await startOwner(storage, 'guessed-session');
      const heartbeat = resolve(storage, 'active-guessed-session.pid');
      const previousPid = readFileSync(heartbeat, 'utf-8');
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const guessing = await startEngine(storage, cwd);
      writeFileSync(resolve(storage, 'session-by-ppid', `${process.pid}.txt`), 'guessed-session');
      await waitFor(() => readFileSync(heartbeat, 'utf-8') !== previousPid);
      await previous.close();
      await new Promise((r) => setTimeout(r, 1000));
      const afterPreviousExit = existsSync(heartbeat);
      await stopOwner(storage, guessing, 'guessed-session');

      expect(afterPreviousExit).toBe(true);
    }, 30000);

    it("takes the heartbeat of its guessed session once that session's own engine exits", async () => {
      const storage = makeStorage();
      const previous = await startOwner(storage, 'guessed-session');
      const heartbeat = resolve(storage, 'active-guessed-session.pid');
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const guessing = await startEngine(storage, cwd, {
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
      });
      await stopOwner(storage, previous, 'guessed-session');
      const retaken = await settle(() => existsSync(heartbeat), true);
      await stopOwner(storage, guessing, 'guessed-session');

      expect(retaken).toBe(true);
    }, 30000);

    it("leaves a live engine's heartbeat alone at each checkpoint of a cwd guess", async () => {
      const storage = makeStorage();
      const owner = await startOwner(storage, 'guessed-session');
      const heartbeat = resolve(storage, 'active-guessed-session.pid');
      const ownerPid = readFileSync(heartbeat, 'utf-8');
      const cwd = makeCwd();
      guessFromCwd(storage, cwd);
      const guessing = await startEngine(storage, cwd, {
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '100',
      });
      await new Promise((r) => setTimeout(r, 1000));
      const afterCheckpoints = readFileSync(heartbeat, 'utf-8');
      await guessing.close();
      await stopOwner(storage, owner, 'guessed-session');

      expect(afterCheckpoints).toBe(ownerPid);
    }, 30000);
  });

  describe('nr_observe_install_hooks while the session is still pending', () => {
    async function withPendingServer(
      opts: { mcpClient: string; allow: boolean },
      run: (
        call: (name: string) => Promise<{ body: Record<string, unknown>; isError: unknown }>,
        settingsPath: string,
      ) => Promise<void>,
    ): Promise<void> {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const binPath = resolve(__dirname, '..', 'dist', 'index.js');
      const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-pending-install-storage-'));
      const tmpHome = mkdtempSync(join(tmpdir(), 'nr-pending-install-home-'));

      // No breadcrumb and no CLAUDE_* vars keeps the server in pending mode for
      // the whole call, as on a fresh install that has no hooks yet. MCP_CLIENT
      // names the client explicitly instead.
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
      for (const name of Object.keys(env)) {
        if (name.startsWith('CLAUDE')) delete env[name];
      }

      const transport = new StdioClientTransport({
        command: 'node',
        args: [binPath, '--stdio'],
        env: {
          ...env,
          HOME: tmpHome,
          MCP_CLIENT: opts.mcpClient,
          NR_AI_DASHBOARD_PORT: '0',
          NR_AI_MODE: 'local',
          NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
          NEW_RELIC_AI_ALLOW_HEADLESS_INSTALL: String(opts.allow),
        },
      });

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      try {
        await connectToConfiguredEngine(client, transport);
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).not.toContain('nr_observe_get_session_stats');
        await run(
          async (name) => {
            const result = await client.callTool({ name, arguments: {} });
            const text = (result.content as Array<{ text: string }>)[0].text;
            return { body: JSON.parse(text) as Record<string, unknown>, isError: result.isError };
          },
          resolve(tmpHome, '.claude', 'settings.json'),
        );
        await client.close();
      } finally {
        rmSync(tmpStoragePath, { recursive: true, force: true });
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }

    it('refuses with the opt-in message and writes nothing when allowHeadlessInstall is off', async () => {
      await withPendingServer({ mcpClient: 'claude-code', allow: false }, async (call, path) => {
        const { body, isError } = await call('nr_observe_install_hooks');
        expect(isError).toBe(true);
        expect(body.status).toBe('disabled');
        expect(existsSync(path)).toBe(false);
      });
    }, 30000);

    it('installs the hooks for Claude Code when allowHeadlessInstall is on', async () => {
      await withPendingServer({ mcpClient: 'claude-code', allow: true }, async (call, path) => {
        const health = await call('nr_observe_health');
        expect(health.body.setup_required).toBe(true);

        const { body } = await call('nr_observe_install_hooks');
        expect(body.status).toBe('installed');
        expect(readFileSync(path, 'utf-8')).toContain('PreToolUse');
      });
    }, 30000);

    it('neither reports setup_required nor installs hooks for a non-Claude client', async () => {
      await withPendingServer({ mcpClient: 'zed', allow: true }, async (call, path) => {
        const health = await call('nr_observe_health');
        expect('setup_required' in health.body).toBe(false);
        expect('hooks_installed' in health.body).toBe(false);

        const { body, isError } = await call('nr_observe_install_hooks');
        expect(isError).toBe(true);
        expect(body.error).toBe('Hook installer not available in this server mode');
        expect(existsSync(path)).toBe(false);
      });
    }, 30000);
  });

  describe('self-report lines', () => {
    const distDir = resolve(__dirname, '..', 'dist');
    const report = {
      input_tokens: 1000,
      output_tokens: 200,
      thinking_tokens: 100,
      model: 'claude-sonnet-4-6',
    };
    const hookReply = (reportId: string) =>
      JSON.stringify({ accepted: true, recorded_by: 'hook', report_id: reportId });
    const reportHook = (conversationId: string, reportId: string) => ({
      hook_event_name: 'afterMCPExecution',
      conversation_id: conversationId,
      mcp_server_name: 'newrelic-preflight',
      tool_name: 'nr_observe_report_tokens',
      tool_input: JSON.stringify({ ...report, report_id: reportId }),
      result_json: JSON.stringify({ content: [{ type: 'text', text: hookReply(reportId) }] }),
    });
    const isolatedEnv = (overrides: Record<string, string>): Record<string, string> => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined || /^(CLAUDE|CURSOR)/.test(name)) continue;
        if (['MCP_CLIENT', 'NEW_RELIC_AI_PLATFORM', 'NR_AI_MODE'].includes(name)) continue;
        env[name] = value;
      }
      return { ...env, ...overrides };
    };
    const runHook = (
      env: Record<string, string>,
      payload: Record<string, unknown>,
      args: string[] = [],
    ) =>
      spawnSync('node', [resolve(distDir, 'hooks', 'collector-script.js'), ...args], {
        input: JSON.stringify(payload),
        env,
        cwd: env.NEW_RELIC_AI_MCP_STORAGE_PATH,
      });
    const savedSession = (storagePath: string, id: string): Record<string, unknown> | null => {
      const dir = resolve(storagePath, 'sessions');
      const name = existsSync(dir) ? readdirSync(dir).find((f) => f.includes(id)) : undefined;
      return name ? JSON.parse(readFileSync(resolve(dir, name), 'utf-8')) : null;
    };
    const until = async <T>(read: () => T | Promise<T>, done: (v: T) => boolean): Promise<T> => {
      let value = await read();
      for (let i = 0; i < 40 && !done(value); i++) {
        await new Promise((r) => setTimeout(r, 250));
        value = await read();
      }
      return value;
    };

    it('a --local process saves a drained report to its conversation and keeps its own estimates', async () => {
      const { createServer: createNetServer } = await import('node:net');
      const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-local-report-storage-'));
      const tmpHome = mkdtempSync(join(tmpdir(), 'nr-local-report-home-'));
      const port = await new Promise<number>((resolvePort, reject) => {
        const srv = createNetServer();
        srv.listen(0, '127.0.0.1', () => {
          const p = (srv.address() as { port: number }).port;
          srv.close((err) => (err ? reject(err) : resolvePort(p)));
        });
        srv.on('error', reject);
      });
      const env = isolatedEnv({
        HOME: tmpHome,
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_DASHBOARD_PORT: String(port),
        NR_AI_ALERTS_ENABLED: 'false',
        NEW_RELIC_LICENSE_KEY: '',
        NEW_RELIC_ACCOUNT_ID: '',
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
      });
      const api = async (path: string): Promise<Record<string, unknown>> =>
        (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as Record<string, unknown>;
      type Cost = { reportCount: number; byteEstimates?: { costUsd: number } };
      const cost = async (): Promise<Cost> => (await api('/api/cost')).cost as Cost;

      const child = spawn(process.execPath, [resolve(distDir, 'index.js'), '--local'], {
        env,
        cwd: tmpStoragePath,
        stdio: 'ignore',
      });
      try {
        await until(
          () => api('/api/health').catch(() => null),
          (v) => v !== null,
        );
        const read = { tool_name: 'Read', tool_use_id: 'tu-1', tool_input: { file_path: '/a' } };
        runHook(env, { hook_event_name: 'PreToolUse', ...read }, ['pre-tool']);
        const response = { tool_response: { content: 'y'.repeat(40_000) } };
        runHook(env, { hook_event_name: 'PostToolUse', ...read, ...response }, ['post-tool']);
        const estimated = await until(cost, (c) => (c.byteEstimates?.costUsd ?? 0) > 0);
        expect(estimated.byteEstimates?.costUsd).toBeGreaterThan(0);

        runHook(env, reportHook('conv-local', 'r-local-0001'));

        const saved = await until(
          () => savedSession(tmpStoragePath, 'conv-local'),
          (v) => typeof v?.tokensInput === 'number' && v.tokensInput > 0,
        );
        const after = await cost();
        expect(after.byteEstimates?.costUsd).toBe(estimated.byteEstimates?.costUsd);
        expect(after.reportCount).toBe(0);
        expect((await api('/api/context?sessionId=conv-local')).turnCount).toBe(0);
        expect(saved).toMatchObject({ tokensInput: 1000, tokensThinking: 100, platform: 'cursor' });
        expect(saved?.estimatedCostUsd).toBeGreaterThan(0);
      } finally {
        child.kill('SIGKILL');
        rmSync(tmpStoragePath, { recursive: true, force: true });
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }, 40000);
    const withPendingEngine = async (
      persistIntervalMs: string,
      body: (
        env: Record<string, string>,
        adopt: (id: string) => Promise<void>,
        close: () => Promise<void>,
      ) => Promise<void>,
      nodeArgs: (env: Record<string, string>) => string[] = () => [],
      mcpClient = 'claude-code',
    ): Promise<void> => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-adopt-report-storage-'));
      const tmpHome = mkdtempSync(join(tmpdir(), 'nr-adopt-report-home-'));
      const env = isolatedEnv({
        HOME: tmpHome,
        MCP_CLIENT: mcpClient,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: persistIntervalMs,
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const adopt = async (id: string) => {
        const breadcrumbDir = resolve(
          breadcrumbRoot(tmpStoragePath, 'claude-code'),
          'session-by-ppid',
        );
        mkdirSync(breadcrumbDir, { recursive: true });
        writeFileSync(resolve(breadcrumbDir, `${process.pid}.txt`), id);
        const toolNames = async () => (await client.listTools()).tools.map((t) => t.name);
        const adopted = await until(toolNames, (n) => n.includes('nr_observe_get_session_stats'));
        expect(adopted).toContain('nr_observe_get_session_stats');
      };
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const args = [...nodeArgs(env), resolve(distDir, 'index.js'), '--stdio'];
        const transport = new StdioClientTransport({ command: 'node', args, env });
        await client.connect(transport);
        const pid = transport.pid!;
        let closed = false;
        const close = async () => {
          closed = true;
          await client.close();
          expect(
            await until(
              () => alive(pid),
              (a) => !a,
            ),
          ).toBe(false);
        };
        try {
          await body(env, adopt, close);
        } finally {
          if (!closed) await client.close().catch(() => undefined);
        }
      } finally {
        rmSync(tmpStoragePath, { recursive: true, force: true });
        rmSync(tmpHome, { recursive: true, force: true });
      }
    };
    const drained = (storage: string, conversationId: string) => {
      const bufferPath = resolve(storage, `buffer-${conversationId}.jsonl`);
      const pending = () => (existsSync(bufferPath) ? readFileSync(bufferPath, 'utf-8') : '');
      return until(pending, (v) => v === '');
    };

    it('a cursor engine saves a self-report for its conversation on shutdown without adopting', async () => {
      await withPendingEngine(
        '600000',
        async (env, _adopt, close) => {
          const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
          runHook(env, reportHook('conv-cursor', 'r-cursor-0001'));
          expect(await drained(storage, 'conv-cursor')).toBe('');

          await close();

          expect(savedSession(storage, 'conv-cursor')).toMatchObject({
            platform: 'cursor',
            tokensInput: 1000,
            tokensThinking: 100,
            selfReportCount: 1,
          });
        },
        () => [],
        'cursor',
      );
    }, 40000);

    it.each([
      ['another session', 'in progress', 'real-owner-session'],
      ['the reporting conversation', 'completed', 'conv-adopt'],
    ])(
      'a pending engine that drains a report and then adopts %s saves the report with outcome %s',
      async (_label, outcome, adoptedId) => {
        await withPendingEngine('600000', async (env, adopt, close) => {
          const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
          runHook(env, reportHook('conv-adopt', 'r-adopt-0001'));
          expect(await drained(storage, 'conv-adopt')).toBe('');

          await adopt(adoptedId);
          await close();

          const saved = savedSession(storage, 'conv-adopt');
          expect(saved).toMatchObject({
            tokensInput: 1000,
            tokensThinking: 100,
            selfReportCount: 1,
          });
          expect(saved?.outcome).toBe(outcome);
        });
      },
      40000,
    );

    it('a pending engine saves a drained report for its cwd guess once the ppid confirms the guess', async () => {
      await withPendingEngine('600000', async (env, _adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        runHook(env, reportHook('conv-guess', 'r-guess-0001'));
        expect(await drained(storage, 'conv-guess')).toBe('');
        const crumbs = resolve(breadcrumbRoot(storage, 'claude-code'), 'session-by-cwd');
        mkdirSync(crumbs, { recursive: true });
        writeFileSync(
          resolve(crumbs, `${realpathSync(process.cwd()).replace(/[\\/:]/g, '-')}.txt`),
          'conv-guess',
        );
        await until(
          () => existsSync(resolve(storage, 'active-conv-guess.pid')),
          (alive) => alive,
        );

        const ppidCrumbs = resolve(breadcrumbRoot(storage, 'claude-code'), 'session-by-ppid');
        mkdirSync(ppidCrumbs, { recursive: true });
        writeFileSync(resolve(ppidCrumbs, `${process.pid}.txt`), 'conv-guess');
        const confirmed = await until(
          () => savedSession(storage, 'conv-guess')?.tokensInput,
          (tokens) => tokens === 1000,
        );
        await close();

        expect(confirmed).toBe(1000);
      });
    }, 40000);

    it('a pending engine adds the report it drained before adopting its conversation to the ones after', async () => {
      await withPendingEngine('600000', async (env, adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        runHook(env, reportHook('conv-own', 'r-own-00001'));
        expect(await drained(storage, 'conv-own')).toBe('');
        await adopt('conv-own');
        runHook(env, reportHook('conv-own', 'r-own-00002'));
        expect(await drained(storage, 'conv-own')).toBe('');
        await close();

        expect(savedSession(storage, 'conv-own')).toMatchObject({
          tokensInput: 2000,
          selfReportCount: 1,
        });
      });
    }, 40000);

    it('a pending engine adds the report it drained before its cwd guess is confirmed to the ones after', async () => {
      await withPendingEngine('600000', async (env, _adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        runHook(env, reportHook('conv-guess', 'r-guess-0001'));
        expect(await drained(storage, 'conv-guess')).toBe('');
        const crumbs = resolve(breadcrumbRoot(storage, 'claude-code'), 'session-by-cwd');
        mkdirSync(crumbs, { recursive: true });
        writeFileSync(
          resolve(crumbs, `${realpathSync(process.cwd()).replace(/[\\/:]/g, '-')}.txt`),
          'conv-guess',
        );
        await until(
          () => existsSync(resolve(storage, 'active-conv-guess.pid')),
          (alive) => alive,
        );
        const ppidCrumbs = resolve(breadcrumbRoot(storage, 'claude-code'), 'session-by-ppid');
        mkdirSync(ppidCrumbs, { recursive: true });
        writeFileSync(resolve(ppidCrumbs, `${process.pid}.txt`), 'conv-guess');
        await until(
          () => savedSession(storage, 'conv-guess')?.tokensInput,
          (tokens) => tokens === 1000,
        );
        expect(savedSession(storage, 'conv-guess')?.outcome).toBe('in progress');
        runHook(env, reportHook('conv-guess', 'r-guess-0002'));
        expect(await drained(storage, 'conv-guess')).toBe('');
        await close();

        expect(savedSession(storage, 'conv-guess')?.tokensInput).toBe(2000);
      });
    }, 40000);

    it('a claude-code engine stops estimating its own session once a drained report for it arrives', async () => {
      await withPendingEngine('600000', async (env, adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        await adopt('real-owner-session');
        runHook(env, reportHook('real-owner-session', 'r-own-00001'));
        expect(await drained(storage, 'real-owner-session')).toBe('');
        const read = { session_id: 'real-owner-session', tool_name: 'Read', tool_use_id: 'tu-big' };
        runHook(
          env,
          { hook_event_name: 'PreToolUse', ...read, tool_input: { file_path: '/repo/big.txt' } },
          ['pre-tool'],
        );
        runHook(
          env,
          {
            hook_event_name: 'PostToolUse',
            ...read,
            tool_response: { content: 'y'.repeat(40_000) },
          },
          ['post-tool'],
        );
        await close();

        const saved = savedSession(storage, 'real-owner-session');
        expect(saved).toMatchObject({ tokensInput: 1000 });
        expect(saved?.estimatedCostUsd).toBeCloseTo(0.0075, 6);
      });
    }, 40000);

    it("a pending engine that drains another conversation's tool calls and then adopts saves them", async () => {
      await withPendingEngine('600000', async (env, adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        const edit = { conversation_id: 'conv-edits', file_path: '/repo/a.ts' };
        runHook(env, { hook_event_name: 'afterFileEdit', ...edit });
        expect(await drained(storage, 'conv-edits')).toBe('');

        await adopt('real-owner-session');
        await close();

        expect(savedSession(storage, 'conv-edits')).toMatchObject({ toolCallCount: 1 });
      });
    }, 40000);

    it('an observed save that throws or fails neither stops the next one nor the owner save, and is retried', async () => {
      const preloadDir = mkdtempSync(join(tmpdir(), 'nr-throwing-save-'));
      const saveLog = resolve(preloadDir, 'saves.log');
      const storeUrl = pathToFileURL(resolve(distDir, 'storage', 'session-store.js')).href;
      writeFileSync(
        resolve(preloadDir, 'preload.mjs'),
        [
          "import { appendFileSync } from 'node:fs';",
          `const { SessionStore } = await import(${JSON.stringify(storeUrl)});`,
          'const save = SessionStore.prototype.saveSession;',
          'let failed = false;',
          'SessionStore.prototype.saveSession = function (summary) {',
          `  appendFileSync(${JSON.stringify(saveLog)}, summary.sessionId + '\\n');`,
          "  if (summary.sessionId === 'conv-throws') throw new Error('injected save failure');",
          "  if (summary.sessionId === 'conv-fails' && !failed) return (failed = true), null;",
          '  return save.call(this, summary);',
          '};',
        ].join('\n'),
      );
      const preload = pathToFileURL(resolve(preloadDir, 'preload.mjs')).href;
      try {
        await withPendingEngine(
          '600000',
          async (env, adopt, close) => {
            const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
            runHook(env, reportHook('conv-throws', 'r-throws-001'));
            expect(await drained(storage, 'conv-throws')).toBe('');
            runHook(env, reportHook('conv-saved', 'r-saved-0001'));
            expect(await drained(storage, 'conv-saved')).toBe('');
            runHook(env, reportHook('conv-fails', 'r-fails-0001'));
            expect(await drained(storage, 'conv-fails')).toBe('');

            await adopt('real-owner-session');
            await close();

            const saves = readFileSync(saveLog, 'utf-8').trim().split('\n');
            expect([...saves.slice(0, 3), saves.at(-1)]).toEqual([
              'conv-throws',
              'conv-saved',
              'conv-fails',
              'real-owner-session',
            ]);
            expect(saves.filter((id) => id === 'conv-throws').length).toBeGreaterThan(1);
            expect(savedSession(storage, 'conv-saved')).toMatchObject({ tokensInput: 1000 });
            expect(savedSession(storage, 'conv-fails')).toMatchObject({
              tokensInput: 1000,
              outcome: 'in progress',
            });
          },
          () => ['--import', preload],
        );
      } finally {
        rmSync(preloadDir, { recursive: true, force: true });
      }
    }, 40000);

    it('a resumed engine saves a report for its own conversation once, on top of the saved total', async () => {
      await withPendingEngine('600000', async (env, adopt, close) => {
        const storage = env.NEW_RELIC_AI_MCP_STORAGE_PATH;
        const startTime = Date.now() - 60_000;
        const prior = {
          sessionId: 'conv-resumed',
          startTime,
          endTime: startTime,
          toolCallCount: 3,
        };
        const day = new Date(startTime).toISOString().slice(0, 10);
        mkdirSync(resolve(storage, 'sessions'), { recursive: true });
        writeFileSync(
          resolve(storage, 'sessions', `${day}_conv-resumed.json`),
          JSON.stringify({
            ...prior,
            estimatedCostUsd: 10,
            tokensInput: 100,
            outcome: 'in progress',
          }),
        );

        await adopt('conv-resumed');
        runHook(env, reportHook('conv-resumed', 'r-resumed-01'));
        expect(await drained(storage, 'conv-resumed')).toBe('');
        await close();

        const saved = savedSession(storage, 'conv-resumed');
        expect(saved).toMatchObject({ tokensInput: 1100, outcome: 'completed' });
        expect(saved?.modelBreakdown).toHaveProperty(['claude-sonnet-4-6']);
        expect(saved?.estimatedCostUsd).toBeCloseTo(10.0075, 6);
      });
    }, 40000);
  });

  describe('nr_observe_report_tokens while the engine is pending', () => {
    type Client = import('@modelcontextprotocol/sdk/client/index.js').Client;
    const report = {
      report_id: 'r-5f0c2a9e',
      input_tokens: 1000,
      output_tokens: 200,
      thinking_tokens: 100,
      model: 'claude-sonnet-4-6',
    };

    async function withPendingEngine(
      mcpClient: string,
      run: (
        client: Client,
        hook: (payload: Record<string, unknown>) => void,
        sessionFile: (conversationId: string) => Promise<Record<string, unknown> | null>,
        storagePath: string,
      ) => Promise<void>,
      engineEnv: Record<string, string> = { MCP_CLIENT: mcpClient },
      homeFiles: Record<string, unknown> = {},
    ): Promise<void> {
      const { spawnSync } = await import('node:child_process');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const distDir = resolve(__dirname, '..', 'dist');
      const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-pending-report-storage-'));
      const tmpHome = mkdtempSync(join(tmpdir(), 'nr-pending-report-home-'));
      for (const [path, content] of Object.entries(homeFiles)) {
        mkdirSync(resolve(tmpHome, path, '..'), { recursive: true });
        writeFileSync(resolve(tmpHome, path), JSON.stringify(content));
      }
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (/^(CLAUDE|CURSOR|MCP_CLIENT$|NEW_RELIC_AI_PLATFORM$)/.test(name)) delete env[name];
      }
      const hook = (payload: Record<string, unknown>) => {
        const run = spawnSync('node', [resolve(distDir, 'hooks', 'collector-script.js')], {
          input: JSON.stringify(payload),
          env: {
            ...env,
            HOME: tmpHome,
            MCP_CLIENT: mcpClient,
            NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
          },
          cwd: tmpStoragePath,
        });
        expect(run.status).toBe(0);
      };
      const sessionFile = async (
        conversationId: string,
      ): Promise<Record<string, unknown> | null> => {
        const dir = resolve(tmpStoragePath, 'sessions');
        for (let i = 0; i < 40; i++) {
          const name = existsSync(dir)
            ? readdirSync(dir).find((f) => f.includes(conversationId))
            : undefined;
          const saved = name ? JSON.parse(readFileSync(resolve(dir, name), 'utf-8')) : null;
          if (saved?.estimatedCostUsd || saved?.toolCallCount) return saved;
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      };

      const client = new Client({ name: mcpClient, version: '1.0.0' });
      try {
        await client.connect(
          new StdioClientTransport({
            command: 'node',
            args: [resolve(distDir, 'index.js'), '--stdio'],
            cwd: tmpStoragePath,
            env: {
              ...env,
              HOME: tmpHome,
              ...engineEnv,
              NR_AI_DASHBOARD_PORT: '0',
              NR_AI_MODE: 'local',
              NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
              NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
            } as Record<string, string>,
          }),
        );
        await run(client, hook, sessionFile, tmpStoragePath);
      } finally {
        await client.close();
        rmSync(tmpStoragePath, { recursive: true, force: true });
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }

    it('saves a Cursor report once, to the conversation whose hook carried it', async () => {
      await withPendingEngine('cursor', async (client, hook, sessionFile) => {
        hook({
          hook_event_name: 'beforeShellExecution',
          conversation_id: 'conv-silent',
          command: 'ls',
        });
        hook({ hook_event_name: 'afterShellExecution', conversation_id: 'conv-silent' });
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await client.callTool({
            name: 'nr_observe_report_tokens',
            arguments: report,
          });
          hook({
            hook_event_name: 'afterMCPExecution',
            conversation_id: 'conv-reported',
            mcp_server_name: 'newrelic-preflight',
            tool_name: 'nr_observe_report_tokens',
            tool_input: JSON.stringify(report),
            result_json: JSON.stringify(result),
          });
        }

        const reported = await sessionFile('conv-reported');
        expect(reported?.tokensInput).toBe(1000);
        expect(reported?.tokensOutput).toBe(200);
        expect(reported?.tokensThinking).toBe(100);
        expect(reported?.estimatedCostUsd).toBeGreaterThan(0);
        const silent = await sessionFile('conv-silent');
        expect(silent?.toolCallCount).toBe(1);
        expect(silent?.tokensInput).toBe(0);
        expect(silent?.estimatedCostUsd).toBeNull();
      });
    }, 30000);

    it('leaves the report to the hook and stays pending even when a breadcrumb is written', async () => {
      await withPendingEngine('cursor', async (client, hook, _sessionFile, storagePath) => {
        for (const root of [storagePath, resolve(storagePath, 'breadcrumbs', 'claude-code')]) {
          const dir = resolve(root, 'session-by-ppid');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${process.pid}.txt`), 'real-owner-session');
        }
        await new Promise((r) => setTimeout(r, 1500));
        const names = async () => (await client.listTools()).tools.map((t) => t.name);
        expect(await names()).not.toContain('nr_observe_get_session_stats');

        const result = await client.callTool({
          name: 'nr_observe_report_tokens',
          arguments: report,
        });
        const reply = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(reply).toMatchObject({
          accepted: true,
          recorded_by: 'hook',
          report_id: report.report_id,
        });
        hook({
          hook_event_name: 'afterMCPExecution',
          conversation_id: 'conv-reported',
          mcp_server_name: 'newrelic-preflight',
          tool_name: 'nr_observe_report_tokens',
          tool_input: JSON.stringify(report),
          result_json: JSON.stringify(result),
        });

        const buffer = readFileSync(resolve(storagePath, 'buffer-conv-reported.jsonl'), 'utf-8');
        const lines = buffer
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(lines.filter((l) => l.mode === 'self_report')).toMatchObject([
          { inputTokens: 1000 },
        ]);
      });
    }, 30000);

    it("a pending Cursor engine stops estimating a conversation once the hook saved that conversation's report", async () => {
      await withPendingEngine('cursor', async (client, hook, sessionFile) => {
        const result = await client.callTool({
          name: 'nr_observe_report_tokens',
          arguments: report,
        });
        hook({
          hook_event_name: 'afterMCPExecution',
          conversation_id: 'conv-reported',
          mcp_server_name: 'newrelic-preflight',
          tool_name: 'nr_observe_report_tokens',
          tool_input: JSON.stringify(report),
          result_json: JSON.stringify(result),
        });
        const read = { session_id: 'conv-reported', tool_name: 'Read', tool_use_id: 'tu-big' };
        hook({
          hook_event_name: 'PreToolUse',
          ...read,
          tool_input: { file_path: '/repo/big.txt' },
        });
        hook({ hook_event_name: 'PostToolUse', ...read, tool_response: 'y'.repeat(40_000) });

        let saved = await sessionFile('conv-reported');
        for (let i = 0; i < 40 && Number(saved?.toolCallCount ?? 0) < 2; i++) {
          await new Promise((r) => setTimeout(r, 250));
          saved = await sessionFile('conv-reported');
        }
        expect(saved?.toolCallCount).toBe(2);
        expect(saved?.estimatedCostUsd).toBeCloseTo(0.0075, 6);
      });
    }, 40000);

    it.each([
      ['only an inherited CURSOR_TRACE_ID', false, {}],
      [
        'an inherited CURSOR_TRACE_ID and a hooks file that runs the collector',
        true,
        {
          '.cursor/hooks.json': {
            hooks: { afterMCPExecution: [{ command: 'preflight-collector' }] },
          },
        },
      ],
    ])(
      'a pending engine with %s lists the tool: %s',
      async (_label, listed, homeFiles) => {
        await withPendingEngine(
          'cursor',
          async (client) => {
            const names = (await client.listTools()).tools.map((t) => t.name);
            expect(names.includes('nr_observe_report_tokens')).toBe(listed);
          },
          { CURSOR_TRACE_ID: 'inherited-from-terminal' },
          homeFiles,
        );
      },
      30000,
    );

    it.each([
      ['cursor', true],
      ['windsurf', true],
      ['antigravity', false],
      ['kiro', false],
      ['zed', false],
      ['claude-code', false],
    ])(
      'a pending %s engine lists the tool: %s',
      async (mcpClient, listed) => {
        await withPendingEngine(mcpClient, async (client) => {
          const names = (await client.listTools()).tools.map((t) => t.name);
          expect(names.includes('nr_observe_report_tokens')).toBe(listed);
        });
      },
      30000,
    );
  });

  it('self-corrects when the pending path resolves via the cwd fallback and a differing PPID breadcrumb appears later', async () => {
    // The pending -> async poller flow (not the eager synchronous one) can
    // also resolve via cwd instead of ppid. Mirrors the provisional-path
    // test above, but supplies only a cwd breadcrumb first — the poller can
    // only resolve via the fallback — then a *different* ppid breadcrumb
    // later, and expects a correction.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-pending-cwd-correction-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-pending-cwd-correction-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await client.connect(transport);

      // Neither CLAUDE_JOB_DIR nor any breadcrumb exists yet — the pending
      // tool set is served immediately (isProvisional === true).
      const pendingTools = await client.listTools();
      expect(pendingTools.tools.map((t) => t.name)).not.toContain('nr_observe_get_session_stats');

      const readSessionId = async (): Promise<string | null> => {
        const tools = await client.listTools();
        if (!tools.tools.map((t) => t.name).includes('nr_observe_get_session_stats')) return null;
        const result = await client.callTool({
          name: 'nr_observe_get_session_stats',
          arguments: {},
        });
        const content = result.content as Array<{ type: string; text: string }>;
        const text = content[0]?.text ?? '{}';
        return (JSON.parse(text) as { session_id: string }).session_id;
      };

      // Supply only the cwd breadcrumb — the poller's ppid check keeps
      // missing, so it must fall back to this.
      const cwdBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-cwd',
      );
      mkdirSync(cwdBreadcrumbDir, { recursive: true });
      const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
      writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-cwd-via-pending');

      let sawStale = false;
      for (let i = 0; i < 20; i++) {
        if ((await readSessionId()) === 'stale-cwd-via-pending') {
          sawStale = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(sawStale).toBe(true);

      // Now supply a *different* ppid breadcrumb — the correction watch
      // should pick it up and re-adopt.
      const ppidBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(resolve(ppidBreadcrumbDir, `${process.pid}.txt`), 'corrected-ppid-via-pending');

      let corrected = false;
      for (let i = 0; i < 20; i++) {
        if ((await readSessionId()) === 'corrected-ppid-via-pending') {
          corrected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(corrected).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('suppresses the periodic checkpoint while a cwd-resolved session id is unconfirmed', async () => {
    // No ppid breadcrumb is ever supplied in this test, so the session stays
    // in the "pending confirmation" state for its whole lifetime — proving
    // the periodic checkpoint interval skips writing under the stale id.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-pending-suppress-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-pending-suppress-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'unconfirmed-cwd-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      // Let several 200ms persist ticks elapse while unconfirmed.
      await new Promise((r) => setTimeout(r, 900));

      const sessionsDir = resolve(tmpStoragePath, 'sessions');
      const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(files.some((f) => f.includes('unconfirmed-cwd-session-id'))).toBe(false);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('resumes periodic checkpointing after the pending-confirmation cap elapses with no correction', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-cap-timeout-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-cap-timeout-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'cap-timeout-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        NR_AI_PENDING_CONFIRMATION_CAP_MS: '500',
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);
      // An idle session is not persisted, so give the checkpoint something to write.
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-5' },
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedFile = resolve(
        tmpStoragePath,
        'sessions',
        `${dateStr}_cap-timeout-session-id.json`,
      );

      let appeared = false;
      for (let i = 0; i < 20; i++) {
        if (existsSync(expectedFile)) {
          appeared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(appeared).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('clears pending confirmation immediately when the PPID breadcrumb confirms the same id as the cwd guess', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-confirmed-same-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-confirmed-same-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'confirmed-same-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        // Deliberately left at the (2-minute) default: if pendingConfirmation
        // only cleared via the cap, the checkpoint below could not appear
        // within this test's short poll window.
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);
      // An idle session is not persisted, so give the checkpoint something to write.
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-5' },
      });

      // The spawned child sees this test process as its ppid — same
      // convention as the existing correction tests.
      const ppidBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(resolve(ppidBreadcrumbDir, `${process.pid}.txt`), 'confirmed-same-session-id');

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedFile = resolve(
        tmpStoragePath,
        'sessions',
        `${dateStr}_confirmed-same-session-id.json`,
      );

      let appeared = false;
      for (let i = 0; i < 20; i++) {
        if (existsSync(expectedFile)) {
          appeared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(appeared).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  describe('seeding a session this process already saved', () => {
    const PPID_WATCH_RESOLVED = 'Resolved corrected session_id from ppid breadcrumb';
    const ADOPTED = 'Session ID resolved, full initialization complete';

    const CHECKPOINTED = 'Session checkpointed';
    const BUDGET_80 = /"pct":80[^\n]*Budget threshold reached/g;
    const SKIPPED_EMPTY = 'Skipping first write of a session with no recorded usage';

    const startedEngines: Engine[] = [];
    const closeStartedEngines = async (): Promise<void> => {
      await Promise.all(startedEngines.splice(0).map((engine) => engine.close().catch(() => {})));
    };
    afterEach(async () => {
      await closeStartedEngines();
    });

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(100);
      }
      return predicate();
    }

    function makeDirs(): { storagePath: string; projectCwd: string; cleanup: () => Promise<void> } {
      const storagePath = mkdtempSync(join(tmpdir(), 'nr-seed-storage-'));
      const projectCwd = mkdtempSync(join(tmpdir(), 'nr-seed-project-'));
      const crumbs = breadcrumbRoot(storagePath, 'claude-code');
      mkdirSync(resolve(crumbs, 'session-by-cwd'), { recursive: true });
      mkdirSync(resolve(crumbs, 'session-by-ppid'), { recursive: true });
      return {
        storagePath,
        projectCwd,
        cleanup: async () => {
          await closeStartedEngines();
          rmSync(storagePath, { recursive: true, force: true });
          rmSync(projectCwd, { recursive: true, force: true });
        },
      };
    }

    function writeCwdBreadcrumb(storagePath: string, projectCwd: string, sessionId: string): void {
      const sanitizedCwd = sanitizeCwdForFilename(realpathSync(projectCwd));
      writeFileSync(
        resolve(
          breadcrumbRoot(storagePath, 'claude-code'),
          'session-by-cwd',
          `${sanitizedCwd}.txt`,
        ),
        sessionId,
      );
    }

    const ppidBreadcrumb = (storagePath: string): string =>
      resolve(breadcrumbRoot(storagePath, 'claude-code'), 'session-by-ppid', `${process.pid}.txt`);

    interface SavedTotals {
      readonly tokensInput: number;
      readonly estimatedCostUsd: number;
      readonly toolCallCount: number;
    }

    function readSaved(storagePath: string, sessionId: string): SavedTotals | null {
      const saved = new SessionStore({ storagePath }).loadSession(sessionId);
      if (!saved) return null;
      return {
        tokensInput: saved.tokensInput,
        estimatedCostUsd: saved.estimatedCostUsd ?? 0,
        toolCallCount: saved.toolCallCount,
      };
    }

    interface Engine {
      logged: (text: string) => Promise<boolean>;
      count: (pattern: RegExp) => number;
      settle: () => Promise<void>;
      reportInputTokens: (inputTokens: number) => Promise<unknown>;
      close: () => Promise<void>;
    }

    async function startEngine(
      storagePath: string,
      projectCwd: string,
      extraEnv: Record<string, string> = {},
    ): Promise<Engine> {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: 'claude-code' };
      delete env.CLAUDE_JOB_DIR;
      const transport = new StdioClientTransport({
        command: 'node',
        args: [resolve(__dirname, '..', 'dist', 'index.js'), '--stdio', '--log-level', 'debug'],
        cwd: projectCwd,
        stderr: 'pipe',
        env: {
          ...env,
          NR_AI_DASHBOARD_PORT: '0',
          NR_AI_MODE: 'local',
          NEW_RELIC_AI_MCP_STORAGE_PATH: storagePath,
          NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
          NR_AI_PENDING_CONFIRMATION_CAP_MS: '500',
          ...extraEnv,
        },
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await connectToConfiguredEngine(client, transport);
      const engine: Engine = {
        logged: (text: string) => waitUntil(() => stderr.includes(text)),
        count: (pattern: RegExp) => stderr.match(pattern)?.length ?? 0,
        settle: async () => {
          const countCheckpoints = (): number => stderr.split(CHECKPOINTED).length - 1;
          const target = countCheckpoints() + 3;
          expect(await waitUntil(() => countCheckpoints() >= target)).toBe(true);
        },
        reportInputTokens: (inputTokens: number) =>
          client.callTool({
            name: 'nr_observe_report_tokens',
            arguments: { input_tokens: inputTokens, output_tokens: 0, model: 'claude-sonnet-5' },
          }),
        close: () => client.close(),
      };
      startedEngines.push(engine);
      return engine;
    }

    async function savePriorSession(
      storagePath: string,
      projectCwd: string,
      sessionId: string,
      inputTokens: number,
    ): Promise<SavedTotals> {
      const prior = await startEngine(storagePath, projectCwd);
      writeFileSync(ppidBreadcrumb(storagePath), sessionId);
      expect(await prior.logged(ADOPTED)).toBe(true);
      await prior.reportInputTokens(inputTokens);
      await prior.close();
      expect(
        await waitUntil(() => readSaved(storagePath, sessionId)?.tokensInput === inputTokens),
      ).toBe(true);
      rmSync(ppidBreadcrumb(storagePath));
      return readSaved(storagePath, sessionId)!;
    }

    async function startGuessedEngineAndCheckpoint(
      storagePath: string,
      projectCwd: string,
      guessId: string,
      inputTokens: number,
    ): Promise<{
      engine: Engine;
      capSaved: SavedTotals;
    }> {
      writeCwdBreadcrumb(storagePath, projectCwd, guessId);
      const engine = await startEngine(storagePath, projectCwd);
      await engine.reportInputTokens(inputTokens);
      expect(
        await waitUntil(() => readSaved(storagePath, guessId)?.tokensInput === inputTokens),
      ).toBe(true);
      return { engine, capSaved: readSaved(storagePath, guessId)! };
    }

    async function confirmViaPpid(
      storagePath: string,
      engine: Engine,
      sessionId: string,
    ): Promise<void> {
      writeFileSync(ppidBreadcrumb(storagePath), sessionId);
      expect(await engine.logged(PPID_WATCH_RESOLVED)).toBe(true);
      await engine.settle();
    }

    it('keeps the saved cost and tokens when the ppid breadcrumb confirms the same id', async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const { engine, capSaved } = await startGuessedEngineAndCheckpoint(
          storagePath,
          projectCwd,
          'guess-confirmed-id',
          1000,
        );
        expect(capSaved.estimatedCostUsd).toBeGreaterThan(0);

        await confirmViaPpid(storagePath, engine, 'guess-confirmed-id');

        expect(readSaved(storagePath, 'guess-confirmed-id')).toEqual(capSaved);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it("keeps another writer's total saved after this engine's skipped first checkpoint", async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      const otherCwd = mkdtempSync(join(tmpdir(), 'nr-seed-other-'));
      try {
        writeCwdBreadcrumb(storagePath, projectCwd, 'skipped-first-id');
        const engine = await startEngine(storagePath, projectCwd);
        expect(await engine.logged(SKIPPED_EMPTY)).toBe(true);

        writeCwdBreadcrumb(storagePath, otherCwd, 'skipped-first-id');
        const other = await startEngine(storagePath, otherCwd);
        await other.reportInputTokens(400);
        expect(
          await waitUntil(() => readSaved(storagePath, 'skipped-first-id')?.tokensInput === 400),
        ).toBe(true);
        await other.close();

        await engine.reportInputTokens(1000);
        expect(
          await waitUntil(() => readSaved(storagePath, 'skipped-first-id')?.tokensInput === 1000),
        ).toBe(true);
        await confirmViaPpid(storagePath, engine, 'skipped-first-id');

        expect(
          await waitUntil(() => readSaved(storagePath, 'skipped-first-id')?.tokensInput === 1400),
        ).toBe(true);
        await engine.settle();
        expect(readSaved(storagePath, 'skipped-first-id')?.tokensInput).toBe(1400);
      } finally {
        rmSync(otherCwd, { recursive: true, force: true });
        await cleanup();
      }
    }, 60000);

    it("folds another writer's earlier total in exactly once", async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'guess-shared-id', 400);
        const { engine, capSaved } = await startGuessedEngineAndCheckpoint(
          storagePath,
          projectCwd,
          'guess-shared-id',
          1000,
        );

        await confirmViaPpid(storagePath, engine, 'guess-shared-id');

        const saved = readSaved(storagePath, 'guess-shared-id')!;
        expect(saved.tokensInput).toBe(1400);
        expect(saved.estimatedCostUsd).toBeCloseTo(
          prior.estimatedCostUsd + capSaved.estimatedCostUsd,
          9,
        );
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it('neither drops nor double counts cost when the ppid breadcrumb corrects the guess', async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'corrected-real-id', 400);
        const { engine, capSaved } = await startGuessedEngineAndCheckpoint(
          storagePath,
          projectCwd,
          'corrected-guess-id',
          1000,
        );

        await confirmViaPpid(storagePath, engine, 'corrected-real-id');
        await engine.reportInputTokens(300);
        expect(
          await waitUntil(() => readSaved(storagePath, 'corrected-real-id')?.tokensInput === 700),
        ).toBe(true);
        await engine.settle();

        const saved = readSaved(storagePath, 'corrected-real-id')!;
        expect(saved.tokensInput).toBe(700);
        expect(saved.estimatedCostUsd).toBeCloseTo(prior.estimatedCostUsd * (700 / 400), 9);
        expect(readSaved(storagePath, 'corrected-guess-id')).toEqual(capSaved);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it('alerts on a budget threshold that prior plus own spend crosses when the ppid breadcrumb confirms the guess', async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'budget-confirmed-id', 400);
        const budgetUsd = prior.estimatedCostUsd / 0.6;
        writeCwdBreadcrumb(storagePath, projectCwd, 'budget-confirmed-id');
        const engine = await startEngine(storagePath, projectCwd, {
          NEW_RELIC_AI_SESSION_BUDGET_USD: String(budgetUsd),
        });
        await engine.reportInputTokens(200);
        expect(engine.count(BUDGET_80)).toBe(0);

        await confirmViaPpid(storagePath, engine, 'budget-confirmed-id');
        appendToHookBuffer(
          resolve(storagePath, 'buffer-budget-confirmed-id.jsonl'),
          JSON.stringify({
            mode: 'token',
            tool: 'copilot-sdk-usage',
            timestamp: Date.now(),
            sessionId: 'budget-confirmed-id',
            messageId: 'msg_trigger',
            model: 'claude-sonnet-5',
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }) + '\n',
        );

        expect(await waitUntil(() => engine.count(BUDGET_80) > 0)).toBe(true);
        await engine.settle();
        expect(engine.count(BUDGET_80)).toBe(1);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    const crossedBudget = (period: string, pct: number): RegExp =>
      new RegExp(`"period":"${period}","pct":${pct}[^\\n]*Budget threshold reached`, 'g');

    function appendTokenEvent(
      storagePath: string,
      sessionId: string,
      messageId: string,
      inputTokens: number,
    ): void {
      appendToHookBuffer(
        resolve(storagePath, `buffer-${sessionId}.jsonl`),
        JSON.stringify({
          mode: 'token',
          tool: 'copilot-sdk-usage',
          timestamp: Date.now(),
          sessionId,
          messageId,
          model: 'claude-sonnet-5',
          inputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }) + '\n',
      );
    }

    // Prior spend is 60% of each budget and this engine adds about 15%: counting
    // each once crosses 50% and not 80%, double counting either crosses 80%, and
    // dropping the prior spend never crosses 50%.
    async function expectPriorAndOwnSpendCountedOnce(engine: Engine): Promise<void> {
      expect(await waitUntil(() => engine.count(crossedBudget('daily', 50)) > 0)).toBe(true);
      expect(await waitUntil(() => engine.count(crossedBudget('weekly', 50)) > 0)).toBe(true);
      await engine.settle();
      expect(engine.count(crossedBudget('daily', 80))).toBe(0);
      expect(engine.count(crossedBudget('weekly', 80))).toBe(0);
    }

    it("counts an adopted session's saved cost once in daily and weekly spend", async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'adopted-budget-id', 400);
        const budgetUsd = String(prior.estimatedCostUsd / 0.6);
        const engine = await startEngine(storagePath, projectCwd, {
          NEW_RELIC_AI_DAILY_BUDGET_USD: budgetUsd,
          NEW_RELIC_AI_WEEKLY_BUDGET_USD: budgetUsd,
        });
        writeFileSync(ppidBreadcrumb(storagePath), 'adopted-budget-id');
        expect(await engine.logged(ADOPTED)).toBe(true);
        appendTokenEvent(storagePath, 'adopted-budget-id', 'msg_after_adopt', 100);

        await expectPriorAndOwnSpendCountedOnce(engine);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it("counts a confirmed cwd guess's saved cost once in daily and weekly spend", async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'guess-budget-id', 400);
        const budgetUsd = String(prior.estimatedCostUsd / 0.6);
        const engine = await startEngine(storagePath, projectCwd, {
          NEW_RELIC_AI_DAILY_BUDGET_USD: budgetUsd,
          NEW_RELIC_AI_WEEKLY_BUDGET_USD: budgetUsd,
          // Keep checkpoints suppressed until the ppid breadcrumb confirms.
          NR_AI_PENDING_CONFIRMATION_CAP_MS: '120000',
        });
        writeCwdBreadcrumb(storagePath, projectCwd, 'guess-budget-id');
        expect(await engine.logged(ADOPTED)).toBe(true);
        appendTokenEvent(storagePath, 'guess-budget-id', 'msg_before_confirm', 50);

        await confirmViaPpid(storagePath, engine, 'guess-budget-id');
        appendTokenEvent(storagePath, 'guess-budget-id', 'msg_after_confirm', 50);

        await expectPriorAndOwnSpendCountedOnce(engine);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it("counts a never-confirmed cwd guess's saved cost once after it checkpoints its own", async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const prior = await savePriorSession(storagePath, projectCwd, 'unconfirmed-budget-id', 400);
        // Prior spend is 30% of each budget and this engine adds 42%: 72% counted
        // once, 42% if the prior is dropped, and 84% if the checkpointed file,
        // which holds the larger of the two, is counted next to the live total.
        const budgetUsd = String(prior.estimatedCostUsd / 0.3);
        writeCwdBreadcrumb(storagePath, projectCwd, 'unconfirmed-budget-id');
        const engine = await startEngine(storagePath, projectCwd, {
          NEW_RELIC_AI_DAILY_BUDGET_USD: budgetUsd,
          NEW_RELIC_AI_WEEKLY_BUDGET_USD: budgetUsd,
        });
        appendTokenEvent(storagePath, 'unconfirmed-budget-id', 'msg_own', 560);
        expect(await waitUntil(() => engine.count(crossedBudget('daily', 50)) > 0)).toBe(true);
        expect(await waitUntil(() => engine.count(crossedBudget('weekly', 50)) > 0)).toBe(true);

        // The cap has expired, so a checkpoint writes the guessed session's file.
        expect(
          await waitUntil(
            () => readSaved(storagePath, 'unconfirmed-budget-id')?.tokensInput === 560,
          ),
        ).toBe(true);
        // Past the 30 s baseline cache, so the next update rereads that file.
        await sleep(31_000);
        appendTokenEvent(storagePath, 'unconfirmed-budget-id', 'msg_after_cache', 1);
        await engine.settle();
        expect(engine.count(crossedBudget('daily', 80))).toBe(0);
        expect(engine.count(crossedBudget('weekly', 80))).toBe(0);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 90000);

    it('keeps the tool calls a provisional engine saved when it adopts their session', async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const engine = await startEngine(storagePath, projectCwd);
        const ts = Date.now();
        const bufferPath = resolve(storagePath, 'buffer-provisional-id.jsonl');
        for (const n of [1, 2]) {
          const base = { tool: 'Bash', timestamp: ts + n, sessionId: 'provisional-id' };
          const toolUseId = `toolu_${n}`;
          appendToHookBuffer(
            bufferPath,
            JSON.stringify({ ...base, mode: 'pre', toolUseId }) + '\n',
          );
          appendToHookBuffer(
            bufferPath,
            JSON.stringify({ ...base, mode: 'post', toolUseId, success: true }) + '\n',
          );
        }
        expect(
          await waitUntil(() => readSaved(storagePath, 'provisional-id')?.toolCallCount === 2),
        ).toBe(true);

        writeFileSync(ppidBreadcrumb(storagePath), 'provisional-id');
        expect(await engine.logged(ADOPTED)).toBe(true);
        await engine.settle();

        expect(readSaved(storagePath, 'provisional-id')?.toolCallCount).toBe(2);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);

    it('keeps the token cost a provisional engine saved when it adopts their session', async () => {
      const { storagePath, projectCwd, cleanup } = makeDirs();
      try {
        const engine = await startEngine(storagePath, projectCwd);
        appendToHookBuffer(
          resolve(storagePath, 'buffer-provisional-cost-id.jsonl'),
          JSON.stringify({
            mode: 'token',
            tool: 'copilot-sdk-usage',
            timestamp: Date.now(),
            sessionId: 'provisional-cost-id',
            messageId: 'msg_rollup',
            model: 'claude-sonnet-5',
            inputTokens: 1000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }) + '\n',
        );
        expect(
          await waitUntil(
            () => readSaved(storagePath, 'provisional-cost-id')?.tokensInput === 1000,
          ),
        ).toBe(true);
        const rollupSaved = readSaved(storagePath, 'provisional-cost-id')!;

        writeFileSync(ppidBreadcrumb(storagePath), 'provisional-cost-id');
        expect(await engine.logged(ADOPTED)).toBe(true);
        await engine.reportInputTokens(500);
        expect(
          await waitUntil(
            () => readSaved(storagePath, 'provisional-cost-id')?.tokensInput === 1500,
          ),
        ).toBe(true);
        await engine.settle();

        const saved = readSaved(storagePath, 'provisional-cost-id')!;
        expect(saved.tokensInput).toBe(1500);
        expect(saved.estimatedCostUsd).toBeCloseTo(rollupSaved.estimatedCostUsd * 1.5, 9);
        await engine.close();
      } finally {
        await cleanup();
      }
    }, 60000);
  });

  // The correction watch reads the parent level only off Linux and Windows,
  // so these skip in CI, which relies on the session-resolver.test.ts cases
  // that inject platform 'darwin'. On a Mac they run the real `ps` lookup.
  const itOffLinux = process.platform === 'linux' || process.platform === 'win32' ? it.skip : it;

  /** Titles itself like npm's `npx` process, then runs its args as a child. */
  const NPM_EXEC_WRAPPER = [
    "process.title = 'npm exec @newrelic/preflight --stdio';",
    "const child = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit' });",
    "for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));",
    "child.on('exit', (code) => process.exit(code ?? 1));",
  ].join('\n');

  /**
   * Starts an engine whose session id is a cwd guess ('neighbour-session-id'),
   * which arms its correction watch. With `viaNpmExec` it runs behind
   * NPM_EXEC_WRAPPER, as an `npx`-launched engine does, so this test process
   * is its parent-of-ppid; otherwise this test process is its ppid.
   * `nodeArgs` go to the engine's own node process, which also pipes its
   * stderr into `stderr()` when they are set.
   */
  async function startCwdGuessedEngine(
    viaNpmExec: boolean,
    options: { readonly nodeArgs?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {},
  ): Promise<{
    readonly storagePath: string;
    readonly ppidBreadcrumbDir: string;
    readonly readSessionId: () => Promise<string>;
    readonly waitForSessionId: (sessionId: string) => Promise<boolean>;
    /**
     * Appends one tool call under `sessionId` to `buffer-<bufferSessionId>.jsonl`
     * (default: the same id) and waits until the engine has drained it.
     */
    readonly drainToolCall: (sessionId: string, bufferSessionId?: string) => Promise<void>;
    /** The engine's stderr so far; empty unless `nodeArgs` were set. */
    readonly stderr: () => string;
    readonly close: () => Promise<void>;
  }> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const storagePath = mkdtempSync(join(tmpdir(), 'nr-ancestor-confirm-storage-'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'nr-ancestor-confirm-project-'));
    const cwdBreadcrumbDir = resolve(breadcrumbRoot(storagePath, 'claude-code'), 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realpathSync(projectCwd).replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'neighbour-session-id');
    const ppidBreadcrumbDir = resolve(
      breadcrumbRoot(storagePath, 'claude-code'),
      'session-by-ppid',
    );
    mkdirSync(ppidBreadcrumbDir, { recursive: true });

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });
    const engineArgs = [...(options.nodeArgs ?? []), binPath, '--stdio'];
    const transport = new StdioClientTransport({
      command: 'node',
      args: viaNpmExec ? ['-e', NPM_EXEC_WRAPPER, '--', ...engineArgs] : engineArgs,
      ...(options.nodeArgs ? { stderr: 'pipe' as const } : {}),
      cwd: projectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: storagePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        ...options.env,
      },
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const cleanup = (): void => {
      rmSync(storagePath, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    };
    try {
      await connectToConfiguredEngine(client, transport);
      // An idle session is not persisted, so give the checkpoint something to write.
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-5' },
      });
    } catch (err) {
      cleanup();
      throw err;
    }

    const readStats = async (): Promise<{ session_id: string; tool_calls: number }> => {
      const result = await client.callTool({ name: 'nr_observe_get_session_stats', arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0]?.text ?? '{}') as { session_id: string; tool_calls: number };
    };
    const readSessionId = async (): Promise<string> => (await readStats()).session_id;
    let toolUseCount = 0;
    return {
      storagePath,
      ppidBreadcrumbDir,
      readSessionId,
      waitForSessionId: async (sessionId) => {
        for (let i = 0; i < 20; i++) {
          if ((await readSessionId()) === sessionId) return true;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      },
      drainToolCall: async (sessionId, bufferSessionId = sessionId) => {
        const before = (await readStats()).tool_calls;
        const toolUseId = `toolu_drain_${++toolUseCount}`;
        const ts = Date.now();
        const bufferPath = resolve(storagePath, `buffer-${bufferSessionId}.jsonl`);
        for (const event of [
          { mode: 'pre', tool: 'Bash', timestamp: ts, sessionId, toolUseId },
          { mode: 'post', tool: 'Bash', timestamp: ts + 1, sessionId, toolUseId, success: true },
        ]) {
          appendToHookBuffer(bufferPath, JSON.stringify(event) + '\n');
        }
        const drained = async (): Promise<boolean> =>
          sessionId === bufferSessionId
            ? (await readStats()).tool_calls > before
            : !existsSync(bufferPath);
        for (let i = 0; i < 100; i++) {
          if (await drained()) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`engine never drained the tool call under ${sessionId}`);
      },
      stderr: () => stderr,
      close: async () => {
        try {
          await client.close();
        } finally {
          cleanup();
        }
      },
    };
  }

  itOffLinux(
    'does not read the parent-of-ppid breadcrumb of an engine its host launched directly (#479)',
    async () => {
      // This engine's ppid is this test process, not an `npm exec` wrapper,
      // so the level above it can hold another host's session: one whose
      // hooks run as that process's children (Copilot in a VS Code extension
      // host shared with the Claude Code extension, say). The id there is
      // ownerless and differs from the cwd guess, so only the gate keeps it
      // from being adopted.
      const engine = await startCwdGuessedEngine(false);
      try {
        writeFileSync(
          resolve(engine.ppidBreadcrumbDir, `${process.ppid}.txt`),
          'copilot-session-id',
        );
        // The watch ticks at most 2s apart.
        await new Promise((r) => setTimeout(r, 3500));
        expect(await engine.readSessionId()).toBe('neighbour-session-id');

        // The host's own breadcrumb still corrects the guess.
        writeFileSync(resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`), 'own-session-id');
        expect(await engine.waitForSessionId('own-session-id')).toBe(true);
      } finally {
        await engine.close();
      }
    },
    30000,
  );

  itOffLinux(
    'corrects a wrong cwd guess from the host breadcrumb behind an npm exec wrapper (#479)',
    async () => {
      // Behind the wrapper the level above ppid is the host that ran npx: this
      // test process. Its breadcrumb naming another session is the correction.
      const engine = await startCwdGuessedEngine(true);
      try {
        writeFileSync(resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`), 'own-session-id');
        expect(await engine.waitForSessionId('own-session-id')).toBe(true);
      } finally {
        await engine.close();
      }
    },
    30000,
  );

  itOffLinux(
    'does not follow the host to a new session once its breadcrumb matched the cwd guess, behind an npm exec wrapper (#479)',
    async () => {
      // The default plugin launch: the cwd guess is right, so the host's slot
      // names it. That is not a confirmation (only our own ppid's breadcrumb
      // is), and a later /clear rewriting the slot is the host switching
      // sessions. Adopting it as a correction would reset the cost trackers
      // but keep the old session's tool calls under the new id.
      const engine = await startCwdGuessedEngine(true);
      try {
        const hostBreadcrumb = resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`);
        writeFileSync(hostBreadcrumb, 'neighbour-session-id');
        // The watch ticks at most 2s apart, and a confirmation would
        // checkpoint within the 200ms persist interval after that.
        await new Promise((r) => setTimeout(r, 3500));
        const dateStr = new Date().toISOString().slice(0, 10);
        expect(
          existsSync(
            resolve(engine.storagePath, 'sessions', `${dateStr}_neighbour-session-id.json`),
          ),
        ).toBe(false);

        writeFileSync(hostBreadcrumb, 'cleared-session-id');
        await new Promise((r) => setTimeout(r, 3500));
        expect(await engine.readSessionId()).toBe('neighbour-session-id');
      } finally {
        await engine.close();
      }
    },
    30000,
  );

  itOffLinux(
    'does not follow the host to a new session after a tool call drained under the cwd guess, behind an npm exec wrapper (#479)',
    async () => {
      // The host's slot names the guess only until its tool call is drained,
      // then a /clear rewrites it, all between two ticks of the watch. The
      // drained tool call is what stops the parent level.
      const engine = await startCwdGuessedEngine(true);
      try {
        // Past the watch's early ticks, which come faster than every 2s.
        await new Promise((r) => setTimeout(r, 4000));
        const hostBreadcrumb = resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`);
        writeFileSync(hostBreadcrumb, 'neighbour-session-id');
        await engine.drainToolCall('neighbour-session-id');
        writeFileSync(hostBreadcrumb, 'cleared-session-id');
        await new Promise((r) => setTimeout(r, 3500));
        expect(await engine.readSessionId()).toBe('neighbour-session-id');
      } finally {
        await engine.close();
      }
    },
    30000,
  );

  itOffLinux(
    'corrects a wrong cwd guess after draining tool calls of the guessed session, behind an npm exec wrapper (#479)',
    async () => {
      // A wrong guess drains the guessed session's tool calls under the
      // guess. They don't stop the host's own breadcrumb correcting it.
      const engine = await startCwdGuessedEngine(true);
      try {
        await engine.drainToolCall('neighbour-session-id');
        writeFileSync(resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`), 'own-session-id');
        expect(await engine.waitForSessionId('own-session-id')).toBe(true);
      } finally {
        await engine.close();
      }
    },
    30000,
  );

  it('reports each tool call drained under the cwd guess to the correction watch, and no other', async () => {
    // The watch acts on that report only off Linux and Windows, so this checks
    // the drain-path wiring itself, on every platform: a loader hook wraps
    // the listener the engine subscribes, and marks each call on stderr.
    // The hook files are fixed text, with no paths or values spliced in: the
    // hook finds the built resolver by its URL suffix, hands its importers the
    // shim, and resolves the shim's own sentinel import to the real module.
    const hookDir = mkdtempSync(join(tmpdir(), 'nr-staleid-activity-hook-'));
    const marker = 'pf-test: staleId activity reported';
    writeFileSync(
      resolve(hookDir, 'session-resolver-shim.mjs'),
      [
        "export * from 'pf-test-real-session-resolver';",
        "import { watchPpidBreadcrumb as realWatch } from 'pf-test-real-session-resolver';",
        'export function watchPpidBreadcrumb(options = {}) {',
        '  const subscribe = options.subscribeToStaleIdActivity;',
        '  if (!subscribe) return realWatch(options);',
        '  return realWatch({',
        '    ...options,',
        '    subscribeToStaleIdActivity: (onActivity) =>',
        "      subscribe(() => { process.stderr.write('pf-test: staleId activity reported\\n'); onActivity(); }),",
        '  });',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      resolve(hookDir, 'hooks.mjs'),
      [
        "const SHIM = new URL('./session-resolver-shim.mjs', import.meta.url).href;",
        'let realUrl;',
        'export async function resolve(specifier, context, next) {',
        "  if (specifier === 'pf-test-real-session-resolver') return { url: realUrl, shortCircuit: true };",
        '  const result = await next(specifier, context);',
        "  if (result.url.endsWith('/dist/hooks/session-resolver.js')) {",
        '    realUrl = result.url;',
        '    return { ...result, url: SHIM, shortCircuit: true };',
        '  }',
        '  return result;',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      resolve(hookDir, 'register.mjs'),
      "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
    );

    let engine: Awaited<ReturnType<typeof startCwdGuessedEngine>> | undefined;
    try {
      engine = await startCwdGuessedEngine(false, {
        nodeArgs: ['--import', pathToFileURL(resolve(hookDir, 'register.mjs')).href],
        env: { NR_AI_PENDING_CONFIRMATION_CAP_MS: '200' },
      });
      const { stderr } = engine;
      const reports = (): number => stderr().split(marker).length - 1;
      const settledReports = async (expected: number): Promise<number> => {
        for (let i = 0; i < 50 && reports() < expected; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return reports();
      };
      // Filed in the guessed session's buffer, but under another session id.
      await engine.drainToolCall('other-session-id', 'neighbour-session-id');
      // No report is due for it; the wait gives a wrong one time to arrive.
      expect(await settledReports(1)).toBe(0);
      await engine.drainToolCall('neighbour-session-id');
      expect(await settledReports(1)).toBe(1);
      const { storagePath } = engine;
      await waitFor(() => savedCalls(storagePath, 'neighbour-session-id') === 2);
    } finally {
      await engine?.close();
      rmSync(hookDir, { recursive: true, force: true });
    }
  }, 30000);

  it('does not follow the host to a new session once its ppid breadcrumb confirmed the cwd guess', async () => {
    // Pins the direct-launch side of the /clear case: the watch resolves on the
    // confirmation and is not re-armed, so a later rewrite of the breadcrumb
    // (the host starting a new session) leaves the engine on the confirmed id.
    const engine = await startCwdGuessedEngine(false);
    try {
      const hostBreadcrumb = resolve(engine.ppidBreadcrumbDir, `${process.pid}.txt`);
      writeFileSync(hostBreadcrumb, 'neighbour-session-id');
      // Confirmation ends checkpoint suppression, so the session file appears.
      const dateStr = new Date().toISOString().slice(0, 10);
      const sessionFile = (id: string): string =>
        resolve(engine.storagePath, 'sessions', `${dateStr}_${id}.json`);
      let confirmed = false;
      for (let i = 0; i < 20 && !confirmed; i++) {
        confirmed = existsSync(sessionFile('neighbour-session-id'));
        if (!confirmed) await new Promise((r) => setTimeout(r, 300));
      }
      expect(confirmed).toBe(true);

      writeFileSync(hostBreadcrumb, 'cleared-session-id');
      await new Promise((r) => setTimeout(r, 3500));
      expect(await engine.readSessionId()).toBe('neighbour-session-id');
      expect(existsSync(sessionFile('cleared-session-id'))).toBe(false);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('resets accumulated cost when the PPID breadcrumb corrects to a different session id', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-cost-reset-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-cost-reset-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-cost-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      // Simulate the wrong-identity backfill: while still on the stale cwd
      // id, real cost gets recorded through the same shared CostTracker the
      // parent-transcript watcher would feed.
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 10000, output_tokens: 2000, model: 'claude-sonnet-5' },
      });

      const readTotalUsd = async (): Promise<number> => {
        const result = await client.callTool({
          name: 'nr_observe_get_cost_breakdown',
          arguments: {},
        });
        const content = result.content as Array<{ type: string; text: string }>;
        const text = content[0]?.text ?? '{}';
        return (JSON.parse(text) as { total_usd: number }).total_usd;
      };

      expect(await readTotalUsd()).toBeGreaterThan(0);

      // Now correct to a different ppid-derived id.
      const ppidBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(resolve(ppidBreadcrumbDir, `${process.pid}.txt`), 'corrected-cost-session-id');

      const readSessionId = async (): Promise<string> => {
        const result = await client.callTool({
          name: 'nr_observe_get_session_stats',
          arguments: {},
        });
        const content = result.content as Array<{ type: string; text: string }>;
        const text = content[0]?.text ?? '{}';
        return (JSON.parse(text) as { session_id: string }).session_id;
      };

      let corrected = false;
      for (let i = 0; i < 20; i++) {
        if ((await readSessionId()) === 'corrected-cost-session-id') {
          corrected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(corrected).toBe(true);
      expect(await readTotalUsd()).toBe(0);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('resumes checkpointing promptly after a real correction, not after the full pending-confirmation cap', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-correction-resume-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-correction-resume-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-resume-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        NR_AI_SESSION_PERSIST_INTERVAL_MS: '200',
        // Left at the 2-minute default deliberately — see the sibling
        // "confirmed same id" test's identical rationale.
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);

      const ppidBreadcrumbDir = resolve(
        breadcrumbRoot(tmpStoragePath, 'claude-code'),
        'session-by-ppid',
      );
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(
        resolve(ppidBreadcrumbDir, `${process.pid}.txt`),
        'corrected-resume-session-id',
      );

      // The correction resets accumulated cost, so usage has to land after it
      // for the corrected session to be worth a checkpoint file.
      let corrected = false;
      for (let i = 0; i < 20 && !corrected; i++) {
        const stats = await client.callTool({
          name: 'nr_observe_get_session_stats',
          arguments: {},
        });
        const text = (stats.content as Array<{ text: string }>)[0]?.text ?? '{}';
        corrected =
          (JSON.parse(text) as { session_id: string }).session_id === 'corrected-resume-session-id';
        if (!corrected) await new Promise((r) => setTimeout(r, 300));
      }
      expect(corrected).toBe(true);
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-5' },
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedFile = resolve(
        tmpStoragePath,
        'sessions',
        `${dateStr}_corrected-resume-session-id.json`,
      );

      let appeared = false;
      for (let i = 0; i < 20; i++) {
        if (existsSync(expectedFile)) {
          appeared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(appeared).toBe(true);

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

  it('still writes the terminal session save on shutdown even while pending confirmation', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-shutdown-pending-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-shutdown-pending-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(
      breadcrumbRoot(tmpStoragePath, 'claude-code'),
      'session-by-cwd',
    );
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'shutdown-pending-session-id');

    const env = envWithoutTerminalPlatform({ MCP_CLIENT: 'claude-code' });

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      cwd: tmpProjectCwd,
      env: {
        ...env,
        NR_AI_DASHBOARD_PORT: '0',
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
        // No ppid breadcrumb is ever supplied, and the cap is left at its
        // 2-minute default, so the session is still pendingConfirmation when
        // we close the client below (which ends the child's stdin and
        // triggers its shutdown handler).
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connectToConfiguredEngine(client, transport);
      // An idle session is not persisted, so give the checkpoint something to write.
      await client.callTool({
        name: 'nr_observe_report_tokens',
        arguments: { input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-5' },
      });

      await client.close();

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedFile = resolve(
        tmpStoragePath,
        'sessions',
        `${dateStr}_shutdown-pending-session-id.json`,
      );

      let appeared = false;
      for (let i = 0; i < 20; i++) {
        if (existsSync(expectedFile)) {
          appeared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(appeared).toBe(true);
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);
});

describe('--local with cloud export configured but no credentials (#479)', () => {
  it('reports the ownerless sessions it drains as unforwarded on /api/health', async () => {
    const { spawn } = await import('node:child_process');
    const { createServer: createNetServer } = await import('node:net');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-local-unfwd-storage-'));
    const tmpConfigDir = mkdtempSync(join(tmpdir(), 'nr-local-unfwd-config-'));
    const configPath = resolve(tmpConfigDir, 'config.json');
    // Cloud export requested, credentials left to the (absent) environment —
    // the dashboard LaunchAgent case.
    writeFileSync(configPath, JSON.stringify({ mode: 'both' }));

    // Ownerless buffers: no active-<id>.pid heartbeat, so --local drains them.
    const sessionIds = ['copilot-orphan-session', 'copilot-orphan-session-2'];
    const ts = Date.now() - 1000;
    for (const sessionId of sessionIds) {
      writeFileSync(
        resolve(tmpStoragePath, `buffer-${sessionId}.jsonl`),
        [
          { mode: 'pre', tool: 'Bash', timestamp: ts, sessionId, toolUseId: 'toolu_1' },
          {
            mode: 'post',
            tool: 'Bash',
            timestamp: ts + 1,
            sessionId,
            toolUseId: 'toolu_1',
            success: true,
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
        { mode: 0o600 },
      );
    }

    const port = await new Promise<number>((resolvePort, reject) => {
      const srv = createNetServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close((err) => (err ? reject(err) : resolvePort(p)));
      });
      srv.on('error', reject);
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      NR_AI_DASHBOARD_PORT: String(port),
      NR_AI_ALERTS_ENABLED: 'false',
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
    };
    delete env.NR_AI_MODE;

    const child = spawn(process.execPath, [binPath, '--local', '--config', configPath], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    try {
      let unforwarded: Record<string, unknown> | undefined;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          const body = (await res.json()) as { unforwardedSessions?: Record<string, unknown> };
          if ((body.unforwardedSessions?.count as number | undefined) === 2) {
            unforwarded = body.unforwardedSessions;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      expect(unforwarded).toMatchObject({
        reason: 'missing-license-key',
        requestedMode: 'both',
        count: 2,
        hint: UNFORWARDED_SESSIONS_HINT,
      });
      expect(unforwarded?.sessions).toEqual(
        expect.arrayContaining(
          sessionIds.map((sessionId) => expect.objectContaining({ sessionId, toolCalls: 1 })),
        ),
      );

      // One warning per session, and the fix-it hint only once, at startup.
      const occurrences = (needle: string): number => stderr.split(needle).length - 1;
      const perSession = 'Session has no owning --stdio engine and is not reaching New Relic';
      const stderrDeadline = Date.now() + 5_000;
      while (occurrences(perSession) < 2 && Date.now() < stderrDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(occurrences(perSession)).toBe(2);
      expect(occurrences(UNFORWARDED_SESSIONS_HINT)).toBe(1);
    } finally {
      child.kill('SIGKILL');
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpConfigDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('--local Today cache savings', () => {
  it('persists the savings of parent and subagent turns so Today matches /api/cost', async () => {
    const { spawn } = await import('node:child_process');
    const { createServer: createNetServer } = await import('node:net');
    const { mkdirSync } = await import('node:fs');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpHome = mkdtempSync(join(tmpdir(), 'nr-local-savings-home-'));
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-local-savings-storage-'));
    const configPath = resolve(tmpStoragePath, 'config.json');
    writeFileSync(configPath, JSON.stringify({ mode: 'local' }));

    const sessionId = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';
    const agentId = 'a1b2c3d4e5f607189';
    const projectDir = resolve(tmpHome, '.claude', 'projects', '-tmp-savings');
    const subagentsDir = resolve(projectDir, sessionId, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const turn = (messageId: string, cacheRead: number, sidechain: boolean): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        ...(sidechain && { agentId }),
        isSidechain: sidechain,
        uuid: `uuid-${messageId}`,
        timestamp: new Date().toISOString(),
        message: {
          id: messageId,
          model: 'claude-sonnet-4-5-20250929',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n';
    writeFileSync(resolve(projectDir, `${sessionId}.jsonl`), turn('msg_parent', 50_000, false));
    writeFileSync(resolve(subagentsDir, `agent-${agentId}.jsonl`), turn('msg_sub', 20_000, true));

    const port = await new Promise<number>((resolvePort, reject) => {
      const srv = createNetServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close((err) => (err ? reject(err) : resolvePort(p)));
      });
      srv.on('error', reject);
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      NR_AI_DASHBOARD_PORT: String(port),
      NR_AI_MODE: 'local',
      NR_AI_ALERTS_ENABLED: 'false',
      NR_AI_SESSION_PERSIST_INTERVAL_MS: '500',
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
    };
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE')) delete env[key];

    const child = spawn(process.execPath, [binPath, '--local', '--config', configPath], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    interface CacheHealthBody {
      cacheHealth?: { totalCacheReadTokens: number; totalSavingsUsd: number };
      cost?: { totalCacheSavingsUsd: number };
    }
    const getJson = async (path: string): Promise<CacheHealthBody> =>
      (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as CacheHealthBody;

    try {
      let cacheHealth: CacheHealthBody['cacheHealth'];
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        try {
          const body = await getJson('/api/sessions/today/aggregate');
          if (body.cacheHealth?.totalCacheReadTokens === 70_000) {
            cacheHealth = body.cacheHealth;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      expect(cacheHealth).toBeDefined();
      const cost = await getJson('/api/cost');
      expect(cost.cost?.totalCacheSavingsUsd).toBeGreaterThan(0);
      expect(cacheHealth?.totalSavingsUsd).toBeCloseTo(cost.cost?.totalCacheSavingsUsd ?? 0, 6);
    } finally {
      child.kill('SIGKILL');
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpStoragePath, { recursive: true, force: true });
    }
  }, 40000);
});

describe('deploy-dashboards/deploy-alerts --staging is hidden from --help', () => {
  async function expectHelpHidesStaging(sub: 'deploy-dashboards' | 'deploy-alerts'): Promise<void> {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        throw new Error(`exit:${_code}`);
      });
    const chunks: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await expect(dispatchSubcommand(['node', 'preflight', sub, '--help'])).rejects.toThrow();
    } finally {
      expect(chunks.join('')).not.toContain('--staging');
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }

  it('deploy-dashboards --help does not list --staging', async () => {
    await expectHelpHidesStaging('deploy-dashboards');
  });

  it('deploy-alerts --help does not list --staging', async () => {
    await expectHelpHidesStaging('deploy-alerts');
  });
});

describe('preflight server subcommand', () => {
  // Not automated: starting the full CLI dispatch (env var wiring, config
  // load, DashboardServer boot, /ingest auth against the real token) is out
  // of scope for this port. Only the Host-header bypass this subcommand
  // relies on is covered by an automated test — 'serverMode accepts a
  // non-loopback Host header...' in dashboard-server.test.ts. Everything
  // else here — including this endpoint — is exercised only by the manual
  // smoke test in docs/homelab.md. it.todo (rather than a placeholder
  // assertion) so this doesn't silently report as a passing test.
  it.todo('responds to GET /api/health with 200');
});

describe('NrIngestManager tier wiring', () => {
  // NrIngestOptions.tiers is optional for backward compatibility, so a site
  // that skipped nrIngestOptionsFromConfig (which carries config.tiers) would
  // compile clean and silently degrade multi-tier routing to single-tier.
  // src/index.privacy.test.ts documents why main()'s branches can't be driven
  // in-process, so this asserts on source.
  it('builds every NrIngestManager from nrIngestOptionsFromConfig', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf-8');

    const constructionSites = source.match(/new NrIngestManager\(\{/g) ?? [];
    const configWirings =
      source.match(
        /new NrIngestManager\(\{\s*\.\.\.(nrIngestOptionsFromConfig\(|configOptions,)/g,
      ) ?? [];

    expect(constructionSites).toHaveLength(3);
    expect(configWirings).toHaveLength(constructionSites.length);
  });
});

describe('--local persisting the sessions it drains', () => {
  it('marks a call counted only for the sessions it could save', async () => {
    const { spawn } = await import('node:child_process');
    const storage = mkdtempSync(join(tmpdir(), 'nr-local-counted-'));
    const sessions = resolve(storage, 'sessions');
    const ts = Date.now() - 2 * 60 * 60 * 1000;
    const date = new Date(ts).toISOString().slice(0, 10);
    for (const sessionId of ['saved-session', 'unsaved-session']) {
      writeFileSync(
        resolve(storage, `buffer-${sessionId}.jsonl`),
        JSON.stringify({
          mode: 'pre',
          tool: 'Read',
          timestamp: ts,
          sessionId,
          toolUseId: `toolu_${sessionId}`,
        }) + '\n',
      );
    }
    mkdirSync(resolve(sessions, `${date}_unsaved-session.json`), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
      NR_AI_DASHBOARD_PORT: '0',
      NR_AI_ALERTS_ENABLED: 'false',
      NR_AI_MODE: 'local',
    };
    const child = spawn(
      process.execPath,
      [resolve(__dirname, '..', 'dist', 'index.js'), '--local'],
      {
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    try {
      for (let i = 0; i < 80 && readdirSync(storage).some((f) => f.startsWith('buffer-')); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
      const counted = resolve(storage, 'counted');
      expect(
        readdirSync(counted).map((f) => [
          f.split('.')[0],
          readFileSync(resolve(counted, f), 'utf-8'),
        ]),
      ).toEqual([['saved-session', '["toolu_saved-session"]']]);
    } finally {
      child.kill('SIGKILL');
      rmSync(storage, { recursive: true, force: true });
    }
  }, 30000);
});

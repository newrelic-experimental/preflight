import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
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
import type { DashboardServer } from './dashboard/dashboard-server.js';
import type { LocalStore } from './storage/index.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from './proxy/index.js';
import type { NrIngestManager } from './transport/nr-ingest.js';

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
  } {
    const gcStaleBreadcrumbs = jest.fn();
    const gcOrphanBuffers = jest.fn();
    const getActiveSessionIdsFromHeartbeats = jest.fn(() => new Set<string>());
    const gcDeadLocalInstances = jest.fn(() => 0);
    const store = {
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
    } as unknown as Parameters<typeof startMaintenanceGc>[0]['liveSessionRegistry'];
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry });
    expect(getLiveSessions).toHaveBeenCalledWith({ includeSynthetic: true });
    const liveArg = gcOrphanBuffers.mock.calls[0]?.[0] as Set<string>;
    expect(liveArg.has('proxy-1234567890')).toBe(true);
    clearInterval(handle);
  });

  it('runs gcDeadLocalInstances as part of the GC pass', () => {
    const { store, gcDeadLocalInstances } = makeLocalStore();
    const handle = startMaintenanceGc({ localStore: store, liveSessionRegistry: undefined });
    expect(gcDeadLocalInstances).toHaveBeenCalledTimes(1);
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

describe('stdio integration', () => {
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
        ...process.env,
        NR_AI_DASHBOARD_PORT: '0',
        CLAUDE_JOB_DIR: tmpJobDir,
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStoragePath,
      },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await client.connect(transport);

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
    const breadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(breadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(breadcrumbDir, `${sanitizedCwd}.txt`), 'resolved-via-cwd-session-id');

    // Sanity check against the real resolver so this test fails loudly (not
    // mysteriously) if the sanitization scheme ever drifts between the
    // collector's write side and resolveFromCwd()'s read side.
    expect(resolveFromCwd(tmpStoragePath, realProjectCwd)).toBe('resolved-via-cwd-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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

      // If the cwd fallback resolved synchronously, the full tool set is
      // registered immediately — no pending-tools window to poll through.
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain('nr_observe_get_session_stats');

      await client.close();
    } finally {
      rmSync(tmpStoragePath, { recursive: true, force: true });
      rmSync(tmpProjectCwd, { recursive: true, force: true });
    }
  }, 30000);

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
    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-cwd-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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

      // Full tool set immediately — confirms this is the synchronous cwd
      // entry point (isProvisional === false), not the pending/async one.
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
      const ppidBreadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
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
    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      const breadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
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

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
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
      const ppidBreadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
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

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'unconfirmed-cwd-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.connect(transport);
      await client.listTools();

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

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'cap-timeout-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.connect(transport);
      await client.listTools();

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

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'confirmed-same-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.connect(transport);
      await client.listTools();

      // The spawned child sees this test process as its ppid — same
      // convention as the existing correction tests.
      const ppidBreadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
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

  it('resets accumulated cost when the PPID breadcrumb corrects to a different session id', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');
    const tmpStoragePath = mkdtempSync(join(tmpdir(), 'nr-cost-reset-storage-'));
    const tmpProjectCwd = mkdtempSync(join(tmpdir(), 'nr-cost-reset-project-'));
    const realProjectCwd = realpathSync(tmpProjectCwd);

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-cost-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.listTools();

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
      const ppidBreadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
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

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'stale-resume-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.connect(transport);
      await client.listTools();

      const ppidBreadcrumbDir = resolve(tmpStoragePath, 'session-by-ppid');
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      writeFileSync(
        resolve(ppidBreadcrumbDir, `${process.pid}.txt`),
        'corrected-resume-session-id',
      );

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

    const cwdBreadcrumbDir = resolve(tmpStoragePath, 'session-by-cwd');
    mkdirSync(cwdBreadcrumbDir, { recursive: true });
    const sanitizedCwd = realProjectCwd.replace(/[\\/:]/g, '-');
    writeFileSync(resolve(cwdBreadcrumbDir, `${sanitizedCwd}.txt`), 'shutdown-pending-session-id');

    const env = { ...process.env };
    delete env.CLAUDE_JOB_DIR;

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
      await client.connect(transport);
      await client.listTools();

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

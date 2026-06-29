import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  parseArgs,
  maskCredential,
  classifyDashboardStartError,
  startDashboardRepoll,
  setupDashboardPostBind,
  getDashboardRepollIntervalMs,
  DEFAULT_DASHBOARD_REPOLL_MS,
} from './index.js';
import type { DashboardServer } from './dashboard/dashboard-server.js';
import type { LocalStore } from './storage/index.js';

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
// Task #13: dashboard ownership re-poll — startDashboardRepoll() +
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

describe('setupDashboardPostBind()', () => {
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
  } {
    const gcStaleBreadcrumbs = jest.fn();
    const gcOrphanBuffers = jest.fn();
    const getActiveSessionIdsFromHeartbeats = jest.fn(() => new Set<string>());
    const store = {
      gcStaleBreadcrumbs,
      gcOrphanBuffers,
      getActiveSessionIdsFromHeartbeats,
    } as unknown as LocalStore;
    return { store, gcStaleBreadcrumbs, gcOrphanBuffers, getActiveSessionIdsFromHeartbeats };
  }

  it('runs a GC pass immediately on bind and returns an unref-able interval', () => {
    const { store, gcStaleBreadcrumbs, gcOrphanBuffers } = makeLocalStore();
    const handle = setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, liveSessionRegistry: undefined, openOnStart: false },
    );
    expect(gcStaleBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(gcOrphanBuffers).toHaveBeenCalledTimes(1);
    expect(typeof (handle as NodeJS.Timeout).unref).toBe('function');
    clearInterval(handle);
  });

  it('schedules subsequent GC passes on the 5-minute interval', () => {
    const { store, gcStaleBreadcrumbs } = makeLocalStore();
    const handle = setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, liveSessionRegistry: undefined, openOnStart: false },
    );
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
    } as unknown as Parameters<typeof setupDashboardPostBind>[1]['liveSessionRegistry'];
    const handle = setupDashboardPostBind(
      { address: '127.0.0.1', port: 7777 },
      { localStore: store, liveSessionRegistry, openOnStart: false },
    );
    const liveArg = gcOrphanBuffers.mock.calls[0]?.[0] as Set<string>;
    expect(liveArg.has('heartbeat-only')).toBe(true);
    expect(liveArg.has('registry-only')).toBe(true);
    clearInterval(handle);
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

  it('on takeover success: clears the interval, runs postBind, calls onTakeover', async () => {
    const start = jest.fn(() => Promise.resolve({ address: '127.0.0.1', port: 7777 }));
    const server = makeServer(start);
    const postBindHandle = setInterval(() => undefined, 10_000);
    postBindHandle.unref?.();
    const postBind = jest.fn((_addr: { address: string; port: number }) => postBindHandle);
    const onTakeover = jest.fn((_handle: NodeJS.Timeout) => undefined);
    const log = silentLogger();

    const handle = startDashboardRepoll({
      dashboardServer: server,
      host: '127.0.0.1',
      port: 7777,
      intervalMs: 50,
      postBind: postBind as Parameters<typeof startDashboardRepoll>[0]['postBind'],
      onTakeover: onTakeover as Parameters<typeof startDashboardRepoll>[0]['onTakeover'],
      logger: log,
    });

    // Drive the timer once and let the awaited start() resolve.
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(postBind).toHaveBeenCalledWith({ address: '127.0.0.1', port: 7777 });
    expect(onTakeover).toHaveBeenCalledWith(postBindHandle);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('taken over'));

    // After takeover the interval should be cleared — advance time and
    // confirm start() is NOT called a second time.
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    clearInterval(handle);
    clearInterval(postBindHandle);
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

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      // NR_AI_DASHBOARD_PORT=0 → OS-assigned ephemeral, so this test is
      // safe to run when port 7777 is occupied (e.g. a developer running
      // their production instance on the same host).
      env: { ...process.env, NR_AI_DASHBOARD_PORT: '0', CLAUDE_JOB_DIR: tmpJobDir },
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
    }
  }, 30000);
});

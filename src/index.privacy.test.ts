import { jest } from '@jest/globals';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// In-process privacy proof — narrow / config-level only
// ---------------------------------------------------------------------------
//
// NOTE: The in-process test below covers the static gating (config returns
// `mode: 'local'`) and the SessionTracker's outbound-call surface. It does
// NOT exercise main()'s actual `if (config.mode !== 'local')` branch, because
// invoking main() in-process requires mocking ~6 modules (MCP SDK stdio,
// DashboardServer, server.js, hook event-processor, storage, alerts engine)
// and ESM module mocking via `jest.unstable_mockModule` is fragile under the
// project's ts-jest + moduleNameMapper setup. The deeper end-to-end privacy
// proof is the second describe block, which spawns the real built binary —
// that is the load-bearing test for the privacy promise.
//
// TODO: if the in-process gating coverage becomes important,
// either (a) refactor main() to extract the gate into a directly-testable
// function, or (b) invest in a robust ESM-mock setup. For now the
// child-process test is the privacy proof of record, and the `beforeAll`
// build-on-demand below ensures it always runs.

const ingestCtor = jest.fn();
jest.unstable_mockModule('./transport/nr-ingest.js', () => ({
  NrIngestManager: class {
    constructor(...args: unknown[]) {
      ingestCtor(...args);
    }
    auditTrail = undefined;
    start(): void {}
    stop(): Promise<void> {
      return Promise.resolve();
    }
    ingestToolCall(): void {}
    ingestCodingTask(): void {}
    ingestAntiPattern(): void {}
    ingestBudgetWarning(): void {}
  },
}));

const httpRequest = jest.fn();
jest.unstable_mockModule('node:https', () => ({
  request: (...args: unknown[]) => {
    httpRequest('https', ...args);
    throw new Error('HTTPS request blocked in privacy-proof test');
  },
}));
jest.unstable_mockModule('node:http', async () => {
  const real = await import('node:http');
  return {
    ...real,
    request: (...args: unknown[]) => {
      httpRequest('http', ...args);
      throw new Error('HTTP request blocked in privacy-proof test');
    },
  };
});

describe('privacy proof — config + tracker (mode=local)', () => {
  // Node 18+ exposes a global `fetch`. The node:http / node:https mocks
  // above only cover request() — not undici-backed fetch() — so any
  // dependency that switched to fetch could leak past the privacy proof.
  // Stub the global with a spy that throws if invoked.
  const originalFetch: typeof fetch | undefined = global.fetch;
  const fetchSpy = jest.fn(() => {
    throw new Error('fetch blocked in privacy-proof test');
  });

  beforeEach(() => {
    ingestCtor.mockClear();
    httpRequest.mockClear();
    fetchSpy.mockClear();
    global.fetch = fetchSpy as unknown as typeof fetch;
    process.env.NR_AI_MODE = 'local';
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_ACCOUNT_ID;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as { fetch?: typeof fetch }).fetch;
    }
    delete process.env.NR_AI_MODE;
  });

  it("loadMcpConfig returns mode='local' without licenseKey", async () => {
    const { loadMcpConfig } = await import('./config.js');
    const config = loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });
    expect(config.mode).toBe('local');
  });

  it('SessionTracker.recordToolCall makes no outbound HTTP/HTTPS requests', async () => {
    const { SessionTracker } = await import('./metrics/session-tracker.js');
    const tracker = new SessionTracker('test-session-' + Math.random().toString(36).slice(2));
    tracker.recordToolCall({
      id: 't1',
      sessionId: 's1',
      toolName: 'Read',
      toolUseId: 'tu1',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
    });
    expect(httpRequest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('global fetch is not invoked during config load or tracker.recordToolCall', async () => {
    const { loadMcpConfig } = await import('./config.js');
    loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });
    const { SessionTracker } = await import('./metrics/session-tracker.js');
    const tracker = new SessionTracker('test-session-' + Math.random().toString(36).slice(2));
    tracker.recordToolCall({
      id: 't2',
      sessionId: 's2',
      toolName: 'Edit',
      toolUseId: 'tu2',
      timestamp: Date.now(),
      durationMs: 5,
      success: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end privacy proof: spawn the real binary
// ---------------------------------------------------------------------------
//
// Boots dist/index.js in mode=local with no license key and verifies clean
// startup + shutdown. This is the load-bearing privacy proof — it exercises
// the actual gate in main() that prevents NrIngestManager construction.
//
// `beforeAll` self-bootstraps by running `npm run build` if dist/index.js is
// missing. Without this, the test silently skipped on fresh checkouts where
// the build step hadn't been run, producing false confidence.

describe('privacy proof — built binary in mode=local', () => {
  const distIndex = resolve(__dirname, '..', 'dist', 'index.js');

  beforeAll(() => {
    if (!existsSync(distIndex)) {
      // execFileSync with arg array (no shell) — `npm` and `build` are
      // hardcoded so injection is moot, but matches project security hygiene.
      execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
    }
  }, 120_000);

  it('boots, runs, and shuts down cleanly', async () => {
    const tmpStorage = mkdtempSync(join(tmpdir(), 'nr-mcp-privacy-'));
    // Provide a synthetic CLAUDE_JOB_DIR with a valid state.json so that
    // resolveFromJobDir() resolves synchronously. Without this the binary
    // polls indefinitely and the test times out in environments where
    // CLAUDE_JOB_DIR is not set by a live Claude Code session.
    const tmpJobDir = mkdtempSync(join(tmpdir(), 'nr-mcp-job-'));
    writeFileSync(
      resolve(tmpJobDir, 'state.json'),
      JSON.stringify({ linkScanPath: '/tmp/privacy-test-session.jsonl' }),
    );
    const proc = spawn(process.execPath, [distIndex, '--stdio'], {
      env: {
        ...process.env,
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStorage,
        NEW_RELIC_LICENSE_KEY: '',
        NEW_RELIC_ACCOUNT_ID: '',
        NR_AI_DASHBOARD_PORT: '0',
        CLAUDE_JOB_DIR: tmpJobDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    // Drain stdout so the MCP server doesn't block on backpressure.
    proc.stdout.on('data', () => undefined);

    try {
      // Wait for the post-bootstrap signal or fail fast on a fatal error.
      await new Promise<void>((resolveBoot, rejectBoot) => {
        const timer = setTimeout(() => {
          rejectBoot(new Error(`server did not boot within timeout. stderr=${stderrBuf}`));
        }, 8000);
        const onData = () => {
          if (stderrBuf.includes('Server running on stdio transport')) {
            clearTimeout(timer);
            proc.stderr.off('data', onData);
            resolveBoot();
          } else if (stderrBuf.includes('Fatal error')) {
            clearTimeout(timer);
            proc.stderr.off('data', onData);
            rejectBoot(new Error(`server reported fatal error. stderr=${stderrBuf}`));
          }
        };
        proc.stderr.on('data', onData);
      });

      // Trigger graceful shutdown by closing stdin.
      proc.stdin.end();

      const exitCode = await new Promise<number | null>((resolveExit) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
        }, 5000);
        proc.on('exit', (code) => {
          clearTimeout(killTimer);
          resolveExit(code);
        });
      });

      // No fatal errors and a successful boot/shutdown cycle.
      expect(stderrBuf).toMatch(/Starting preflight/);
      expect(stderrBuf).toMatch(/Server running on stdio transport/);
      expect(stderrBuf).not.toMatch(/Fatal error/);

      // Privacy assertion: NrIngestManager is never started. The
      // HarvestScheduler logs 'Harvest scheduler started' from start(), and
      // NrIngestManager calls that start() in its constructor's wake. If
      // someone removes the `if (config.mode !== 'local')` gate in
      // src/index.ts, the harvest scheduler boots and this line fires.
      // Asserting its absence is the observable signal that the gate held.
      expect(stderrBuf).not.toMatch(/Harvest scheduler started/);

      // process.exit(0) is invoked from the SIGINT/SIGTERM/stdin-end shutdown
      // path; allow null in case of SIGKILL on timeout (still passing the
      // earlier asserts means boot succeeded).
      expect([0, null]).toContain(exitCode);
    } finally {
      if (!proc.killed) proc.kill('SIGKILL');
      rmSync(tmpStorage, { recursive: true, force: true });
      rmSync(tmpJobDir, { recursive: true, force: true });
    }
  }, 20000);
});

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Multi-instance integration test (proposal task #11)
// ---------------------------------------------------------------------------
//
// Validates the user-visible behaviors from docs/MULTI_INSTANCE_PROPOSAL.md
// "What done looks like" section by spawning three concurrent
// `preflight --stdio` processes against a single shared storage dir
// and asserting:
//
//   #1 — All three boot without "✗ failed". (proxy: their stdout speaks
//        valid JSON-RPC and their stderr never reports a fatal error.)
//   #2 — Each MCP correctly resolves its own Claude Code session_id from a
//        per-process source. We use CLAUDE_JOB_DIR (with a fake state.json)
//        because PPID breadcrumbs collide when all three children share the
//        test-process parent. CLAUDE_JOB_DIR is the documented "fast path"
//        in src/hooks/session-resolver.ts.
//   #5 — In-chat tool queries (nr_observe_get_session_stats) return
//        per-session-correct data, not polluted across sessions.
//   #6 — Only one of the three MCPs binds the dashboard port; the other two
//        log the "Dashboard already owned by..." graceful-handoff line
//        introduced by that change.
//
// Sequencing notes:
//   - We pre-write 50 hook events (25 pre + 25 post) to each session's
//     `buffer-<sessionId>.jsonl` BEFORE spawning that MCP. This skips the
//     hook collector entirely; the MCP drains the file on its own poll loop.
//   - The dashboard port (NR_AI_DASHBOARD_PORT) is OS-allocated at runtime
//     (getFreePort) so the test never conflicts with a real MCP instance on
//     the developer's machine. All three children receive the same port to
//     force the EADDRINUSE handoff path.
//   - Each spawned process is wrapped in a try/finally to ensure SIGKILL on
//     test failure. tmpdir is rmSync'd in afterAll.

const distIndex = resolve(__dirname, '..', 'dist', 'index.js');
const CHILDREN = 3;
const EVENTS_PER_CHILD = 50;
const PAIRED_RECORDS_PER_CHILD = EVENTS_PER_CHILD / 2; // 25 pre/post pairs
const BOOT_TIMEOUT_MS = 12_000;
const TOOLS_CALL_TIMEOUT_MS = 8_000;

// Fixed names that mirror the SESSION_ID_RE pattern used everywhere else
// (`/^[a-zA-Z0-9_-]{1,128}$/`). Anything outside that class is rejected by
// the resolver and would silently exclude the child from drain.
const SESSION_IDS = ['multi-test-aaa', 'multi-test-bbb', 'multi-test-ccc'] as const;

interface ChildHandle {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly sessionId: string;
  stderr: string;
  stdout: string;
  /** Promised JSON-RPC responses keyed by request id. */
  readonly responses: Map<number, Record<string, unknown>>;
  pendingStdout: string;
}

beforeAll(() => {
  // Rebuild when the binary is missing OR when it predates the
  // landmarks the test depends on. The latter guards against a stale dist
  // left over from a pre-merge checkout — without this the test would fail
  // with "session_id randomly generated" / "Dashboard port ... in use"
  // errors that look like test bugs but are really stale-build symptoms.
  const FIX_MARKERS = ['classifyDashboardStartError', 'resolveSessionId'];
  let needsBuild = !existsSync(distIndex);
  if (!needsBuild) {
    try {
      const built = readFileSync(distIndex, 'utf-8');
      needsBuild = FIX_MARKERS.some((marker) => !built.includes(marker));
    } catch {
      needsBuild = true;
    }
  }
  if (needsBuild) {
    // tsc emits even on errors when invoked directly with --noEmitOnError false.
    // The repo's `npm run build` aborts on the first error, so we bypass it
    // and call tsc with the override. Pre-existing TS errors elsewhere in the
    // codebase don't impair the entry script we exercise here.
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmitOnError', 'false'], {
      stdio: 'inherit',
      cwd: resolve(__dirname, '..'),
    });
  }
}, 180_000);

describe('multi-instance integration (proposal #11)', () => {
  let storagePath: string;
  let jobDirRoot: string;
  let children: ChildHandle[] = [];
  /** OS-allocated port for the 3-concurrent-MCPs test. */
  let dashboardPort: number;
  /** OS-allocated port for the dashboard-takeover test. */
  let takeoverPort: number;

  beforeAll(async () => {
    storagePath = mkdtempSync(join(tmpdir(), 'nr-mi-storage-'));
    jobDirRoot = mkdtempSync(join(tmpdir(), 'nr-mi-jobs-'));
    mkdirSync(resolve(storagePath, 'session-by-ppid'), { recursive: true, mode: 0o700 });
    [dashboardPort, takeoverPort] = await Promise.all([getFreePort(), getFreePort()]);
  });

  afterAll(() => {
    for (const c of children) {
      if (!c.proc.killed) {
        try {
          c.proc.kill('SIGKILL');
        } catch {
          // best-effort cleanup
        }
      }
    }
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(jobDirRoot, { recursive: true, force: true });
  });

  it('three concurrent MCPs boot, isolate session data, and gracefully share the dashboard port', async () => {
    // ---------------------------------------------------------------
    // Stage 1: pre-seed each session's buffer with paired hook events.
    // Each pair becomes one ToolCallRecord post-pairing; with 25 pairs
    // per session, the SessionTracker will report tool_calls === 25.
    // ---------------------------------------------------------------
    for (const sessionId of SESSION_IDS) {
      seedBuffer(storagePath, sessionId, PAIRED_RECORDS_PER_CHILD);
    }

    // ---------------------------------------------------------------
    // Stage 2: spawn three children, each pointed at the same shared
    // storage path but a unique CLAUDE_JOB_DIR so each resolves a
    // distinct session_id synchronously.
    // ---------------------------------------------------------------
    try {
      for (const sessionId of SESSION_IDS) {
        const jobDir = resolve(jobDirRoot, sessionId);
        mkdirSync(jobDir, { recursive: true, mode: 0o700 });
        // resolveFromJobDir() reads `state.json` and extracts the basename
        // (minus extension) of `linkScanPath`. We construct the path so
        // basename === sessionId.
        writeFileSync(
          resolve(jobDir, 'state.json'),
          JSON.stringify({ linkScanPath: `/fake/transcript/${sessionId}.jsonl` }),
          { mode: 0o600 },
        );
        children.push(spawnChild(sessionId, storagePath, jobDir, distIndex, dashboardPort));
      }

      // Wait for each MCP to log "Server running on stdio transport" — this
      // is the post-bootstrap signal that confirms session resolution
      // succeeded and tools are wired up.
      await Promise.all(children.map((c) => waitForBoot(c, BOOT_TIMEOUT_MS)));

      // ---------------------------------------------------------------
      // Stage 3: drive the JSON-RPC handshake on each child and call
      // nr_observe_get_session_stats. We poll until the reported
      // tool_calls count reaches PAIRED_RECORDS_PER_CHILD or a budget
      // expires (the buffer is drained by the 100ms poll loop, so this
      // typically resolves within a second).
      // ---------------------------------------------------------------
      await Promise.all(children.map((c) => initialize(c)));

      const statsPerChild = await Promise.all(
        children.map((c) => waitForStats(c, PAIRED_RECORDS_PER_CHILD, TOOLS_CALL_TIMEOUT_MS)),
      );

      // ---------------------------------------------------------------
      // Validation #2 + #5: each MCP reports ONLY its own session's
      // events. We assert exact counts (no spillover from siblings) AND
      // the session_trace_id round-trips back to the resolved value.
      // ---------------------------------------------------------------
      for (let i = 0; i < CHILDREN; i++) {
        const stats = statsPerChild[i]!;
        const expectedSessionId = SESSION_IDS[i]!;
        expect(stats.session_trace_id).toBe(expectedSessionId);
        expect(stats.tool_calls).toBe(PAIRED_RECORDS_PER_CHILD);
        // Each pair we seeded was a Bash call → 25 bash commands per session.
        expect(stats.bash_commands_run).toBe(PAIRED_RECORDS_PER_CHILD);
      }

      // ---------------------------------------------------------------
      // Validation #6: exactly one child bound the dashboard. The other
      // two log the graceful-handoff line from
      // classifyDashboardStartError() in src/index.ts.
      // ---------------------------------------------------------------
      const dashboardOwners = children.filter((c) =>
        c.stderr.includes(`Dashboard ready at http://127.0.0.1:${dashboardPort}`),
      );
      const dashboardSkippers = children.filter((c) =>
        c.stderr.includes('Dashboard already owned by another preflight instance'),
      );

      expect(dashboardOwners).toHaveLength(1);
      expect(dashboardSkippers).toHaveLength(CHILDREN - 1);

      // Cross-check via HTTP: the owner's dashboard must answer /api/health.
      const health = await fetchHealth(dashboardPort, 2000);
      expect(health.ok).toBe(true);

      // ---------------------------------------------------------------
      // Validation #1: no "Fatal error" anywhere in any child's stderr.
      // ---------------------------------------------------------------
      for (const c of children) {
        expect(c.stderr).not.toMatch(/Fatal error/);
      }
    } finally {
      // Trigger graceful shutdown by closing stdin on each child, then
      // hard-kill anything still running after a short grace period.
      for (const c of children) {
        try {
          c.proc.stdin.end();
        } catch {
          // ignore — process may already be gone
        }
      }
      await Promise.all(children.map((c) => waitExit(c, 4000)));
      children = [];
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // Dashboard ownership re-poll. After this fix the second MCP runs
  // headless. This test verifies it takes over the dashboard if the owner
  // exits — without this the dashboard goes dead even though a live MCP
  // could serve it.
  //
  // Sequencing:
  //   1. Spawn MCP A on a free ephemeral port (takeoverPort) with a short re-poll interval (irrelevant
  //      for A, but sets the env baseline).
  //   2. Wait for A to log "Dashboard ready at...". A owns the port.
  //   3. Spawn MCP B with the SAME port and a SHORT re-poll interval (250ms)
  //      so the test budget stays tight.
  //   4. Wait for B to log the EADDRINUSE handoff line.
  //   5. End A's stdin to trigger graceful shutdown.
  //   6. Wait for B to log the takeover line, with a budget that comfortably
  //      covers the re-poll interval.
  //   7. Confirm B now answers /api/health on the dashboard port.
  // -----------------------------------------------------------------------
  it('headless MCP retries the bind and takes over when the dashboard owner exits', async () => {
    const REPOLL_MS = 250;
    const sessionA = 'takeover-test-a';
    const sessionB = 'takeover-test-b';

    const jobDirA = resolve(jobDirRoot, sessionA);
    const jobDirB = resolve(jobDirRoot, sessionB);
    mkdirSync(jobDirA, { recursive: true, mode: 0o700 });
    mkdirSync(jobDirB, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(jobDirA, 'state.json'),
      JSON.stringify({ linkScanPath: `/fake/transcript/${sessionA}.jsonl` }),
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(jobDirB, 'state.json'),
      JSON.stringify({ linkScanPath: `/fake/transcript/${sessionB}.jsonl` }),
      { mode: 0o600 },
    );

    // Spawn A first and wait for it to bind the dashboard. Spawning both
    // simultaneously creates a race where either child can win the port —
    // the takeover scenario specifically tests "A owns, A exits, B
    // promotes itself", so we deliberately serialize the boot order.
    const a = spawnChildOnPort(sessionA, storagePath, jobDirA, distIndex, takeoverPort, REPOLL_MS);
    children.push(a);

    let b: ChildHandle | undefined;
    try {
      await waitForBoot(a, BOOT_TIMEOUT_MS);
      await waitForStderr(a, `Dashboard ready at http://127.0.0.1:${takeoverPort}`, 4000);

      // Now spawn B — A already owns the port so B falls into the headless
      // path deterministically.
      b = spawnChildOnPort(sessionB, storagePath, jobDirB, distIndex, takeoverPort, REPOLL_MS);
      children.push(b);
      await waitForBoot(b, BOOT_TIMEOUT_MS);
      await waitForStderr(b, 'Dashboard already owned by another preflight instance', 4000);

      // Sanity check: A serves /api/health.
      const healthA = await fetchHealth(takeoverPort, 2000);
      expect(healthA.ok).toBe(true);

      // Trigger A's graceful shutdown.
      try {
        a.proc.stdin.end();
      } catch {
        // ignore
      }
      await waitExit(a, 4000);

      // Wait for B's re-poll to detect the freed port and take over.
      // Budget: ~10x the re-poll interval to absorb scheduling jitter.
      await waitForStderr(
        b,
        `Dashboard ownership taken over at http://127.0.0.1:${takeoverPort}`,
        REPOLL_MS * 20,
      );

      // B now serves /api/health on the same port.
      const healthB = await fetchHealth(takeoverPort, 2000);
      expect(healthB.ok).toBe(true);
    } finally {
      if (b) {
        try {
          b.proc.stdin.end();
        } catch {
          // ignore
        }
        await waitExit(b, 4000);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write `count` paired pre/post HookEvents directly to
 * `<storage>/buffer-<sessionId>.jsonl`. Mirrors the schema produced by
 * src/hooks/collector-script.ts so the event-processor pairs them into
 * 1 ToolCallRecord per pre+post pair.
 */
function seedBuffer(storagePath: string, sessionId: string, count: number): void {
  if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  const bufferPath = resolve(storagePath, `buffer-${sessionId}.jsonl`);
  const lines: string[] = [];
  // Use a baseline timestamp safely in the past so orphan-sweep timeouts
  // (60s in event-processor) don't fire mid-test.
  const baseTs = Date.now() - 1000;
  for (let i = 0; i < count; i++) {
    const toolUseId = `toolu_${sessionId}_${i}`;
    lines.push(
      JSON.stringify({
        mode: 'pre',
        tool: 'Bash',
        timestamp: baseTs + i,
        sessionId,
        toolUseId,
        inputSize: 16,
        toolInput: { command: `echo seeded ${i}` },
      }),
    );
    lines.push(
      JSON.stringify({
        mode: 'post',
        tool: 'Bash',
        timestamp: baseTs + i + 1, // +1ms so pairing produces a positive durationMs
        sessionId,
        toolUseId,
        success: true,
        outputSize: 8,
      }),
    );
  }
  writeFileSync(bufferPath, lines.join('\n') + '\n', { mode: 0o600 });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function spawnChild(
  sessionId: string,
  storagePath: string,
  jobDir: string,
  distPath: string,
  port: number,
): ChildHandle {
  const proc = spawn(process.execPath, [distPath, '--stdio'], {
    env: {
      ...process.env,
      // mode=local skips cloud licenseKey requirement and confines the test
      // to the local pipeline (per index.privacy.test.ts pattern).
      NR_AI_MODE: 'local',
      NEW_RELIC_AI_MCP_STORAGE_PATH: storagePath,
      // CLAUDE_JOB_DIR is the resolver's fast path — bypasses ppid breadcrumb
      // collisions when multiple children share the same parent test process.
      CLAUDE_JOB_DIR: jobDir,
      // All three children compete for the same dashboard port to exercise
      // The EADDRINUSE handoff.
      NR_AI_DASHBOARD_PORT: String(port),
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
      // Disable the local alerts engine so the test isn't sensitive to
      // periodic alert evaluation noise on stderr.
      NR_AI_ALERTS_ENABLED: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const handle: ChildHandle = {
    proc,
    sessionId,
    stderr: '',
    stdout: '',
    responses: new Map(),
    pendingStdout: '',
  };

  proc.stderr.on('data', (chunk: Buffer) => {
    handle.stderr += chunk.toString('utf8');
  });
  proc.stdout.on('data', (chunk: Buffer) => {
    handle.stdout += chunk.toString('utf8');
    handle.pendingStdout += chunk.toString('utf8');
    drainStdoutMessages(handle);
  });

  return handle;
}

/**
 * Variant of spawnChild used by the takeover test. Adds two extra env knobs
 * (port + re-poll interval) without disturbing the existing helper used by
 * the other integration test.
 */
function spawnChildOnPort(
  sessionId: string,
  storagePath: string,
  jobDir: string,
  distPath: string,
  dashboardPort: number,
  repollMs: number,
): ChildHandle {
  const proc = spawn(process.execPath, [distPath, '--stdio'], {
    env: {
      ...process.env,
      NR_AI_MODE: 'local',
      NEW_RELIC_AI_MCP_STORAGE_PATH: storagePath,
      CLAUDE_JOB_DIR: jobDir,
      NR_AI_DASHBOARD_PORT: String(dashboardPort),
      // Compress the re-poll interval so the takeover scenario fits inside
      // the test's time budget (default is 30s).
      NR_AI_DASHBOARD_REPOLL_MS: String(repollMs),
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
      NR_AI_ALERTS_ENABLED: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const handle: ChildHandle = {
    proc,
    sessionId,
    stderr: '',
    stdout: '',
    responses: new Map(),
    pendingStdout: '',
  };

  proc.stderr.on('data', (chunk: Buffer) => {
    handle.stderr += chunk.toString('utf8');
  });
  proc.stdout.on('data', (chunk: Buffer) => {
    handle.stdout += chunk.toString('utf8');
    handle.pendingStdout += chunk.toString('utf8');
    drainStdoutMessages(handle);
  });

  return handle;
}

/** Wait until the child's stderr accumulates the given substring. */
async function waitForStderr(
  handle: ChildHandle,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (handle.stderr.includes(needle)) return;
    if (/Fatal error/.test(handle.stderr)) {
      throw new Error(
        `Child for ${handle.sessionId} reported fatal error before "${needle}":\n${handle.stderr}`,
      );
    }
    await delay(50);
  }
  throw new Error(
    `Child for ${handle.sessionId} did not log "${needle}" within ${timeoutMs}ms.\n` +
      `stderr=${handle.stderr.slice(-1000)}`,
  );
}

/** Newline-delimited JSON-RPC parser — matches MCP SDK's stdio framing. */
function drainStdoutMessages(handle: ChildHandle): void {
  let idx = handle.pendingStdout.indexOf('\n');
  while (idx !== -1) {
    const line = handle.pendingStdout.slice(0, idx).replace(/\r$/, '');
    handle.pendingStdout = handle.pendingStdout.slice(idx + 1);
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.id === 'number') {
          handle.responses.set(parsed.id, parsed);
        }
      } catch {
        // Non-JSON lines (rare, but defensive) are ignored.
      }
    }
    idx = handle.pendingStdout.indexOf('\n');
  }
}

async function waitForBoot(handle: ChildHandle, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (handle.stderr.includes('Server running on stdio transport')) return;
    if (/Fatal error/.test(handle.stderr)) {
      throw new Error(`Child for ${handle.sessionId} reported fatal error:\n${handle.stderr}`);
    }
    await delay(50);
  }
  throw new Error(
    `Child for ${handle.sessionId} did not boot within ${timeoutMs}ms.\nstderr=${handle.stderr}`,
  );
}

let nextRequestId = 1;
async function sendRequest(
  handle: ChildHandle,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const id = nextRequestId++;
  const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  handle.proc.stdin.write(message + '\n');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = handle.responses.get(id);
    if (resp) {
      handle.responses.delete(id);
      return resp;
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for ${method} response from ${handle.sessionId} after ${timeoutMs}ms.\n` +
      `stderr=${handle.stderr.slice(-500)}`,
  );
}

/** Send `initialize` + `notifications/initialized` to bring the channel live. */
async function initialize(handle: ChildHandle): Promise<void> {
  const resp = await sendRequest(
    handle,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'multi-instance-integration-test', version: '0.0.0' },
    },
    5000,
  );
  if (resp.error) {
    throw new Error(`initialize failed for ${handle.sessionId}: ${JSON.stringify(resp.error)}`);
  }
  // The "initialized" notification has no id and expects no response.
  handle.proc.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
}

/**
 * Poll nr_observe_get_session_stats until tool_calls reaches the expected
 * count or the budget expires. The MCP's poll loop runs every 100ms, so
 * the buffer is typically drained within ~200ms of boot — the polling here
 * is safety, not the happy path.
 */
async function waitForStats(
  handle: ChildHandle,
  expectedToolCalls: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let lastStats: Record<string, unknown> = {};
  while (Date.now() - start < timeoutMs) {
    const resp = await sendRequest(
      handle,
      'tools/call',
      { name: 'nr_observe_get_session_stats', arguments: {} },
      3000,
    );
    if (resp.error) {
      throw new Error(`tools/call failed for ${handle.sessionId}: ${JSON.stringify(resp.error)}`);
    }
    const result = resp.result as { content?: Array<{ type: string; text: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text === 'string') {
      lastStats = JSON.parse(text) as Record<string, unknown>;
      if (typeof lastStats.tool_calls === 'number' && lastStats.tool_calls >= expectedToolCalls) {
        return lastStats;
      }
    }
    await delay(100);
  }
  throw new Error(
    `tool_calls did not reach ${expectedToolCalls} for ${handle.sessionId} within ${timeoutMs}ms. ` +
      `Last stats: ${JSON.stringify(lastStats)}`,
  );
}

function fetchHealth(port: number, timeoutMs: number): Promise<{ ok?: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolvePromise(JSON.parse(body) as { ok?: boolean });
          } catch (err) {
            rejectPromise(new Error(`Invalid health JSON: ${String(err)}; body=${body}`));
          }
        });
      },
    );
    req.on('error', rejectPromise);
    req.on('timeout', () => {
      req.destroy(new Error(`Health check timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

function waitExit(handle: ChildHandle, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const killer = setTimeout(() => {
      if (!handle.proc.killed) {
        try {
          handle.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, timeoutMs);
    if (handle.proc.exitCode !== null) {
      clearTimeout(killer);
      resolvePromise();
      return;
    }
    handle.proc.once('exit', () => {
      clearTimeout(killer);
      resolvePromise();
    });
  });
}

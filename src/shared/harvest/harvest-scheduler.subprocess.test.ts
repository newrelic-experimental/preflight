import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Subprocess smoke test for the `unref()` +
// `beforeExit` flush. Fake timers and ts-jest cannot simulate Node's real
// process-exit semantics, so we spawn a real Node process that runs the
// COMPILED scheduler from `dist/`, lets it exit naturally, and asserts the
// `beforeExit` handler flushed the buffered events before the process
// terminated. The fixture writes each flushed event as a JSON line to a
// tmp file we then read here.
//
// The fixture imports `dist/harvest/harvest-scheduler.js`. If `dist/`
// hasn't been built (e.g. someone ran `npm test` directly on a fresh
// clone), we skip with a descriptive message rather than fail — `npm
// run prepublishOnly` and CI both build before testing, so the smoke
// test runs there.

const projectRoot = resolve(__dirname, '..', '..');
const distSchedulerPath = resolve(projectRoot, 'dist', 'harvest', 'harvest-scheduler.js');
const fixturePath = resolve(
  projectRoot,
  'src',
  'harvest',
  '__fixtures__',
  'subprocess-exit-fixture.mjs',
);

const distExists = existsSync(distSchedulerPath);
const describeIfBuilt = distExists ? describe : describe.skip;

describeIfBuilt('HarvestScheduler subprocess smoke', () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nr-ai-shared-subprocess-'));
    outputPath = join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flushes buffered events on natural process exit via unref() + beforeExit', async () => {
    // Spawn a real Node process that runs the compiled scheduler with
    // `allowProcessExit: true`, adds three events, and lets the script
    // finish. The unref'd intervals stop holding the loop open; the loop
    // drains; Node fires `beforeExit`; the registered handler calls
    // `void scheduler.stop()`; `stop()`'s final flush invokes the test
    // `sendEventsFn` which appends each event as a JSON line to
    // `outputPath`. Total wall-clock budget: ~5s on a cold cache.
    const child = spawn(process.execPath, [fixturePath, outputPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode: number = await new Promise<number>((resolveExit, rejectExit) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectExit(
          new Error(
            `Subprocess did not exit within 10s. The unref()'d intervals may ` +
              `not be allowing the event loop to drain, or beforeExit's async ` +
              `work is not completing. stderr: ${stderr}`,
          ),
        );
      }, 10_000);

      child.on('exit', (code) => {
        clearTimeout(killTimer);
        resolveExit(code ?? -1);
      });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        rejectExit(err);
      });
    });

    expect(exitCode).toBe(0);

    // Each flushed event is one JSON line. We expect all three buffered
    // events to be present — proving (a) the unref'd intervals didn't
    // hold the loop open past the script body (so beforeExit got a
    // chance to fire) and (b) beforeExit's `void scheduler.stop()` had
    // enough time to complete its final harvestEvents call before Node
    // tore down the process.
    const fileContents = readFileSync(outputPath, 'utf8').trim();
    const lines = fileContents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);

    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toEqual([
      expect.objectContaining({ eventType: 'AiToolCall', marker: 'a' }),
      expect.objectContaining({ eventType: 'AiAntiPattern', marker: 'b' }),
      expect.objectContaining({ eventType: 'AiCodingTask', marker: 'c' }),
    ]);
  }, 20_000);
});

if (!distExists) {
  // Surface a one-line skip notice during normal `npm test` runs so the
  // reason is obvious. Run `npm run build` (or `npm run prepublishOnly`)
  // before re-running tests to exercise this smoke test.
  console.warn(
    `Subprocess smoke test skipped: dist/ not built. ` + `Run \`npm run build\` first to enable.`,
  );
}

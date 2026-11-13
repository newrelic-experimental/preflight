// Fixture for CODE_REVIEW §9.3: subprocess smoke test of the §4.12 fix
// (`unref()` + `beforeExit` flush). Run by `harvest-scheduler.subprocess.test.ts`.
//
// Imports the COMPILED scheduler from `dist/` because the test exercises
// behavior that depends on Node's actual process-exit semantics — fake
// timers and ts-jest cannot simulate that. The fixture creates a scheduler
// with `allowProcessExit: true` and a sendEventsFn that appends each
// flushed event as a JSON line to the path passed via argv[2].
//
// Long harvest intervals are chosen deliberately so the periodic tick
// CANNOT fire before the script finishes its synchronous body; this
// guarantees the events we observe in the output file came through the
// `beforeExit` path, not the regular interval. After the top-level body
// returns, the unref'd intervals stop holding the loop open, the loop
// drains, Node fires `beforeExit`, the registered handler runs
// `void scheduler.stop()`, and `stop()`'s final `harvestEvents()` calls
// `sendEventsFn` with the buffered events.

import { writeFileSync, appendFileSync } from 'node:fs';
import { HarvestScheduler } from '../../../dist/harvest/harvest-scheduler.js';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: subprocess-exit-fixture.mjs <output-path>');
  process.exit(2);
}

// Truncate / create the output file so the test starts from a known state.
writeFileSync(outputPath, '');

const sendEventsFn = async (events) => {
  for (const event of events) {
    appendFileSync(outputPath, JSON.stringify(event) + '\n');
  }
  return { success: true, statusCode: 200, retryCount: 0 };
};

const sendMetricsFn = async () => ({ success: true, statusCode: 200, retryCount: 0 });

const scheduler = new HarvestScheduler({
  licenseKey: 'test-key',
  transportOptions: { accountId: '12345' },
  // 60s intervals so the periodic tick never fires during the smoke test
  // — anything we see in the file came via the beforeExit flush path.
  eventHarvestIntervalMs: 60_000,
  metricHarvestIntervalMs: 60_000,
  sendEventsFn,
  sendMetricsFn,
  allowProcessExit: true,
});

scheduler.start();

scheduler.addEvent({ eventType: 'AiToolCall', timestamp: 1000, marker: 'a' });
scheduler.addEvent({ eventType: 'AiAntiPattern', timestamp: 2000, marker: 'b' });
scheduler.addEvent({ eventType: 'AiCodingTask', timestamp: 3000, marker: 'c' });

// Top-level finishes here. The unref'd intervals do NOT hold the loop
// open. With nothing else ref'd, Node fires `beforeExit`, the registered
// handler calls `void scheduler.stop()`, and `stop()`'s final flush
// invokes `sendEventsFn` with the three buffered events above.

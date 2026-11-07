// Drives a real thrashing alert from the built RetryDetector into a real
// NrIngestManager and prints the ai.retry.* metrics its Metric API batch would
// carry. Only the HTTP send is replaced, so the batch is what New Relic would
// receive. Local mode never sends metrics, so this is the proof of their shape.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const { RetryDetector } = await import(`${dist}/metrics/retry-detector.js`);
const { NrIngestManager } = await import(`${dist}/transport/nr-ingest.js`);
const { SessionTracker } = await import(`${dist}/metrics/session-tracker.js`);

const batches = [];
const ok = async () => ({ success: true, statusCode: 202, retryCount: 0 });
const sendMetricsFn = async (metrics) => {
  batches.push(metrics);
  return ok();
};

const retryDetector = new RetryDetector();
for (let i = 0; i < 3; i++) {
  retryDetector.recordToolCall({
    id: `r${i}`,
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: `tu-${i}`,
    timestamp: 1_000 + i,
    durationMs: 100,
    success: false,
    command: 'npm test',
  });
}
const expected = retryDetector.getMetrics();
assert.equal(expected.totalAlertsEmitted, 1, 'the detector fired one alert');

const manager = new NrIngestManager({
  licenseKey: 'verify-only',
  transportOptions: { accountId: '1' },
  developer: 'dev',
  appName: 'verify',
  sessionTracker: new SessionTracker('sess-1'),
  retryDetector,
  eventHarvestIntervalMs: 3_600_000,
  metricHarvestIntervalMs: 3_600_000,
  logHarvestIntervalMs: 3_600_000,
  sendEventsFn: ok,
  sendMetricsFn,
  sendLogsFn: ok,
});

manager.start();
await manager.stop();

const rows = batches.flat().filter((m) => m.name.startsWith('ai.retry.'));
for (const r of rows) console.log(JSON.stringify({ name: r.name, value: r.value }));

const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
assert.equal(byName['ai.retry.alerts_total']?.value.max, expected.totalAlertsEmitted);
assert.equal(byName['ai.retry.tokens_wasted']?.value.max, expected.totalTokensWasted);
console.log(`ok ${rows.length} ai.retry.* metrics`);

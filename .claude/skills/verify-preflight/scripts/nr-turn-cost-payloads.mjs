// Drives the built TurnCostAttributor into a real NrIngestManager and prints the
// AiTurnCost events its Events API batch would carry. Only the HTTP send is
// replaced, so the batch is what New Relic would receive. Local mode never sends
// events, so this is the proof of AiTurnCost's shape and totals.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const { TurnCostAttributor } = await import(`${dist}/metrics/turn-cost-attributor.js`);
const { NrIngestManager } = await import(`${dist}/transport/nr-ingest.js`);
const { SessionTracker } = await import(`${dist}/metrics/session-tracker.js`);

const sent = [];
const ok = async (events) => {
  sent.push(...events);
  return { success: true, statusCode: 202, retryCount: 0 };
};
const manager = new NrIngestManager({
  licenseKey: 'verify-only',
  transportOptions: { accountId: '1' },
  developer: 'dev',
  appName: 'verify',
  sessionTracker: new SessionTracker('sess-1'),
  eventHarvestIntervalMs: 3_600_000,
  metricHarvestIntervalMs: 3_600_000,
  logHarvestIntervalMs: 3_600_000,
  sendEventsFn: ok,
  sendMetricsFn: ok,
  sendLogsFn: ok,
});

const attributor = new TurnCostAttributor();
const report = (timestamp) => {
  manager.ingestTurnCost(
    attributor.recordTokenEvent({
      mode: 'token',
      sessionId: 'sess-1',
      timestamp,
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
    }),
  );
};

manager.start();
report(1_000);
attributor.recordToolCall({
  id: 'r1',
  sessionId: 'sess-1',
  toolName: 'Read',
  toolUseId: 'tu-read',
  timestamp: 2_000,
  durationMs: 100,
  success: true,
});
report(3_000);
report(5_000);
await manager.stop();

const rows = sent.filter((e) => e.eventType === 'AiTurnCost');
for (const r of rows) {
  console.log(
    JSON.stringify({
      tool: r.tool ?? null,
      tool_use_id: r.tool_use_id ?? null,
      cost_usd: r.cost_usd,
      input_tokens: r.input_tokens,
      turn_tool_call_count: r.turn_tool_call_count,
      platform: r.platform,
    }),
  );
}

const total = rows.reduce((sum, r) => sum + r.cost_usd, 0);
assert.equal(rows.length, 3, 'one AiTurnCost row per token report');
assert.equal(rows.filter((r) => r.tool === undefined).length, 2, 'two response rows');
assert.ok(Math.abs(total - 3 * rows[0].turn_cost_usd) < 1e-9, 'rows sum to every report');
assert.ok(
  Math.abs(attributor.getMetrics().totalAttributedCost - rows[0].turn_cost_usd) < 1e-9,
  'local attributed total still covers only the tool turn',
);
console.log(`ok ${rows.length} rows, $${total.toFixed(4)} total`);

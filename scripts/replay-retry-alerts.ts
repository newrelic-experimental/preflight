#!/usr/bin/env tsx
/**
 * Replays archived hook buffers through HookEventProcessor and RetryDetector
 * and prints the retry alerts and tokens wasted they produce, grouped by
 * tool. Use it to check how a detector change moves the Compute Waste
 * number on real traffic.
 *
 * Usage:
 *   npx tsx scripts/replay-retry-alerts.ts <buffer.jsonl>... [--alerts]
 *
 * `--alerts` also prints each alert with the inputs of the calls behind it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HookEventProcessor } from '../src/hooks/event-processor.js';
import { RetryDetector, type ThrashingAlert } from '../src/metrics/retry-detector.js';
import { LocalStore } from '../src/storage/local-store.js';
import type { HookEvent, ToolCallRecord } from '../src/storage/types.js';

const args = process.argv.slice(2);
const showAlerts = args.includes('--alerts');
const files = args.filter((a) => a !== '--alerts');
if (files.length === 0) {
  console.error('usage: replay-retry-alerts.ts <buffer.jsonl>... [--alerts]');
  process.exit(2);
}

const events: HookEvent[] = files
  .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
  .filter((line) => line.trim() !== '')
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as HookEvent];
    } catch {
      return [];
    }
  })
  .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

const scratch = mkdtempSync(join(tmpdir(), 'replay-retry-'));
const recent: ToolCallRecord[] = [];
const alerts: Array<{ alert: ThrashingAlert; context: string[] }> = [];
let records = 0;

const detector = new RetryDetector({
  onAlert: (alert) => {
    const context = recent
      .filter((r) => r.toolName === alert.toolName)
      .slice(-alert.occurrences)
      .map((r) => {
        const input = r.command ?? r.filePath ?? r.inputHash ?? '';
        return `${r.success ? 'ok  ' : 'FAIL'} ${r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''}${input.slice(0, 110)}`;
      });
    alerts.push({ alert, context });
  },
});

const processor = new HookEventProcessor({
  store: new LocalStore(scratch),
  drainAllSessions: true,
  onRecord: (record) => {
    records++;
    recent.push(record);
    if (recent.length > 20) recent.shift();
    detector.recordToolCall(record);
  },
});
processor.processEvents(events);
rmSync(scratch, { recursive: true, force: true });

const byTool = new Map<string, { alerts: number; tokens: number }>();
for (const { alert } of alerts) {
  const row = byTool.get(alert.toolName) ?? { alerts: 0, tokens: 0 };
  byTool.set(alert.toolName, {
    alerts: row.alerts + 1,
    tokens: row.tokens + alert.tokensWastedEstimate,
  });
}

const metrics = detector.getMetrics();
console.log(`events=${events.length} records=${records}`);
console.log(`alerts=${metrics.totalAlertsEmitted} tokensWasted=${metrics.totalTokensWasted}`);
for (const [tool, row] of [...byTool].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${tool.padEnd(40)} alerts=${String(row.alerts).padStart(4)} tokens=${row.tokens}`);
}
if (showAlerts) {
  for (const { alert, context } of alerts) {
    console.log(
      `\n${alert.toolName} n=${alert.occurrences} sim=${alert.similarity.toFixed(2)} tokens=${alert.tokensWastedEstimate}`,
    );
    for (const line of context) console.log(`    ${line}`);
  }
}

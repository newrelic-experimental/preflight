import type { TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getLogsApiUrl } from './http-client.js';

export interface NrLogEntry {
  timestamp: number;
  message: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Send a batch of log entries to the New Relic Logs API.
 *
 * Body shape: `[{ logs: [...] }]` — the "Detailed JSON"
 * format documented at
 * https://docs.newrelic.com/docs/logs/log-api/introduction-log-api/.
 * NR also accepts a top-level `common` block sibling to `logs` for shared
 * attributes (e.g. `[{ common: { attributes: {…} }, logs: [...] }]`); we
 * don't use it because each log entry already carries its own `attributes`
 * map, but the option is open if a future caller wants to deduplicate
 * across-batch attributes.
 *
 * **⚠️ Standalone transport helper — no harvest-scheduler integration.**
 * Unlike `sendEvents` and `sendMetrics`, this function is NOT wired into
 * `HarvestScheduler`. It has no in-memory buffer, no overflow protection, no
 * retry-buffer cap, and no self-monitoring drop metrics. Call it directly only
 * when you own the batching and retry logic yourself. For managed delivery
 * analogous to event/metric harvest, a `NrLogEntry[]` buffer inside
 * `HarvestScheduler` would be the right surface.
 */
export async function sendLogs(
  logs: NrLogEntry[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (logs.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getLogsApiUrl(region, options.collectorHost ?? null);

  return sendWithRetry({
    url,
    body: [{ logs }],
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  });
}

import type { NrMetric, TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getMetricApiUrl } from './http-client.js';

/**
 * Wire-format shape for an `NrMetric` after the camelCase → dotted-key
 * rename. NR's Metric API expects `interval.ms` (literal string key with a
 * dot) rather than `intervalMs`; we keep `intervalMs` in the TypeScript
 * surface for idiomatic call sites and rewrite to the wire form here.
 */
type WireMetric = Omit<NrMetric, 'intervalMs'> & { 'interval.ms'?: number };

function toWireMetric(m: NrMetric): WireMetric {
  if (m.intervalMs === undefined) {
    // Gauge with no intervalMs — emit unchanged, drop the field name entirely.
    const { intervalMs: _omit, ...rest } = m as NrMetric & { intervalMs?: number };
    void _omit;
    return rest as WireMetric;
  }
  const { intervalMs, ...rest } = m as NrMetric & { intervalMs: number };
  return { ...(rest as Omit<NrMetric, 'intervalMs'>), 'interval.ms': intervalMs };
}

/**
 * Send a batch of `NrMetric` records to NR's Metric API. Encodes the
 * discriminated union (`gauge`, `count`, `summary`) per NR's wire format,
 * compresses with gzip, and uses the same retry / timeout machinery as
 * `sendEvents`.
 */
export async function sendMetrics(
  metrics: NrMetric[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (metrics.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getMetricApiUrl(region, options.collectorHost ?? null);

  // NR Metric API expects: [{ metrics: [...] }]. Rewrite each metric so the
  // camelCase `intervalMs` becomes the literal wire key `interval.ms` per NR
  // Metric API contract.
  const payload = [{ metrics: metrics.map(toWireMetric) }];

  return sendWithRetry({
    url,
    body: payload,
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  });
}

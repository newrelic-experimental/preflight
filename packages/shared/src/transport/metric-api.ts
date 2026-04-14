import type { NrMetric, TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getMetricApiUrl } from './http-client.js';

export async function sendMetrics(
  metrics: NrMetric[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (metrics.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getMetricApiUrl(region);

  // NR Metric API expects: [{ metrics: [...] }]
  const payload = [{ metrics }];

  return sendWithRetry({
    url,
    body: payload,
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
  });
}

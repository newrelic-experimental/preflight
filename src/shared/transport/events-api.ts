import type { NrEventData } from '../events/types.js';
import type { TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getEventsApiUrl } from './http-client.js';

/**
 * Send a batch of events to NR's Events API. Compresses with gzip, retries
 * with exponential backoff (capped, jittered, Retry-After-aware), and
 * surfaces 4xx response bodies in the result so callers can distinguish
 * license-key from payload-shape failures.
 *
 * Returns a {@link TransportResult} the harvest scheduler uses to decide
 * whether to requeue the batch. Per-request timeout is honored via
 * `AbortSignal.timeout`.
 */
export async function sendEvents(
  events: NrEventData[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (events.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getEventsApiUrl(options.accountId, region, options.collectorHost ?? null);

  return sendWithRetry({
    url,
    body: events,
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  });
}

import type { NrEventData } from '../events/types.js';
import type { TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getEventsApiUrl } from './http-client.js';

export async function sendEvents(
  events: NrEventData[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (events.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getEventsApiUrl(options.accountId, region);

  return sendWithRetry({
    url,
    body: events,
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
  });
}

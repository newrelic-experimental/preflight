import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import type { HttpSendOptions, TransportResult } from './types.js';

const gzipAsync = promisify(gzip);
const logger = createLogger('transport');

export function resolveRegion(
  licenseKey: string,
  collectorHost: string | null,
): 'us' | 'eu' {
  if (collectorHost && collectorHost.toLowerCase().includes('eu')) {
    return 'eu';
  }
  if (licenseKey.toLowerCase().startsWith('eu01')) {
    return 'eu';
  }
  return 'us';
}

export function getEventsApiUrl(accountId: string, region: 'us' | 'eu'): string {
  const host =
    region === 'eu'
      ? 'insights-collector.eu01.nr-data.net'
      : 'insights-collector.newrelic.com';
  return `https://${host}/v1/accounts/${accountId}/events`;
}

export function getMetricApiUrl(region: 'us' | 'eu'): string {
  const host =
    region === 'eu' ? 'metric-api.eu.newrelic.com' : 'metric-api.newrelic.com';
  return `https://${host}/metric/v1`;
}

export async function compressPayload(data: unknown): Promise<Buffer> {
  const json = JSON.stringify(data);
  return gzipAsync(Buffer.from(json)) as Promise<Buffer>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export async function sendWithRetry(options: HttpSendOptions): Promise<TransportResult> {
  const { url, body, licenseKey, maxRetries, baseDelayMs, maxDelayMs } = options;

  let compressed: Buffer;
  try {
    compressed = await compressPayload(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to compress payload', { error: message });
    return { success: false, statusCode: null, retryCount: 0, error: `gzip failed: ${message}` };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Api-Key': licenseKey,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: compressed as unknown as BodyInit,
      });

      const status = response.status;

      if (status >= 200 && status <= 209) {
        return { success: true, statusCode: status, retryCount: attempt };
      }

      if (status === 400) {
        const text = await response.text().catch(() => '');
        logger.error('Bad request — dropping batch', { statusCode: status, response: text });
        return {
          success: false,
          statusCode: status,
          retryCount: attempt,
          error: 'bad request',
        };
      }

      if (status === 403) {
        logger.error('Forbidden — invalid license key', { statusCode: status });
        return {
          success: false,
          statusCode: status,
          retryCount: attempt,
          error: 'forbidden - invalid license key',
        };
      }

      if (isRetryable(status)) {
        logger.warn('Retryable status received', { statusCode: status, attempt });
        if (attempt < maxRetries) {
          const backoff = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
          const jittered = backoff * (0.5 + Math.random() * 0.5);
          await delay(jittered);
          continue;
        }
        logger.warn('Max retries exhausted — dropping batch', {
          statusCode: status,
          attempts: attempt + 1,
        });
        return {
          success: false,
          statusCode: status,
          retryCount: attempt,
          error: `max retries exhausted (last status: ${status})`,
        };
      }

      // Non-retryable, non-standard status
      logger.warn('Unexpected status code — dropping batch', { statusCode: status });
      return {
        success: false,
        statusCode: status,
        retryCount: attempt,
        error: `unexpected status: ${status}`,
      };
    } catch (err) {
      // Network error — retryable
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Network error during send', { error: message, attempt });
      if (attempt < maxRetries) {
        const backoff = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jittered = backoff * (0.5 + Math.random() * 0.5);
        await delay(jittered);
        continue;
      }
      logger.warn('Max retries exhausted after network errors — dropping batch', {
        attempts: attempt + 1,
      });
      return {
        success: false,
        statusCode: null,
        retryCount: attempt,
        error: `network error: ${message}`,
      };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return { success: false, statusCode: null, retryCount: maxRetries, error: 'unexpected' };
}

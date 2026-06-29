import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { HttpSendOptions, TransportResult } from './types.js';
import { buildUserAgent } from './otlp-shared.js';

const gzipAsync = promisify(gzip);
const logger = createLogger('transport');

/**
 * Generate a short correlation ID for an outbound batch.
 * Eight hex chars derived from a v4 UUID is
 * enough entropy to disambiguate concurrent retries in stderr without
 * adding meaningful payload weight or scanning friction.
 */
function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Supported New Relic regions for data ingest.
 *
 * - `us` — default/global region (insights-collector.newrelic.com)
 * - `eu` — EU data center (insights-collector.eu01.nr-data.net)
 * - `gov` — FedRAMP / US gov cloud (gov-* hostnames)
 *
 * License-key prefix mapping: `us01` → us, `eu01` → eu, `gov01` → gov.
 * Legacy keys (no recognizable region prefix) default to `us`.
 */
export type Region = 'us' | 'eu' | 'gov';

// Exact license-key prefixes we recognize, plus the region they map to.
// Prefixes are matched case-insensitively.
const LICENSE_KEY_REGION_PREFIXES = {
  us01: 'us',
  eu01: 'eu',
  gov01: 'gov',
} as const satisfies Record<string, Region>;

// Pattern for *any* string that looks like a region prefix (2-4 letters then
// 2 digits at the start of the key). If a key matches this pattern but the
// specific prefix is not in LICENSE_KEY_REGION_PREFIXES, we throw — silently
// defaulting to US would misroute data to the wrong data center.
const REGION_PREFIX_SHAPE_RE = /^[a-z]{2,4}\d{2}/;

export function resolveRegion(licenseKey: string, collectorHost: string | null): Region {
  // collectorHost overrides take priority — they are an explicit user choice.
  // Only recognise the keyword form (bare word, no dots or colons).
  // Substring matching against FQDNs produced false positives: a host like
  // 'bureau-collector.local' matches 'eu', 'eucalyptus.test' likewise.
  if (collectorHost) {
    const host = collectorHost.toLowerCase().trim();
    if (!host.includes('.') && !host.includes(':')) {
      if (host === 'gov') return 'gov';
      if (host === 'eu') return 'eu';
      if (host === 'us') return 'us';
    }
    // FQDN form: licence-key prefix detection below handles region routing.
  }

  const lowerKey = licenseKey.toLowerCase();

  // Exact prefix match — the only path that reliably resolves to a known region.
  for (const [prefix, region] of Object.entries(LICENSE_KEY_REGION_PREFIXES)) {
    if (lowerKey.startsWith(prefix)) return region;
  }

  // Key has the *shape* of a region prefix but not one we recognize. This
  // most likely means New Relic launched a new region we don't yet support,
  // OR the key is corrupted. Either way, defaulting to US silently misroutes
  // data — fail loudly instead.
  if (REGION_PREFIX_SHAPE_RE.test(lowerKey)) {
    const observedPrefix = lowerKey.match(REGION_PREFIX_SHAPE_RE)![0];
    const supported = Object.keys(LICENSE_KEY_REGION_PREFIXES).join(', ');
    throw new Error(
      `Unrecognized New Relic license-key region prefix "${observedPrefix}". ` +
        `Supported prefixes: ${supported}. ` +
        `Set 'collectorHost' explicitly to override region detection.`,
    );
  }

  // No region prefix shape — assume legacy US key (40-char hex, no prefix).
  return 'us';
}

/**
 * When `collectorHost` is provided AND looks like a real hostname (has a
 * dot or colon — i.e. an FQDN or host:port), treat it as a literal override and
 * use it as the URL host for ALL three APIs (events, metric, logs). The path
 * remains per-API since the user's proxy must route by path.
 *
 * Without a dot or colon, `collectorHost` is treated as an exact region keyword
 * (one of 'us', 'eu', 'gov') — `resolveRegion` maps it to the
 * appropriate NR hostnames for all three APIs (no substring matching).
 *
 */
function isLiteralHostname(collectorHost: string | null | undefined): boolean {
  if (!collectorHost) return false;
  return collectorHost.includes('.') || collectorHost.includes(':');
}

/**
 * Per-region NR ingest hostnames.
 *
 * Single source of truth — the three URL builders below all read from this
 * table instead of inlining the same nested-ternary three times. To add a
 * new region, widen `Region` plus `LICENSE_KEY_REGION_PREFIXES` and add
 * one row here; nothing else needs to change.
 *
 * The table is intentionally NOT exported. Hostnames are NR-operated
 * implementation detail — exposing them as a public constant invites
 * consumers to depend on specific values, which would break if NR ever
 * renames a host. Consumers that need to override an endpoint
 * should use the `collectorHost` option instead, which already routes
 * through `isLiteralHostname()` above.
 */
const NR_INGEST_HOSTS: Readonly<
  Record<
    Region,
    {
      readonly events: string;
      readonly metric: string;
      readonly log: string;
    }
  >
> = Object.freeze({
  us: {
    events: 'insights-collector.newrelic.com',
    metric: 'metric-api.newrelic.com',
    log: 'log-api.newrelic.com',
  },
  eu: {
    events: 'insights-collector.eu01.nr-data.net',
    metric: 'metric-api.eu.newrelic.com',
    log: 'log-api.eu.newrelic.com',
  },
  gov: {
    events: 'gov-insights-collector.newrelic.com',
    metric: 'gov-metric-api.newrelic.com',
    log: 'gov-log-api.newrelic.com',
  },
});

export function getEventsApiUrl(
  accountId: string,
  region: Region,
  collectorHost?: string | null,
): string {
  // Defensive guard against an empty/null/undefined accountId
  // that bypassed `loadConfig`'s fail-fast (e.g. a JS caller, an explicit
  // `accountId: config.accountId!` non-null assertion, or a custom config
  // path that didn't go through loadConfig). Without this, the URL becomes
  // `.../accounts/null/events` and NR responds 404 to every harvest — the
  // scheduler silently retry-loops until the retry buffer overflows.
  if (!accountId || accountId === 'null' || accountId === 'undefined') {
    throw new Error(
      `getEventsApiUrl: accountId is required (got: ${JSON.stringify(accountId)}). ` +
        `Set the NEW_RELIC_ACCOUNT_ID environment variable or pass accountId in options.`,
    );
  }
  if (isLiteralHostname(collectorHost)) {
    return `https://${collectorHost}/v1/accounts/${accountId}/events`;
  }
  return `https://${NR_INGEST_HOSTS[region].events}/v1/accounts/${accountId}/events`;
}

export function getMetricApiUrl(region: Region, collectorHost?: string | null): string {
  if (isLiteralHostname(collectorHost)) {
    return `https://${collectorHost}/metric/v1`;
  }
  return `https://${NR_INGEST_HOSTS[region].metric}/metric/v1`;
}

export function getLogsApiUrl(region: Region, collectorHost?: string | null): string {
  if (isLiteralHostname(collectorHost)) {
    return `https://${collectorHost}/log/v1`;
  }
  return `https://${NR_INGEST_HOSTS[region].log}/log/v1`;
}

/**
 * gzip-compress a JSON-serializable payload.
 *
 * Node 18+'s `zlib.gzip` accepts a string directly and performs UTF-8
 * encoding internally, so we hand it `JSON.stringify(data)` and skip the
 * extra `Buffer.from(json)` allocation that the previous implementation
 * incurred (one less buffer per harvest).
 *
 * The returned Buffer is immutable after the call (`zlib.gzip` is a
 * one-shot, not a stateful stream), so it is safe for `sendWithRetry` to
 * reuse the same `compressed` Buffer across retry attempts. If a
 * future refactor moves to a stateful gzip stream, that reuse becomes
 * unsafe — pin the call site outside the retry loop accordingly.
 */
export async function compressPayload(data: unknown): Promise<Buffer> {
  return gzipAsync(JSON.stringify(data)) as Promise<Buffer>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AWS-recommended decorrelated-jitter exponential backoff.
 *
 *   sleep = min(maxDelayMs, random_between(baseDelayMs, prevSleepMs * 3))
 *
 * Compared to "equal jitter" (`backoff * (0.5 + Math.random() * 0.5)`),
 * decorrelated jitter:
 *   - smears retries more uniformly across time, reducing the thundering-herd
 *     effect when many clients are retrying the same 429,
 *   - lets a slow-start grow naturally toward `maxDelayMs` rather than locking
 *     the schedule to powers of two of `baseDelayMs`.
 *
 * `prevSleepMs` should start at `baseDelayMs` for the first retry, then carry
 * the chosen wait forward so each subsequent retry samples from a wider band.
 */
export function decorrelatedJitter(
  baseDelayMs: number,
  maxDelayMs: number,
  prevSleepMs: number,
): number {
  // Clamp upper to at least baseDelayMs so the jitter band [base, upper] is
  // never negative when maxDelayMs < baseDelayMs (a misconfiguration, but
  // unguarded — without the clamp the sample can be zero or negative).
  const upper = Math.max(baseDelayMs, Math.min(maxDelayMs, prevSleepMs * 3));
  // Math.random() returns [0, 1); spread baseDelayMs..upper.
  const sample = baseDelayMs + (upper - baseDelayMs) * Math.random();
  return Math.min(maxDelayMs, Math.max(baseDelayMs, sample));
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse a Retry-After header per RFC 7231:
 *   - delta-seconds: a non-negative integer, e.g. "120"
 *   - HTTP-date: an absolute date, e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
 * Returns the wait time in milliseconds, or null if absent or malformed.
 */
function parseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const trimmed = raw.trim();
  // Try delta-seconds first
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // Try HTTP-date
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return null;
}

export async function sendWithRetry(options: HttpSendOptions): Promise<TransportResult> {
  const { url, body, licenseKey, maxRetries, baseDelayMs, maxDelayMs, requestTimeoutMs } = options;

  // Per-request correlation ID. Stamped on every
  // log line emitted from this call so concurrent retries to different
  // batches can be disambiguated in stderr.
  const requestId = newRequestId();

  let compressed: Buffer;
  try {
    compressed = await compressPayload(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to compress payload', { requestId, error: message });
    return { success: false, statusCode: null, retryCount: 0, error: `gzip failed: ${message}` };
  }

  // Decorrelated jitter tracks the previous sleep across
  // attempts so each subsequent retry samples from a wider [base, prev*3] band.
  // Initialize to baseDelayMs so the first retry samples [base, base*3].
  let prevSleepMs = baseDelayMs;
  const userAgent = buildUserAgent(options.clientName, options.clientVersion);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Node 18+ fetch accepts Buffer bodies, but under TS6 Buffer<ArrayBufferLike>
      // no longer satisfies BodyInit (tightened Uint8Array generics). Double-cast
      // through unknown is the standard escape hatch; runtime behaviour is unchanged.
      const fetchBody = compressed as unknown as BodyInit;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Api-Key': licenseKey,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'User-Agent': userAgent,
        },
        body: fetchBody,
        signal: AbortSignal.timeout(requestTimeoutMs),
        // `keepalive: true` is a no-op in Node fetch (undici), but
        // safe to set. It exists for the case where this library is consumed
        // in a runtime that *does* honor it (Cloudflare Workers, Deno, browser
        // bundlers): the final shutdown send issued from `HarvestScheduler.stop()`
        // can survive page-unload / process-teardown there. No effect on Node.
        keepalive: true,
      });

      const status = response.status;

      if (status >= 200 && status < 300) {
        // Drain the body so undici returns the socket to the keep-alive pool
        // rather than tearing down the connection.
        await response.body?.cancel().catch(() => {});
        return { success: true, statusCode: status, retryCount: attempt };
      }

      // Read the body for all failure paths: gives useful diagnostics for 5xx
      // errors and releases the socket to the keep-alive pool.
      const responseBody = (await response.text().catch(() => '')).slice(0, 1024);

      if (status === 400) {
        logger.error('Bad request — dropping batch', {
          requestId,
          statusCode: status,
          response: responseBody,
        });
        return {
          success: false,
          statusCode: status,
          retryCount: attempt,
          // Surface the server's body in the result so the harvest scheduler's
          // log line carries diagnostic detail (e.g. "Reserved attribute name
          // 'accountId'", "Body too large", "Invalid timestamp"). Truncated.
          error: responseBody ? `bad request: ${responseBody}` : 'bad request',
        };
      }

      if (status === 403) {
        logger.error('Forbidden — possible invalid license key or account permission', {
          requestId,
          statusCode: status,
          response: responseBody,
        });
        return {
          success: false,
          statusCode: status,
          retryCount: attempt,
          error: responseBody ? `forbidden: ${responseBody}` : 'forbidden',
        };
      }

      if (isRetryable(status)) {
        logger.warn('Retryable status received', {
          requestId,
          statusCode: status,
          attempt,
          response: responseBody.slice(0, 256),
        });
        if (attempt < maxRetries) {
          // Respect server-supplied Retry-After when present; cap at maxDelayMs
          // to avoid pathological values. Otherwise use decorrelated-jitter
          // exponential backoff.
          const retryAfter = parseRetryAfterMs(response);
          let waitMs: number;
          if (retryAfter !== null) {
            waitMs = Math.min(retryAfter, maxDelayMs);
          } else {
            waitMs = decorrelatedJitter(baseDelayMs, maxDelayMs, prevSleepMs);
          }
          // Always carry the chosen wait forward so the next jitter window
          // widens appropriately — omitting this on the Retry-After path caused
          // the window to stall at [base, base*3] after every server-driven
          // wait.
          prevSleepMs = waitMs;
          await delay(waitMs);
          continue;
        }
        logger.warn('Max retries exhausted — dropping batch', {
          requestId,
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
      logger.warn('Unexpected status code — dropping batch', {
        requestId,
        statusCode: status,
        response: responseBody.slice(0, 256),
      });
      return {
        success: false,
        statusCode: status,
        retryCount: attempt,
        error: `unexpected status: ${status}`,
      };
    } catch (err) {
      // Network error — retryable
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Network error during send', { requestId, error: message, attempt });
      if (attempt < maxRetries) {
        const waitMs = decorrelatedJitter(baseDelayMs, maxDelayMs, prevSleepMs);
        prevSleepMs = waitMs;
        await delay(waitMs);
        continue;
      }
      logger.warn('Max retries exhausted after network errors — dropping batch', {
        requestId,
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

  // Should not reach here — every loop iteration returns or continues.
  // A throw (not a silent failure return) makes a future loop-logic regression
  // immediately visible rather than producing a confusing success:false result.
  throw new Error('sendWithRetry: unreachable code — bug in retry loop logic');
}

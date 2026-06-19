import { createLogger } from '../logger.js';

const logger = createLogger('otlp-shared');

/**
 * Default client name stamped on User-Agent headers and OTel scope/logger
 * names when the consumer does not provide one. Single source of truth —
 * import this constant rather than repeating the literal.
 */
export const DEFAULT_CLIENT_NAME = 'ai-telemetry';

/**
 * Returns true when `headers` contains at least one recognised auth header
 * (`api-key`, `authorization`, or `x-license-key`). Shared by OtlpTransport
 * and OtlpEventBridge so both warn when no auth header is present (§TR4).
 */
export function hasOtlpAuthHeader(headers: Record<string, string>): boolean {
  for (const key of Object.keys(headers)) {
    const lk = key.toLowerCase();
    if (lk === 'api-key' || lk === 'authorization' || lk === 'x-license-key') return true;
  }
  return false;
}

// CODE_REVIEW §5.11 — validate OTLP endpoint scheme. https:// is required for
// any non-localhost destination because the payload may contain user prompt
// fragments (PII). Plain http:// is allowed only against loopback to support
// local development and testing. Shared by OtlpTransport and OtlpEventBridge
// (§OT2 — deduplicates previously identical implementations).
export function validateOtlpEndpoint(endpoint: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${source}: invalid OTLP endpoint URL: ${endpoint}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw new Error(`${source}: OTLP endpoint must use http(s); got ${parsed.protocol}`);
  }
  // http://: only acceptable on loopback
  const host = parsed.hostname;
  // 0.0.0.0 is a wildcard that binds to ALL interfaces, not loopback only —
  // cleartext traffic to it is reachable from any network (§TR5).
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback) {
    logger.warn(
      `${source}: OTLP endpoint uses plain http:// to a non-loopback host — payload may contain PII and should not be transmitted in cleartext`,
      { endpoint },
    );
  }
}

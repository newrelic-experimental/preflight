import { isCloudMetadataHost } from '../security/ssrf.js';

/**
 * Default client name stamped on User-Agent headers and OTel scope/logger
 * names when the consumer does not provide one. Single source of truth —
 * import this constant rather than repeating the literal.
 */
export const DEFAULT_CLIENT_NAME = 'ai-telemetry';

/**
 * Strip HTTP header-injection characters and surrounding whitespace from a
 * client name or version string. Falls back to `fallback` when the input is
 * absent or reduces to an empty string after sanitization.
 */
export function sanitizeClientString(s: string | undefined, fallback: string): string {
  return (s ?? fallback).replace(/[\r\n\x00-\x1f]/g, '').trim() || fallback;
}

/**
 * Builds the `User-Agent` header value for outbound NR ingest requests.
 * Returns `name/version` when version is non-empty, `name` alone otherwise.
 */
export function buildUserAgent(
  clientName: string | undefined,
  clientVersion: string | undefined,
): string {
  const name = clientName || DEFAULT_CLIENT_NAME;
  return clientVersion ? `${name}/${clientVersion}` : name;
}

/**
 * Returns true when `headers` contains at least one recognised auth header
 * (`api-key`, `authorization`, or `x-license-key`). Shared by OtlpTransport
 * and OtlpEventBridge so both warn when no auth header is present.
 */
export function hasOtlpAuthHeader(headers: Record<string, string>): boolean {
  for (const key of Object.keys(headers)) {
    const lk = key.toLowerCase();
    if (lk === 'api-key' || lk === 'authorization' || lk === 'x-license-key') return true;
  }
  return false;
}

export function validateOtlpEndpoint(endpoint: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${source}: invalid OTLP endpoint URL: ${endpoint}`);
  }

  // Never a legitimate target under any scheme — block before the
  // scheme-based branches below so an https:// metadata target isn't
  // waved through by the "https is always fine" early return.
  if (isCloudMetadataHost(parsed.hostname)) {
    throw new Error(`${source}: OTLP endpoint targets a cloud metadata service: ${endpoint}`);
  }

  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw new Error(`${source}: OTLP endpoint must use http(s); got ${parsed.protocol}`);
  }

  // http:// is only acceptable on loopback. Private-range and public hosts
  // are rejected alike: payloads may contain PII, so any non-local hop must
  // use TLS. 0.0.0.0 binds ALL interfaces, so it is not treated as loopback.
  // URL.hostname brackets IPv6 literals, so the loopback form is '[::1]'.
  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLoopback) return;

  throw new Error(
    `${source}: OTLP endpoint uses plain http:// to a non-loopback host — use https:// (cleartext is only allowed to localhost)`,
  );
}

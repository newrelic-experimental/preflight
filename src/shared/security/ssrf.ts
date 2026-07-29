/**
 * SSRF guards for outbound requests to consumer-configurable endpoints
 * (NR ingest `collectorHost`, OTLP `otlpEndpoint`). String/IP-literal
 * validation only — no DNS-rebinding protection (that would require
 * routing `fetch()` through a custom `undici` `Agent` dispatcher with a
 * validating `connect.lookup`, an explicitly out-of-scope addition here).
 *
 * Split into two predicates so callers can apply different rules to the
 * metadata check vs. the private/loopback check — `otlp-shared.ts` allows
 * private-range addresses over `https:` (a legitimate internal-VPC OTel
 * collector topology) but never allows a cloud metadata target under any
 * scheme.
 */

// Cloud metadata service FQDNs that resolve to internal addresses within
// cloud accounts. Blocking these prevents SSRF attacks from exfiltrating
// cloud credentials.
const BLOCKED_METADATA_FQDNS = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
  'ec2.internal',
  'ec2.amazonaws.com',
]);

// Cloud metadata service IPs not covered by the RFC-1918/link-local pattern below.
const BLOCKED_METADATA_IPS = new Set(['100.100.100.200', '169.254.169.254']);

// Matches loopback, RFC-1918 private ranges, link-local (169.254/16), and
// IPv4 multicast (224.0.0.0/4, i.e. 224-239.x.x.x). Also blocks IPv6
// unspecified (::), IPv6 loopback (::1), IPv6 ULA (fc00::/7, fd00::/8), and
// IPv6 link-local (fe80::/10). Matches the hex-normalized IPv4-mapped IPv6
// form Node's URL parser produces (::ffff:7f00:1 for ::ffff:127.0.0.1).
// URL.hostname returns IPv6 addresses bracketed (e.g. [::1]); the optional
// [...] wrapper here handles that without requiring callers to strip it.
const PRIVATE_OR_LOOPBACK_HOST_RE =
  /^(?:\[)?(?:127\.(?:\d{1,3}\.)*\d{1,3}|10\.(?:\d{1,3}\.)*\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)*\d{1,3}|192\.168\.(?:\d{1,3}\.)*\d{1,3}|169\.254\.(?:\d{1,3}\.)*\d{1,3}|(?:22[4-9]|23[0-9])\.(?:\d{1,3}\.)*\d{1,3}|::1|::|::ffff:(?:7f[0-9a-f]{2}|0a[0-9a-f]{2}|ac1[0-9a-f]|c0a8|a9fe)[0-9a-f]*:[0-9a-f]+|fc[0-9a-f]{2}:[0-9a-f:]*|fd[0-9a-f]{2}:[0-9a-f:]*|fe[89ab][0-9a-f]:[0-9a-f:]*|0\.0\.0\.0|localhost)(?:\])?$/i;

// Extracts an embedded IPv4 from a decimal-form IPv4-mapped IPv6 address
// (::ffff:127.0.0.1) or its hex form (::ffff:7f00:1). Returns null when the
// input isn't a recognized mapped address. The hex form is already caught
// directly by PRIVATE_OR_LOOPBACK_HOST_RE; this exists for the decimal form,
// which is not.
function extractIPv4FromMappedIPv6(host: string): string | null {
  const trimmed = host.replace(/[[\]]/g, '');

  const decimalMatch =
    /^::ffff:((?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/i.exec(
      trimmed,
    );
  if (decimalMatch) {
    return decimalMatch[1];
  }

  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(trimmed);
  if (hexMatch) {
    const part1 = parseInt(hexMatch[1], 16);
    const part2 = parseInt(hexMatch[2], 16);
    const b1 = (part1 >> 8) & 0xff;
    const b2 = part1 & 0xff;
    const b3 = (part2 >> 8) & 0xff;
    const b4 = part2 & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  }

  return null;
}

// Canonicalizes decimal/octal/hex-encoded numeric IPv4 host literals
// (2130706433, 0177.0.0.1, 0x7f.0.0.1 — all 127.0.0.1) to dotted-decimal
// form. Returns null when the input isn't a recognized numeric encoding.
// Node's own URL parser already normalizes most of these before a hostname
// reaches this module (see plan doc), but isPrivateOrLoopbackHost is also
// called directly with raw, non-URL-parsed strings, where this still matters.
function canonicalizeNumericIP(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const num = BigInt(host);
    if (num >= 0n && num <= 0xffffffffn) {
      const b1 = Number((num >> 24n) & 0xffn);
      const b2 = Number((num >> 16n) & 0xffn);
      const b3 = Number((num >> 8n) & 0xffn);
      const b4 = Number(num & 0xffn);
      return `${b1}.${b2}.${b3}.${b4}`;
    }
    return null;
  }

  const parts = host.split('.');
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let value: number;
      if (part.startsWith('0x') || part.startsWith('0X')) {
        value = parseInt(part, 16);
      } else if (part.startsWith('0') && part.length > 1 && /^[0-7]+$/.test(part.slice(1))) {
        value = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        value = parseInt(part, 10);
      } else {
        return null;
      }
      if (value < 0 || value > 255) {
        return null;
      }
      octets.push(value);
    }
    return octets.join('.');
  }

  return null;
}

/** True if `hostname` is a known cloud-metadata-service FQDN or IP. */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  if (BLOCKED_METADATA_FQDNS.has(host.toLowerCase())) return true;
  if (BLOCKED_METADATA_IPS.has(host)) return true;
  return false;
}

/**
 * True if `hostname` is loopback, RFC-1918-private, link-local, multicast,
 * an IPv4-mapped-IPv6 form of any of the above, or a numeric encoding
 * (decimal/octal/hex) of any of the above.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');

  const canonicalIP = canonicalizeNumericIP(host);
  if (canonicalIP && PRIVATE_OR_LOOPBACK_HOST_RE.test(canonicalIP)) return true;

  if (PRIVATE_OR_LOOPBACK_HOST_RE.test(host)) return true;

  const embeddedIPv4 = extractIPv4FromMappedIPv6(host);
  if (embeddedIPv4 && PRIVATE_OR_LOOPBACK_HOST_RE.test(embeddedIPv4)) return true;

  return false;
}

/**
 * Throws if `url`'s host is a cloud-metadata endpoint or a private/loopback
 * address. Does not check scheme — callers already enforce their own scheme
 * rules before or after calling this.
 */
export function validateSsrfUrl(label: string, url: URL): void {
  if (isCloudMetadataHost(url.hostname)) {
    throw new Error(`${label}: host "${url.hostname}" is a cloud metadata service endpoint`);
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new Error(`${label}: host "${url.hostname}" resolves to a private or loopback address`);
  }
}

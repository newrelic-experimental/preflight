const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Cloud metadata service FQDNs that resolve to internal addresses within cloud accounts.
// Blocking these prevents SSRF attacks from exfiltrating cloud credentials.
const BLOCKED_METADATA_FQDNS = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
  'ec2.internal',
  'ec2.amazonaws.com',
]);

// Cloud metadata service IPs that are not covered by RFC-1918 or link-local blocks.
const BLOCKED_METADATA_IPS = new Set(['100.100.100.200']);

// Matches loopback, RFC-1918 private ranges, link-local (169.254/16), and
// IPv4 multicast (224.0.0.0/4, i.e. 224–239.x.x.x).
// Also blocks IPv6 unspecified (::), IPv6 loopback (::1), IPv4-mapped variants (::ffff:...),
// IPv6 ULA (fc00::/7, fd00::/8), and IPv6 link-local (fe80::/10).
// Supports both decimal IPv4 and hex-normalized IPv6-mapped formats (Node.js normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1).
// Node.js URL.hostname returns IPv6 addresses with brackets (e.g. [::1]).
const BLOCKED_HOST_RE =
  /^(?:\[)?(?:127\.(?:\d{1,3}\.)*\d{1,3}|10\.(?:\d{1,3}\.)*\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)*\d{1,3}|192\.168\.(?:\d{1,3}\.)*\d{1,3}|169\.254\.(?:\d{1,3}\.)*\d{1,3}|(?:22[4-9]|23[0-9])\.(?:\d{1,3}\.)*\d{1,3}|::1|::|::ffff:(?:7f[0-9a-f]{2}|0a[0-9a-f]{2}|ac1[0-9a-f]|c0a8|a9fe)[0-9a-f]*:[0-9a-f]+|fc[0-9a-f]{2}:[0-9a-f:]*|fd[0-9a-f]{2}:[0-9a-f:]*|fe[89ab][0-9a-f]:[0-9a-f:]*|0\.0\.0\.0|localhost)(?:\])?$/i;

// Extracts embedded IPv4 from IPv6-mapped address. Returns null if not a valid mapped address.
// Handles both decimal form (::ffff:127.0.0.1) and hex-normalized form (::ffff:7f00:1).
function extractIPv4FromMappedIPv6(host: string): string | null {
  const trimmed = host.replace(/[\[\]]/g, '');

  // Try decimal form: ::ffff:x.x.x.x
  const decimalMatch =
    /^::ffff:((?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/i.exec(
      trimmed,
    );
  if (decimalMatch) {
    return decimalMatch[1];
  }

  // Try hex form: ::ffff:XXXX:XXXX where XXXX are hex digits
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

// Canonicalize numeric IP encodings (decimal, octal, hex) to dotted-decimal form.
// Returns the canonical dotted-decimal form, or null if not a recognized numeric encoding.
function canonicalizeNumericIP(host: string): string | null {
  // Check for pure decimal encoding: 2130706433 (127.0.0.1 in decimal)
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

  // Check for octal/hex encoding in dot-separated parts: 0177.0.0.1, 0x7f.0.0.1, etc.
  const parts = host.split('.');
  if (parts.length >= 1 && parts.length <= 4) {
    try {
      const octets: number[] = [];
      for (const part of parts) {
        let value: number;
        if (part.startsWith('0x') || part.startsWith('0X')) {
          // Hex: 0x7f
          value = parseInt(part, 16);
        } else if (part.startsWith('0') && part.length > 1 && /^[0-7]+$/.test(part.slice(1))) {
          // Octal: 0177
          value = parseInt(part, 8);
        } else if (/^\d+$/.test(part)) {
          // Decimal: 127
          value = parseInt(part, 10);
        } else {
          // Not a numeric part
          return null;
        }

        if (value < 0 || value > 255) {
          return null;
        }
        octets.push(value);
      }

      // If we have fewer than 4 octets, it's a shorthand notation (not standard IP format)
      // We'll only canonicalize if we have exactly 4 parts
      if (octets.length === 4) {
        return octets.join('.');
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function validateSsrfUrl(label: string, url: URL): void {
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(`${label}: scheme "${url.protocol}" is not allowed; use http: or https:`);
  }

  // Strip trailing dot from hostname to prevent FQDN FQDN bypasses
  // Node's URL parser preserves trailing dots, but they should be treated the same as the bare hostname
  const hostname = url.hostname.replace(/\.$/, '');

  // Check cloud metadata service FQDNs (case-insensitive)
  const hostnameLower = hostname.toLowerCase();
  if (BLOCKED_METADATA_FQDNS.has(hostnameLower)) {
    throw new Error(`${label}: host "${url.hostname}" is a cloud metadata service endpoint`);
  }

  // Check cloud metadata service IPs
  if (BLOCKED_METADATA_IPS.has(hostname)) {
    throw new Error(`${label}: host "${url.hostname}" is a cloud metadata service endpoint`);
  }

  // Canonicalize and check numeric IP encodings (decimal, octal, hex)
  const canonicalIP = canonicalizeNumericIP(hostname);
  if (canonicalIP && BLOCKED_HOST_RE.test(canonicalIP)) {
    throw new Error(
      `${label}: host "${url.hostname}" is a numeric encoding of a private or loopback address`,
    );
  }

  if (BLOCKED_HOST_RE.test(hostname)) {
    throw new Error(`${label}: host "${url.hostname}" resolves to a private or loopback address`);
  }

  // Explicitly check IPv4-mapped IPv6 addresses by extracting and validating the embedded IPv4
  const embeddedIPv4 = extractIPv4FromMappedIPv6(hostname);
  if (embeddedIPv4 && BLOCKED_HOST_RE.test(embeddedIPv4)) {
    throw new Error(`${label}: host "${url.hostname}" contains a private or loopback IPv4 address`);
  }
}

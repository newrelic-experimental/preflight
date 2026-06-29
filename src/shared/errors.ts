import type { AiProvider } from './events/types.js';

/**
 * Canonical error classifications produced by {@link classifyError} and
 * {@link classifyErrorDetailed}.
 *
 * Implemented as a `const` object plus derived string-literal union
 * rather than a TypeScript `enum`, so that:
 *   - runtime usage (`AiErrorClassification.RATE_LIMIT`) keeps working
 *     identically for existing call sites;
 *   - the type is a string-literal union, matching every other
 *     enum-like type in this package (`AiProvider`, `AiRequestMethod`,
 *     `LogLevel`, `TransportMode`, etc.) — one consistent style;
 *   - bundlers can tree-shake unused members (TS enums emit a runtime
 *     object even when none of its members are referenced);
 *   - the wire-format strings (`'RATE_LIMIT'`, `'OVERLOADED'`, …) are
 *     usable directly as values without going through an enum lookup,
 *     which simplifies serialization paths.
 */
export const AiErrorClassification = {
  RATE_LIMIT: 'RATE_LIMIT',
  OVERLOADED: 'OVERLOADED',
  CONTENT_POLICY: 'CONTENT_POLICY',
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',
  AUTHENTICATION: 'AUTHENTICATION',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  SERVER_ERROR: 'SERVER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;
export type AiErrorClassification =
  (typeof AiErrorClassification)[keyof typeof AiErrorClassification];

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Classifications that `isRetryable()` reports as retryable. Exported as a
 * `ReadonlySet` so consumers can build their own retry policy on top of the
 * canonical list (e.g. layered backoff per category, custom routing) without
 * having to re-derive it. Mutation is rejected at the type level.
 */
export const RETRYABLE: ReadonlySet<AiErrorClassification> = new Set<AiErrorClassification>([
  AiErrorClassification.RATE_LIMIT,
  AiErrorClassification.OVERLOADED,
  AiErrorClassification.TIMEOUT,
  AiErrorClassification.SERVER_ERROR,
  AiErrorClassification.NETWORK_ERROR,
]);

// Walk the error.cause chain to find a classifiable `code` string.
// Returns the first code that is in NETWORK_CODES or TIMEOUT_CODES; if none
// is classified, falls back to the first string code found anywhere in the
// chain. This prevents a spurious top-level SDK code (e.g. 'UNKNOWN_ERROR')
// from blocking a classified cause-chain code (e.g. 'ECONNREFUSED').
// Bounded to 5 hops to guard against pathological chains.
function extractCode(error: unknown): string | undefined {
  let firstFound: string | undefined;
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur != null && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (NETWORK_CODES.has(code) || TIMEOUT_CODES.has(code)) return code;
      if (firstFound === undefined) firstFound = code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return firstFound;
}

/**
 * Classify an arbitrary `unknown` error from a provider SDK or `fetch` into
 * one of the canonical {@link AiErrorClassification} categories. The
 * decision routes through HTTP status (when present), Node `code` for
 * network/timeout cases, and provider-specific 400 disambiguation
 * — content policy vs. context length vs. generic.
 *
 * Designed for retry-loop consumption — see {@link isRetryable} and
 * {@link RETRYABLE} for the policy applied downstream. For UI / logging
 * surfaces that need the original message + status alongside the
 * classification, use {@link classifyErrorDetailed} instead.
 *
 * @param error The thrown value (Error, plain object, or anything else).
 * @param provider The provider that produced the error — affects 400
 *   disambiguation and Anthropic-specific 529 (OVERLOADED) handling.
 */
export function classifyError(error: unknown, provider: AiProvider): AiErrorClassification {
  const err = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
    error?: { type?: string; code?: string };
  };

  // Modern Node fetch (undici) wraps the underlying syscall code in
  // error.cause.code rather than error.code directly. Walk the cause chain
  // (bounded to 5 hops) to find the first code string.
  const code = extractCode(err);

  // 1. Network errors (no HTTP status, connection-level failure)
  if (code && NETWORK_CODES.has(code)) {
    return AiErrorClassification.NETWORK_ERROR;
  }

  // 2. Timeout errors
  if (code && TIMEOUT_CODES.has(code)) {
    return AiErrorClassification.TIMEOUT;
  }
  const nameOrMessage = `${err.name ?? ''} ${err.message ?? ''}`;
  // Only apply the message-based timeout check when there is no HTTP status —
  // for HTTP responses the switch below handles classified codes; the default
  // case handles unknown statuses and will also check the message.
  // Use typeof check (not falsiness) so status:0 doesn't spuriously trigger
  // message-based timeout detection.
  if (typeof err.status !== 'number' && /timeout/i.test(nameOrMessage)) {
    return AiErrorClassification.TIMEOUT;
  }

  // 3. HTTP status-based classification
  const status = err.status;
  if (typeof status !== 'number') {
    return AiErrorClassification.UNKNOWN;
  }

  switch (status) {
    case 429:
      return AiErrorClassification.RATE_LIMIT;
    case 529:
      // 529 is documented by Anthropic as "overloaded". Other providers
      // either don't use it or use it ambiguously — gate by provider.
      return provider === 'anthropic'
        ? AiErrorClassification.OVERLOADED
        : AiErrorClassification.UNKNOWN;
    case 503:
      // Google, OpenAI, and Bedrock all use 503 to indicate upstream overload.
      // Anthropic uses 529 for overload (handled above); their 503 is a true
      // server error. Mistral and Cohere are undocumented — default to
      // SERVER_ERROR (still retryable, just categorised differently).
      if (provider === 'google' || provider === 'openai' || provider === 'bedrock') {
        return AiErrorClassification.OVERLOADED;
      }
      return AiErrorClassification.SERVER_ERROR;
    case 401:
    case 403:
      return AiErrorClassification.AUTHENTICATION;
    case 402:
      // Payment Required — used by some providers for billing/quota exhaustion.
      // Classified as UNKNOWN (non-retryable) because a payment issue cannot
      // be resolved by retrying the same request.
      return AiErrorClassification.UNKNOWN;
    case 404:
      return AiErrorClassification.NOT_FOUND;
    case 408: // Request Timeout (rare from LLM providers but standard HTTP)
    case 504: // Gateway Timeout
      return AiErrorClassification.TIMEOUT;
    case 500:
    case 502:
    case 520: // Cloudflare unknown
    case 521: // Cloudflare web server is down
    case 522: // Cloudflare connection timed out
    case 523: // Cloudflare origin unreachable
    case 524: // Cloudflare a timeout occurred
      return AiErrorClassification.SERVER_ERROR;
    case 400:
      return classify400(err, provider);
    default:
      // For unclassified numeric statuses (e.g. 425 "Too Early"), fall back to
      // message-based timeout detection before returning UNKNOWN.
      if (/timeout/i.test(nameOrMessage)) return AiErrorClassification.TIMEOUT;
      return AiErrorClassification.UNKNOWN;
  }
}

// Provider-typed error codes (body-level `error.code` or `error.type`). Prefer
// these over message substring matching — SDKs expose stable typed codes that
// don't drift with version-to-version wording changes.
const CONTENT_POLICY_TYPED_CODES = new Set<string>([
  // OpenAI
  'content_filter',
  'content_policy_violation',
  // Anthropic (specific names seen across SDK versions)
  'content_moderation_error',
]);

const CONTEXT_LENGTH_TYPED_CODES = new Set<string>([
  // OpenAI
  'context_length_exceeded',
  'string_above_max_length',
  // Anthropic
  'request_too_large',
]);

// Narrowed message-matching fallbacks. The previous `/token|context/i` was
// over-broad — "invalid token in JSON body" matched as CONTEXT_LENGTH. These
// patterns require a context-related qualifier alongside "token"/"context".
const CONTEXT_LENGTH_MESSAGE_RE =
  /context.?(window|length|limit|size)|max.?tokens?\b|too.?long|exceeds? .*context/i;

const CONTENT_POLICY_MESSAGE_RE = /content.?polic|content.?filter|content.?moderation/i;

function classify400(
  err: { message?: string; error?: { type?: string; code?: string } },
  provider: AiProvider,
): AiErrorClassification {
  // 1. Typed body-level codes first (most reliable — survive SDK message drift).
  const typedCode = err.error?.code ?? err.error?.type ?? '';
  if (typedCode) {
    if (CONTENT_POLICY_TYPED_CODES.has(typedCode)) return AiErrorClassification.CONTENT_POLICY;
    if (CONTEXT_LENGTH_TYPED_CODES.has(typedCode)) {
      return AiErrorClassification.CONTEXT_LENGTH_EXCEEDED;
    }
  }

  // 2. Anthropic-specific typed-prefix pattern: SDK uses several `content_*`
  // type variants (`content_policy_violation`, `content_validation_error`,
  // etc.). Match by prefix instead of enumerating every variant.
  if (provider === 'anthropic' && err.error?.type && /^content[_-]/i.test(err.error.type)) {
    return AiErrorClassification.CONTENT_POLICY;
  }

  // 3. Message-substring fallback (narrowed to avoid false positives like
  // "invalid token in JSON body"). Used both when no typed code is present
  // (e.g. some Anthropic 400s carry only `message`) and when typed code is
  // a generic catch-all (`invalid_request_error`).
  const msg = err.message ?? '';
  if (CONTENT_POLICY_MESSAGE_RE.test(msg)) return AiErrorClassification.CONTENT_POLICY;
  if (CONTEXT_LENGTH_MESSAGE_RE.test(msg)) return AiErrorClassification.CONTEXT_LENGTH_EXCEEDED;

  return AiErrorClassification.UNKNOWN;
}

/**
 * Whether `classification` is one of the categories the library's retry
 * loop will re-attempt: `RATE_LIMIT`, `OVERLOADED`, `TIMEOUT`,
 * `SERVER_ERROR`, `NETWORK_ERROR`. Backed by the {@link RETRYABLE} set.
 * Use this when implementing a custom retry policy on top of
 * {@link classifyError}.
 */
export function isRetryable(classification: AiErrorClassification): boolean {
  return RETRYABLE.has(classification);
}

export interface RateLimitInfo {
  readonly tokensRemaining: number | null;
  readonly requestsRemaining: number | null;
  readonly tokensReset: string | null;
  readonly requestsReset: string | null;
}

// Internal mutable builder — extractRateLimitHeaders fills fields one at a
// time; RateLimitInfo is readonly for callers.
type MutableRateLimitInfo = { -readonly [K in keyof RateLimitInfo]: RateLimitInfo[K] };

// Header names verified June 2026.
// - Anthropic: anthropic-ratelimit-* prefix
// - OpenAI: x-ratelimit-* prefix
// - Gemini: x-goog-quota-* for token/request counts; x-ratelimit-reset for reset
// - Mistral: x-ratelimit-*-tokens-minute / x-ratelimit-*-requests-minute
// - Bedrock: no standard rate-limit headers; throttling reflected in body (ThrottlingException) — intentional null
// - Cohere: no documented rate-limit headers for Chat v2 API — intentional null
const HEADER_MAP: ReadonlyMap<keyof RateLimitInfo, readonly string[]> = new Map([
  [
    'tokensRemaining',
    [
      'anthropic-ratelimit-tokens-remaining',
      'x-ratelimit-remaining-tokens',
      'x-goog-quota-tokens-remaining',
      'x-ratelimit-remaining-tokens-minute',
    ],
  ],
  [
    'requestsRemaining',
    [
      'anthropic-ratelimit-requests-remaining',
      'x-ratelimit-remaining-requests',
      'x-goog-quota-requests-remaining',
      'x-ratelimit-remaining-requests-minute',
    ],
  ],
  [
    'tokensReset',
    [
      'anthropic-ratelimit-tokens-reset',
      'x-ratelimit-reset-tokens',
      'x-ratelimit-reset-tokens-minute',
    ],
  ],
  [
    'requestsReset',
    [
      'anthropic-ratelimit-requests-reset',
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset',
      'x-ratelimit-reset-requests-minute',
    ],
  ],
]);

function readHeader(headers: unknown, names: readonly string[]): string | null {
  if (headers == null || typeof headers !== 'object') return null;

  const hdr = headers as { get?: unknown; [key: string]: unknown };
  if (typeof hdr.get === 'function') {
    // Headers API path: use .get() exclusively. A null return from .get()
    // means the header is absent — do NOT fall through to property access,
    // which would read unrelated inherited properties.
    const getter = hdr.get as (name: string) => string | null;
    for (const name of names) {
      const val = getter.call(hdr, name);
      if (typeof val === 'string') return val;
      if (typeof val === 'number') return String(val);
    }
    return null;
  }

  // Plain object headers — property access.
  // Only accept primitive header values to avoid '[object Object]' bleed.
  for (const name of names) {
    const val = hdr[name];
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return String(val);
  }
  return null;
}

/**
 * Extract rate-limit metadata from a provider error's `headers` field.
 *
 * Returns `null` when the error carries no `headers` at all,
 * letting callers distinguish "no headers in the response" from "headers
 * present but no rate-limit headers parsed". When `headers` is present but
 * none of the recognized rate-limit headers parse, returns a `RateLimitInfo`
 * with all four fields null.
 *
 * Provider coverage: Anthropic, OpenAI, Gemini, Mistral. Bedrock and Cohere
 * intentionally return all-null — Bedrock exposes throttling in the
 * ThrottlingException body rather than response headers; Cohere has no
 * documented rate-limit headers for their Chat v2 API.
 */
export function extractRateLimitHeaders(error: unknown): RateLimitInfo | null {
  const headers = (error as { headers?: unknown })?.headers;

  if (headers == null) return null;

  const result: MutableRateLimitInfo = {
    tokensRemaining: null,
    requestsRemaining: null,
    tokensReset: null,
    requestsReset: null,
  };

  for (const [field, headerNames] of HEADER_MAP) {
    const raw = readHeader(headers, headerNames);
    if (raw === null) continue;

    if (field === 'tokensRemaining' || field === 'requestsRemaining') {
      // Guard against empty string: Number('') === 0, which is valid but
      // indistinguishable from a genuine "0 remaining".
      const trimmed = raw.trim();
      const parsed = Number(trimmed);
      if (trimmed !== '' && !Number.isNaN(parsed)) {
        result[field] = parsed;
      }
    } else {
      result[field] = raw;
    }
  }

  return result;
}

/**
 * Truncate `message` to `maxLength` chars (default 1024), suffixing `...`
 * when truncation occurs. Useful for keeping provider error messages within
 * NR's per-attribute 4096-byte limit before they're logged or attached to
 * events.
 *
 * The minimum effective `maxLength` is 4 — a shorter cap is silently
 * clamped to 4 so the result is always at least `'X...'` for some single
 * character of the original message.
 *
 * Examples:
 * ```
 *   truncateErrorMessage('hello world', 8)  // => 'hello...'
 *   truncateErrorMessage('hi', 8)           // => 'hi'        (already short)
 *   truncateErrorMessage('hello', 3)        // => 'h...'      (clamp to 4)
 *   truncateErrorMessage('hello', 0)        // => 'h...'      (clamp to 4)
 * ```
 *
 * @param message The message to truncate.
 * @param maxLength Maximum length of the returned string. Values < 4 are
 *   clamped to 4. Default is 1024.
 */
export function truncateErrorMessage(message: string, maxLength = 1024): string {
  const safeMax = Math.max(4, maxLength);
  if (message.length <= safeMax) return message;
  // Slice by code units but step back if we land on a high surrogate to avoid
  // emitting a lone surrogate that produces malformed UTF-16 / UTF-8.
  let cut = safeMax - 3;
  const charCode = message.charCodeAt(cut - 1);
  if (charCode >= 0xd800 && charCode <= 0xdbff) cut -= 1;
  return message.slice(0, cut) + '...';
}

/**
 * Rich classification result that pairs the {@link AiErrorClassification}
 * enum value with the original error context — message, HTTP status, and
 * Node system code.
 *
 * `code` is the Node system-level error code (e.g. `'ECONNREFUSED'`,
 * `'ETIMEDOUT'`), extracted by walking the cause chain. It is NOT the
 * provider body-level typed code (e.g. `'content_filter'`,
 * `'context_length_exceeded'`) — those only appear inside the 400-body
 * handling of `classifyError` and are not currently surfaced here.
 */
export interface ClassifiedError {
  readonly classification: AiErrorClassification;
  readonly originalMessage: string | null;
  readonly status: number | null;
  /** Node system code (e.g. `'ECONNREFUSED'`), or null. Not the provider body error code. */
  readonly code: string | null;
}

/**
 * Same classification logic as {@link classifyError}, but returns a
 * {@link ClassifiedError} carrying the original message, HTTP status, and
 * provider error code alongside the enum value. Useful when the caller
 * wants to log a richer line ("Rate limit hit: ...message...") or
 * propagate the original message to a UI surface.
 *
 * The retry path in `http-client.ts` does not currently consume this —
 * its decision is purely "is this retryable?". This is exposed as a
 * separate function so existing callers of `classifyError` continue to
 * work unchanged.
 */
export function classifyErrorDetailed(error: unknown, provider: AiProvider): ClassifiedError {
  const err = error as { status?: unknown; message?: unknown };
  const status = typeof err?.status === 'number' ? err.status : null;
  // Use extractCode() to walk the cause chain, matching classifyError().
  const code = extractCode(error) ?? null;
  const originalMessage =
    typeof err?.message === 'string' && err.message.length > 0 ? err.message : null;

  return {
    classification: classifyError(error, provider),
    originalMessage,
    status,
    code,
  };
}

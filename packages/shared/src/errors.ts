import type { AiProvider } from './events/types.js';

export enum AiErrorClassification {
  RATE_LIMIT = 'RATE_LIMIT',
  OVERLOADED = 'OVERLOADED',
  CONTENT_POLICY = 'CONTENT_POLICY',
  CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',
  AUTHENTICATION = 'AUTHENTICATION',
  NOT_FOUND = 'NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN = 'UNKNOWN',
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

const RETRYABLE = new Set<AiErrorClassification>([
  AiErrorClassification.RATE_LIMIT,
  AiErrorClassification.OVERLOADED,
  AiErrorClassification.TIMEOUT,
  AiErrorClassification.SERVER_ERROR,
  AiErrorClassification.NETWORK_ERROR,
]);

export function classifyError(error: unknown, provider: AiProvider): AiErrorClassification {
  const err = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
    error?: { type?: string };
  };

  const code = err.code;

  // 1. Network errors (no HTTP status, connection-level failure)
  if (code && NETWORK_CODES.has(code)) {
    return AiErrorClassification.NETWORK_ERROR;
  }

  // 2. Timeout errors
  if (code && TIMEOUT_CODES.has(code)) {
    return AiErrorClassification.TIMEOUT;
  }
  const nameOrMessage = `${err.name ?? ''} ${err.message ?? ''}`;
  if (!err.status && /timeout/i.test(nameOrMessage)) {
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
      return AiErrorClassification.OVERLOADED;
    case 503:
      return provider === 'google'
        ? AiErrorClassification.OVERLOADED
        : AiErrorClassification.SERVER_ERROR;
    case 401:
    case 403:
      return AiErrorClassification.AUTHENTICATION;
    case 404:
      return AiErrorClassification.NOT_FOUND;
    case 500:
    case 502:
      return AiErrorClassification.SERVER_ERROR;
    case 400:
      return classify400(err, provider);
    default:
      return AiErrorClassification.UNKNOWN;
  }
}

function classify400(
  err: { message?: string; error?: { type?: string } },
  provider: AiProvider,
): AiErrorClassification {
  if (provider === 'anthropic') {
    const errorType = err.error?.type ?? '';
    if (/content/i.test(errorType)) return AiErrorClassification.CONTENT_POLICY;
    const msg = err.message ?? '';
    if (/token|context/i.test(msg)) return AiErrorClassification.CONTEXT_LENGTH_EXCEEDED;
  } else {
    const msg = err.message ?? '';
    if (/content.?polic/i.test(msg)) return AiErrorClassification.CONTENT_POLICY;
    if (/token|context.?length|too.?long/i.test(msg)) {
      return AiErrorClassification.CONTEXT_LENGTH_EXCEEDED;
    }
  }
  return AiErrorClassification.UNKNOWN;
}

export function isRetryable(classification: AiErrorClassification): boolean {
  return RETRYABLE.has(classification);
}

export interface RateLimitInfo {
  tokensRemaining: number | null;
  requestsRemaining: number | null;
  tokensReset: string | null;
  requestsReset: string | null;
}

const HEADER_MAP: Array<[keyof RateLimitInfo, string[]]> = [
  [
    'tokensRemaining',
    ['anthropic-ratelimit-tokens-remaining', 'x-ratelimit-remaining-tokens'],
  ],
  [
    'requestsRemaining',
    ['anthropic-ratelimit-requests-remaining', 'x-ratelimit-remaining-requests'],
  ],
  [
    'tokensReset',
    ['anthropic-ratelimit-tokens-reset', 'x-ratelimit-reset-tokens'],
  ],
  [
    'requestsReset',
    ['anthropic-ratelimit-requests-reset', 'x-ratelimit-reset-requests'],
  ],
];

function readHeader(
  headers: unknown,
  names: string[],
): string | null {
  if (headers == null || typeof headers !== 'object') return null;

  // Response-like: headers.get(name)
  const hdr = headers as { get?: (name: string) => string | null; [key: string]: unknown };
  for (const name of names) {
    if (typeof hdr.get === 'function') {
      const val = hdr.get(name);
      if (val != null) return String(val);
    }
    // Plain object access
    const val = hdr[name];
    if (val != null) return String(val);
  }
  return null;
}

export function extractRateLimitHeaders(error: unknown): RateLimitInfo {
  const headers = (error as { headers?: unknown })?.headers;

  const result: RateLimitInfo = {
    tokensRemaining: null,
    requestsRemaining: null,
    tokensReset: null,
    requestsReset: null,
  };

  if (headers == null) return result;

  for (const [field, headerNames] of HEADER_MAP) {
    const raw = readHeader(headers, headerNames);
    if (raw === null) continue;

    if (field === 'tokensRemaining' || field === 'requestsRemaining') {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) {
        result[field] = parsed;
      }
    } else {
      result[field] = raw;
    }
  }

  return result;
}

export function truncateErrorMessage(message: string, maxLength = 1024): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - 3) + '...';
}

import {
  AiErrorClassification,
  classifyError,
  classifyErrorDetailed,
  isRetryable,
  RETRYABLE,
  extractRateLimitHeaders,
  truncateErrorMessage,
} from './errors.js';

describe('classifyError', () => {
  // ---------------------------------------------------------------------------
  // 1. Anthropic 429 → RATE_LIMIT
  // ---------------------------------------------------------------------------
  it('classifies Anthropic 429 as RATE_LIMIT', () => {
    const err = { status: 429, error: { type: 'rate_limit_error' }, message: 'Rate limited' };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.RATE_LIMIT);
  });

  // ---------------------------------------------------------------------------
  // 2. Anthropic 529 → OVERLOADED
  // ---------------------------------------------------------------------------
  it('classifies Anthropic 529 as OVERLOADED', () => {
    const err = { status: 529, error: { type: 'overloaded_error' }, message: 'Overloaded' };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.OVERLOADED);
  });

  // ---------------------------------------------------------------------------
  // 3. Gemini/OpenAI/Bedrock 503 → OVERLOADED; Anthropic 503 → SERVER_ERROR
  // ---------------------------------------------------------------------------
  it('classifies Gemini/OpenAI/Bedrock 503 as OVERLOADED, Anthropic 503 as SERVER_ERROR', () => {
    const err = { status: 503, message: 'Service unavailable' };
    expect(classifyError(err, 'google')).toBe(AiErrorClassification.OVERLOADED);
    expect(classifyError(err, 'openai')).toBe(AiErrorClassification.OVERLOADED);
    expect(classifyError(err, 'bedrock')).toBe(AiErrorClassification.OVERLOADED);
    // Anthropic uses 529 for overload; their 503 is a true server error.
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.SERVER_ERROR);
  });

  // ---------------------------------------------------------------------------
  // 4. Anthropic 400 with content policy → CONTENT_POLICY
  // ---------------------------------------------------------------------------
  it('classifies Anthropic 400 with content error type as CONTENT_POLICY', () => {
    const err = {
      status: 400,
      error: { type: 'content_moderation_error' },
      message: 'Content was blocked',
    };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.CONTENT_POLICY);
  });

  // ---------------------------------------------------------------------------
  // 5. Anthropic 400 with context length → CONTEXT_LENGTH_EXCEEDED
  // ---------------------------------------------------------------------------
  it('classifies Anthropic 400 with context length message as CONTEXT_LENGTH_EXCEEDED', () => {
    const err = {
      status: 400,
      error: { type: 'invalid_request_error' },
      message: 'max_tokens exceeds context limit',
    };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED);
  });

  // ---------------------------------------------------------------------------
  // Typed code path takes precedence over message wording
  // ---------------------------------------------------------------------------
  it('classifies OpenAI 400 by typed error.code (context_length_exceeded)', () => {
    const err = {
      status: 400,
      error: { code: 'context_length_exceeded', type: 'invalid_request_error' },
      message: 'unrelated message',
    };
    expect(classifyError(err, 'openai')).toBe(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED);
  });

  it('classifies OpenAI 400 by typed error.code (content_filter)', () => {
    const err = {
      status: 400,
      error: { code: 'content_filter' },
    };
    expect(classifyError(err, 'openai')).toBe(AiErrorClassification.CONTENT_POLICY);
  });

  it('classifies Anthropic 400 by typed error.type (request_too_large)', () => {
    const err = {
      status: 400,
      error: { type: 'request_too_large' },
      message: 'whatever the SDK puts here',
    };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED);
  });

  it('classifies Anthropic 400 with content_-prefixed type as CONTENT_POLICY', () => {
    // `content_validation_error` isn't in the typed-code set, but the
    // Anthropic-specific prefix check still catches it.
    const err = {
      status: 400,
      error: { type: 'content_validation_error' },
      message: 'unrelated',
    };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.CONTENT_POLICY);
  });

  it('classifies Anthropic 400 message-only (no error.type) by message wording', () => {
    const err = {
      status: 400,
      message: 'request exceeds the maximum context window',
    };
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED);
  });

  it('does NOT classify "invalid token in JSON body" as CONTEXT_LENGTH_EXCEEDED', () => {
    // Regression guard for the audit's false-positive case: the previous
    // `/token|context/i` regex matched any 400 mentioning "token".
    const err = {
      status: 400,
      error: { type: 'invalid_request_error' },
      message: 'invalid token in JSON body',
    };
    expect(classifyError(err, 'openai')).toBe(AiErrorClassification.UNKNOWN);
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.UNKNOWN);
  });

  it('handles SDK message-wording drift for context-length errors', () => {
    // Audit example: a hypothetical new SDK that says "your request exceeds
    // the model's context length" should still classify correctly.
    const err = {
      status: 400,
      message: "your request exceeds the model's context length",
    };
    expect(classifyError(err, 'google')).toBe(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED);
  });

  // ---------------------------------------------------------------------------
  // 6. Network error ECONNREFUSED → NETWORK_ERROR
  // ---------------------------------------------------------------------------
  it('classifies ECONNREFUSED as NETWORK_ERROR', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.NETWORK_ERROR);
  });

  it('classifies ENETUNREACH as NETWORK_ERROR', () => {
    const err = Object.assign(new Error('Network is unreachable'), { code: 'ENETUNREACH' });
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.NETWORK_ERROR);
  });

  it('classifies ECONNREFUSED nested in error.cause (undici fetch shape) as NETWORK_ERROR', () => {
    const cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.NETWORK_ERROR);
  });

  it('classifies ETIMEDOUT nested in error.cause as TIMEOUT', () => {
    const cause = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.TIMEOUT);
  });

  // ---------------------------------------------------------------------------
  // 7. Timeout ETIMEDOUT → TIMEOUT
  // ---------------------------------------------------------------------------
  it('classifies ETIMEDOUT as TIMEOUT', () => {
    const err = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
    expect(classifyError(err, 'google')).toBe(AiErrorClassification.TIMEOUT);
  });

  it('classifies undici timeout codes as TIMEOUT', () => {
    for (const code of [
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]) {
      const err = Object.assign(new Error(`undici ${code}`), { code });
      expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.TIMEOUT);
    }
  });

  // HTTP 408/504 are timeout statuses
  it('classifies HTTP 408 (Request Timeout) as TIMEOUT', () => {
    expect(classifyError({ status: 408 }, 'anthropic')).toBe(AiErrorClassification.TIMEOUT);
    expect(classifyError({ status: 408 }, 'google')).toBe(AiErrorClassification.TIMEOUT);
  });

  it('classifies HTTP 504 (Gateway Timeout) as TIMEOUT', () => {
    expect(classifyError({ status: 504 }, 'anthropic')).toBe(AiErrorClassification.TIMEOUT);
    expect(classifyError({ status: 504 }, 'openai')).toBe(AiErrorClassification.TIMEOUT);
  });

  it('classifies unclassified status + timeout message as TIMEOUT via default case', () => {
    // HTTP 425 "Too Early" is not in the switch — message check in default: fires
    expect(
      classifyError({ status: 425, message: 'upstream request timeout exceeded' }, 'openai'),
    ).toBe(AiErrorClassification.TIMEOUT);
    // Classified statuses should NOT be overridden by message
    expect(classifyError({ status: 429, message: 'request timeout' }, 'openai')).toBe(
      AiErrorClassification.RATE_LIMIT,
    );
  });

  it('classifies Cloudflare 5xx codes (520-524) as SERVER_ERROR', () => {
    for (const status of [520, 521, 522, 523, 524]) {
      expect(classifyError({ status }, 'anthropic')).toBe(AiErrorClassification.SERVER_ERROR);
    }
  });

  // 529 should only map to OVERLOADED for Anthropic
  it('classifies non-Anthropic 529 as UNKNOWN (provider-gated)', () => {
    expect(classifyError({ status: 529 }, 'google')).toBe(AiErrorClassification.UNKNOWN);
    expect(classifyError({ status: 529 }, 'openai')).toBe(AiErrorClassification.UNKNOWN);
    // Anthropic 529 still maps to OVERLOADED (covered above in test #2)
    expect(classifyError({ status: 529 }, 'anthropic')).toBe(AiErrorClassification.OVERLOADED);
  });
});

describe('isRetryable', () => {
  // ---------------------------------------------------------------------------
  // 8. Retryable classifications return true
  // ---------------------------------------------------------------------------
  it('returns true for retryable classifications', () => {
    expect(isRetryable(AiErrorClassification.RATE_LIMIT)).toBe(true);
    expect(isRetryable(AiErrorClassification.OVERLOADED)).toBe(true);
    expect(isRetryable(AiErrorClassification.TIMEOUT)).toBe(true);
    expect(isRetryable(AiErrorClassification.SERVER_ERROR)).toBe(true);
    expect(isRetryable(AiErrorClassification.NETWORK_ERROR)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 9. Non-retryable classifications return false
  // ---------------------------------------------------------------------------
  it('returns false for non-retryable classifications', () => {
    expect(isRetryable(AiErrorClassification.AUTHENTICATION)).toBe(false);
    expect(isRetryable(AiErrorClassification.CONTENT_POLICY)).toBe(false);
    expect(isRetryable(AiErrorClassification.CONTEXT_LENGTH_EXCEEDED)).toBe(false);
    expect(isRetryable(AiErrorClassification.NOT_FOUND)).toBe(false);
    expect(isRetryable(AiErrorClassification.UNKNOWN)).toBe(false);
  });
});

describe('RETRYABLE export', () => {
  it('exports the retryable classification set, agreeing with isRetryable', () => {
    expect(RETRYABLE).toBeInstanceOf(Set);
    for (const cls of Object.values(AiErrorClassification)) {
      expect(RETRYABLE.has(cls)).toBe(isRetryable(cls));
    }
  });

  it('contains exactly the five retryable categories', () => {
    expect(RETRYABLE.size).toBe(5);
    expect(RETRYABLE.has(AiErrorClassification.RATE_LIMIT)).toBe(true);
    expect(RETRYABLE.has(AiErrorClassification.OVERLOADED)).toBe(true);
    expect(RETRYABLE.has(AiErrorClassification.TIMEOUT)).toBe(true);
    expect(RETRYABLE.has(AiErrorClassification.SERVER_ERROR)).toBe(true);
    expect(RETRYABLE.has(AiErrorClassification.NETWORK_ERROR)).toBe(true);
  });
});

describe('extractRateLimitHeaders', () => {
  // ---------------------------------------------------------------------------
  // 10. Extracts Anthropic rate limit headers
  // ---------------------------------------------------------------------------
  it('extracts Anthropic rate limit headers from error object', () => {
    const err = {
      status: 429,
      headers: {
        'anthropic-ratelimit-tokens-remaining': '500',
        'anthropic-ratelimit-requests-remaining': '10',
        'anthropic-ratelimit-tokens-reset': '2025-01-15T10:00:00Z',
        'anthropic-ratelimit-requests-reset': '2025-01-15T10:00:00Z',
      },
    };

    const info = extractRateLimitHeaders(err);
    expect(info!.tokensRemaining).toBe(500);
    expect(info!.requestsRemaining).toBe(10);
    expect(info!.tokensReset).toBe('2025-01-15T10:00:00Z');
    expect(info!.requestsReset).toBe('2025-01-15T10:00:00Z');
  });

  // distinguish "no headers" from "headers present, no rate-limit fields"
  it('returns null when error has no headers', () => {
    const err = { status: 500, message: 'Internal server error' };
    const info = extractRateLimitHeaders(err);
    expect(info).toBeNull();
  });

  it('returns RateLimitInfo with all-null fields when headers present but no rate-limit headers parsed', () => {
    const err = {
      status: 500,
      headers: { 'content-type': 'application/json' },
    };
    const info = extractRateLimitHeaders(err);
    expect(info).not.toBeNull();
    expect(info!.tokensRemaining).toBeNull();
    expect(info!.requestsRemaining).toBeNull();
    expect(info!.tokensReset).toBeNull();
    expect(info!.requestsReset).toBeNull();
  });

  it('extracts Gemini rate limit headers', () => {
    const err = {
      status: 429,
      headers: {
        'x-goog-quota-tokens-remaining': '3000',
        'x-goog-quota-requests-remaining': '50',
        'x-ratelimit-reset': '2026-01-01T00:01:00Z',
      },
    };
    const info = extractRateLimitHeaders(err);
    expect(info!.tokensRemaining).toBe(3000);
    expect(info!.requestsRemaining).toBe(50);
    expect(info!.requestsReset).toBe('2026-01-01T00:01:00Z');
  });

  it('extracts Mistral rate limit headers', () => {
    const err = {
      status: 429,
      headers: {
        'x-ratelimit-remaining-tokens-minute': '12000',
        'x-ratelimit-remaining-requests-minute': '40',
        'x-ratelimit-reset-tokens-minute': '30',
        'x-ratelimit-reset-requests-minute': '30',
      },
    };
    const info = extractRateLimitHeaders(err);
    expect(info!.tokensRemaining).toBe(12000);
    expect(info!.requestsRemaining).toBe(40);
    expect(info!.tokensReset).toBe('30');
    expect(info!.requestsReset).toBe('30');
  });

  it('treats empty-string header value as null (not 0) for numeric fields', () => {
    const err = {
      status: 429,
      headers: { 'anthropic-ratelimit-tokens-remaining': '' },
    };
    const info = extractRateLimitHeaders(err);
    // Empty string → Number('') === 0, but guard must treat it as absent
    expect(info!.tokensRemaining).toBeNull();
    // A genuine '0' value (zero remaining) must still be stored
    const zeroErr = { status: 429, headers: { 'anthropic-ratelimit-tokens-remaining': '0' } };
    const zeroInfo = extractRateLimitHeaders(zeroErr);
    expect(zeroInfo!.tokensRemaining).toBe(0);
  });

  it('supports Response-like headers with get() method', () => {
    const headersMap = new Map([
      ['x-ratelimit-remaining-tokens', '200'],
      ['x-ratelimit-remaining-requests', '5'],
    ]);
    const err = {
      status: 429,
      headers: { get: (name: string) => headersMap.get(name) ?? null },
    };

    const info = extractRateLimitHeaders(err);
    expect(info!.tokensRemaining).toBe(200);
    expect(info!.requestsRemaining).toBe(5);
  });

  // readHeader must reject non-primitive header values
  // rather than `String(val)`-stringifying them into '[object Object]' or
  // 'a,b,c'. Each of these inputs gets returned as null so the caller sees
  // the same "no value" path as a missing header.
  describe('readHeader rejects non-primitive header values', () => {
    it('returns null when the header value is an array', () => {
      const err = {
        status: 429,
        headers: { 'anthropic-ratelimit-tokens-remaining': ['500', '600'] },
      };
      const info = extractRateLimitHeaders(err);
      expect(info!.tokensRemaining).toBeNull();
    });

    it('returns null when the header value is a plain object', () => {
      const err = {
        status: 429,
        headers: {
          'anthropic-ratelimit-tokens-remaining': { value: 500 },
        },
      };
      const info = extractRateLimitHeaders(err);
      expect(info!.tokensRemaining).toBeNull();
    });

    it('returns null when the header value is a Symbol', () => {
      const err = {
        status: 429,
        headers: {
          'anthropic-ratelimit-tokens-remaining': Symbol('500'),
        },
      };
      const info = extractRateLimitHeaders(err);
      expect(info!.tokensRemaining).toBeNull();
    });

    it('returns null when the header value is null or undefined', () => {
      const err1 = {
        status: 429,
        headers: { 'anthropic-ratelimit-tokens-remaining': null },
      };
      expect(extractRateLimitHeaders(err1)!.tokensRemaining).toBeNull();

      const err2 = {
        status: 429,
        headers: { 'anthropic-ratelimit-tokens-remaining': undefined },
      };
      expect(extractRateLimitHeaders(err2)!.tokensRemaining).toBeNull();
    });

    it('still returns numeric string values (the primitive fast path)', () => {
      const err = {
        status: 429,
        headers: { 'anthropic-ratelimit-tokens-remaining': '500' },
      };
      expect(extractRateLimitHeaders(err)!.tokensRemaining).toBe(500);
    });
  });
});

describe('truncateErrorMessage', () => {
  // ---------------------------------------------------------------------------
  // 11. Truncates long messages, passes short ones through
  // ---------------------------------------------------------------------------
  it('truncates messages over maxLength and appends ...', () => {
    const long = 'x'.repeat(2000);
    const truncated = truncateErrorMessage(long);
    expect(truncated).toHaveLength(1024);
    expect(truncated.endsWith('...')).toBe(true);
    expect(truncated.slice(0, 1021)).toBe('x'.repeat(1021));
  });

  it('passes short messages through unchanged', () => {
    expect(truncateErrorMessage('short error')).toBe('short error');
  });

  it('respects custom maxLength', () => {
    const msg = 'a'.repeat(100);
    const truncated = truncateErrorMessage(msg, 50);
    expect(truncated).toHaveLength(50);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('clamps maxLength to 4 when caller passes a value below 4', () => {
    const result = truncateErrorMessage('hello', 2);
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result.endsWith('...')).toBe(true);
  });

  it('truncates to exactly 4 chars when maxLength=4', () => {
    expect(truncateErrorMessage('hello', 4)).toBe('h...');
  });

  it('does not produce a lone high surrogate when cut lands between a surrogate pair', () => {
    // '😀' is U+1F600 — two UTF-16 code units: \uD83D (index 6) \uDE00 (index 7)
    // 'hello 😀 world': h(0) e(1) l(2) l(3) o(4) ' '(5) \uD83D(6) \uDE00(7) ' '(8)...
    const msg = 'hello 😀 world';
    // maxLength=10 → safeMax=10 → cut=7 → charCodeAt(6)=\uD83D (high surrogate)
    // step-back fires: cut becomes 6, result is 'hello ...' (no lone surrogate).
    const result = truncateErrorMessage(msg, 10);
    // The character immediately before '...' must not be a high surrogate.
    const charBeforeSuffix = result.charCodeAt(result.length - 4); // char before '...'
    expect(charBeforeSuffix < 0xd800 || charBeforeSuffix > 0xdbff).toBe(true);
    expect(result.endsWith('...')).toBe(true);
    // Verify the step-back actually fired: result is 'hello ...' not 'hello \uD83D...'
    expect(result).toBe('hello ...');
  });
});

// classifyErrorDetailed exposes original context
describe('classifyErrorDetailed', () => {
  it('returns the same classification as classifyError plus context', () => {
    const err = { status: 429, error: { type: 'rate_limit_error' }, message: 'Slow down' };
    const detailed = classifyErrorDetailed(err, 'anthropic');
    expect(detailed.classification).toBe(AiErrorClassification.RATE_LIMIT);
    expect(detailed.classification).toBe(classifyError(err, 'anthropic'));
    expect(detailed.originalMessage).toBe('Slow down');
    expect(detailed.status).toBe(429);
  });

  it('extracts string code when present', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const detailed = classifyErrorDetailed(err, 'anthropic');
    expect(detailed.classification).toBe(AiErrorClassification.NETWORK_ERROR);
    expect(detailed.code).toBe('ECONNREFUSED');
    expect(detailed.status).toBeNull();
    expect(detailed.originalMessage).toBe('connect ECONNREFUSED');
  });

  it('returns null fields when properties are missing or non-primitive', () => {
    const detailed = classifyErrorDetailed({}, 'anthropic');
    expect(detailed.classification).toBe(AiErrorClassification.UNKNOWN);
    expect(detailed.originalMessage).toBeNull();
    expect(detailed.status).toBeNull();
    expect(detailed.code).toBeNull();
  });

  it('returns null status when status is non-numeric', () => {
    const err = { status: 'oops' as unknown as number, message: 'no good' };
    const detailed = classifyErrorDetailed(err, 'anthropic');
    expect(detailed.status).toBeNull();
    expect(detailed.classification).toBe(AiErrorClassification.UNKNOWN);
  });

  it('returns null originalMessage when message is empty string', () => {
    const err = { status: 500, message: '' };
    const detailed = classifyErrorDetailed(err, 'anthropic');
    // Empty string is treated as "no message" so callers don't have to special-case it.
    expect(detailed.originalMessage).toBeNull();
    expect(detailed.classification).toBe(AiErrorClassification.SERVER_ERROR);
  });
});

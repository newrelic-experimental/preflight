import {
  AiErrorClassification,
  classifyError,
  isRetryable,
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
  // 3. Gemini 503 → OVERLOADED (not SERVER_ERROR)
  // ---------------------------------------------------------------------------
  it('classifies Gemini 503 as OVERLOADED', () => {
    const err = { status: 503, message: 'Service unavailable' };
    expect(classifyError(err, 'google')).toBe(AiErrorClassification.OVERLOADED);

    // Same status for Anthropic → SERVER_ERROR
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
  // 6. Network error ECONNREFUSED → NETWORK_ERROR
  // ---------------------------------------------------------------------------
  it('classifies ECONNREFUSED as NETWORK_ERROR', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
    (err as any).code = 'ECONNREFUSED';
    expect(classifyError(err, 'anthropic')).toBe(AiErrorClassification.NETWORK_ERROR);
  });

  // ---------------------------------------------------------------------------
  // 7. Timeout ETIMEDOUT → TIMEOUT
  // ---------------------------------------------------------------------------
  it('classifies ETIMEDOUT as TIMEOUT', () => {
    const err = new Error('Request timed out');
    (err as any).code = 'ETIMEDOUT';
    expect(classifyError(err, 'google')).toBe(AiErrorClassification.TIMEOUT);
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
    expect(info.tokensRemaining).toBe(500);
    expect(info.requestsRemaining).toBe(10);
    expect(info.tokensReset).toBe('2025-01-15T10:00:00Z');
    expect(info.requestsReset).toBe('2025-01-15T10:00:00Z');
  });

  it('returns all-null when error has no headers', () => {
    const err = { status: 500, message: 'Internal server error' };
    const info = extractRateLimitHeaders(err);
    expect(info.tokensRemaining).toBeNull();
    expect(info.requestsRemaining).toBeNull();
    expect(info.tokensReset).toBeNull();
    expect(info.requestsReset).toBeNull();
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
    expect(info.tokensRemaining).toBe(200);
    expect(info.requestsRemaining).toBe(5);
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
});

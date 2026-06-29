// ---------------------------------------------------------------------------
// redact() — defensively strip secret-shaped fields before logging or
// serialization. Matches keys (case-insensitive) against a denylist of
// secret-bearing names; replaces matching values with the literal string
// '***'.
//
// The library handles credentials (license keys, OTLP auth headers, provider
// API keys) and provider responses that may contain user prompt fragments.
// Callers should pass any object containing config or response data through
// redact() before handing it to a logger or external sink.
//
// safeForLog(config) — convenience wrapper that returns a redacted copy of an
// AgentConfig, suitable for diagnostic dumps.
// ---------------------------------------------------------------------------

import type { AgentConfig } from './config.js';

// Pattern notes:
// - `key(?!s)` matches `apiKey`, `licenseKey`, bare `key`, but NOT `keys` (plural).
//   The `\b` word-boundary upgrade that was applied to `token\b` and
//   `credentials?\b` cannot be applied here: CamelCase names like `licenseKey`
//   and `apiKey` do NOT have a word boundary before the `K` (both sides are word chars),
//   so `\bkey` would FAIL to match them (deliberate false-positive trade-off).
//   Mid-word false positives (`monkey`, `jockey`) are accepted in exchange for reliably
//   redacting all camelCase key properties. A regex-only fix is not feasible without
//   enumerating every legitimate CamelCase prefix, which would miss future additions.
// - `token\b` matches `apiToken`, `accessToken`, bare `token`, but NOT `tokenCount`,
//   `tokenize`, `tokenAmount`, etc. The `\b` works here because `token` almost
//   never appears mid-word in legitimate property names.
// - `credentials?\b` matches `credential` and `credentials`, but NOT `credentialType`,
//   `credentialProvider`, etc. Same fix applied to `passwords?\b`.
const SECRET_KEY_RE = /key(?!s)|token\b|secret|passwords?\b|authorization|credentials?\b|bearer/i;
const REDACTED = '***';
const MAX_DEPTH = 8;

/**
 * Returns a redacted deep copy of `value`. Walks objects and arrays up to
 * MAX_DEPTH; replaces any string/number/boolean value whose KEY (in the
 * containing object) matches the secret-key denylist with the literal '***'.
 *
 * - Strings outside the denylist are returned as-is (no value-pattern matching;
 *   that would risk false positives on legitimate values like model names).
 * - Cycles are detected via per-path ancestor tracking and returned as `'[circular]'`.
 *   DAG-shaped objects (same reference at sibling positions) are walked in full.
 * - Functions, symbols, undefined are returned as-is (they don't serialize anyway).
 * - **`Map` and `Set` values are NOT walked for secrets** — they are summarized
 *   as `'[Map(N)]'` / `'[Set(N)]'` because `Object.entries` does not enumerate
 *   their contents. If credentials are stored as Map entries under a
 *   non-secret key (e.g. `{ headers: new Map([['Authorization', 'Bearer x']]) }`),
 *   they will NOT be redacted. Convert to plain objects before passing to `redact()`.
 */
export function redact<T>(value: T): T {
  return redactInner(value, 0, new WeakSet()) as T;
}

function redactInner(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || typeof value !== 'object') return value;
  // Use per-path ancestor tracking so DAG-shaped objects (the same reference
  // appearing at two sibling positions) are walked in full; only true cycles
  // (an ancestor of the current node) are collapsed to '[circular]'.
  if (ancestors.has(value as object)) return '[circular]';
  ancestors.add(value as object);

  try {
    if (Array.isArray(value)) {
      return value.map((v) => redactInner(v, depth + 1, ancestors));
    }

    // Host objects that store their data in internal slots, not enumerable
    // properties — walking via Object.entries produces {} or garbled output.
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof URL ||
      (typeof Buffer !== 'undefined' && value instanceof Buffer) ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    if (value instanceof Map) return `[Map(${value.size})]`;
    if (value instanceof Set) return `[Set(${value.size})]`;

    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) {
        result[key] = v == null ? v : REDACTED;
      } else {
        result[key] = redactInner(v, depth + 1, ancestors);
      }
    }
    return result;
  } finally {
    ancestors.delete(value as object);
  }
}

/**
 * Returns a redacted copy of the given `AgentConfig`, suitable for diagnostic
 * dumps to logs, support tickets, or operator UIs. `licenseKey` becomes
 * `'***'`; values inside `otlpHeaders` whose key matches the secret denylist
 * (`Authorization`, `api-key`, etc.) are also replaced. All other fields
 * (`appName`, `collectorHost`, `accountId`, `transport`, `recordContent`,
 * `highSecurity`, etc.) pass through unchanged so the output stays useful.
 *
 * Keep `redact()` for arbitrary objects; reach for `safeForLog()` when you
 * specifically have an `AgentConfig` and want a typed return.
 */
export function safeForLog(config: AgentConfig): Readonly<AgentConfig> {
  return Object.freeze(redact(config));
}

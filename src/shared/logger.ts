import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Type-safe narrowing helper. The previous
 * `envLevel in LOG_LEVEL_ORDER` check + `as LogLevel` cast was sound at
 * runtime today but the cast hid the gap: TS can't narrow `string` to a
 * literal union via `in`, so a refactor that broadened `LOG_LEVEL_ORDER`
 * (e.g. added `trace`) would silently let `envLevel` flow through with
 * the wrong type. Explicit type guard removes the cast and makes the
 * literal-union membership check the single source of truth.
 */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function resolveLogLevel(): LogLevel {
  const envLevel = process.env.NEW_RELIC_AI_LOG_LEVEL?.toLowerCase();
  if (envLevel !== undefined && isLogLevel(envLevel)) {
    return envLevel;
  }
  return 'info';
}

/**
 * Cached resolved log level.
 *
 * Previously, every `createLogger()` call re-read `NEW_RELIC_AI_LOG_LEVEL`
 * from the env. If a process changed the env between two calls — common
 * in tests that flip it per-block — the two loggers ended up with
 * different levels, producing flapping behavior that was hard to debug.
 *
 * Now: resolve once on first use and reuse the cached value. Production
 * code is unaffected (the env is set once at startup); tests that need to
 * exercise different levels at runtime call `__resetLogLevelCache()` after
 * mutating the env, or pass an explicit `levelOverride` to `createLogger`.
 */
let cachedMinLevel: LogLevel | null = null;

function getMinLevel(): LogLevel {
  if (cachedMinLevel === null) {
    cachedMinLevel = resolveLogLevel();
  }
  return cachedMinLevel;
}

/**
 * Re-arm the env-resolved log level cache so the next `createLogger()`
 * call reads `NEW_RELIC_AI_LOG_LEVEL` again.
 *
 * @internal Test-only. The double-underscore prefix signals that this is NOT
 * part of the public API and MUST NOT be called in production code — calling it
 * in a running agent would cause all loggers to re-read the log level env var
 * on the next emit, defeating the intentional caching behaviour.
 */
export function __resetLogLevelCache(): void {
  cachedMinLevel = null;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /**
   * Return a child logger that pre-binds `context` onto every emitted entry.
   * Per-call `data` still wins on key collision. Useful
   * for tracing one harvest cycle / one request through multiple log lines
   * without manually threading the same `requestId` through every call.
   *
   *     const reqLogger = logger.child({ requestId: 'abc-12345' });
   *     reqLogger.warn('Bad gateway', { statusCode: 502 });
   *     // → { ..., requestId: 'abc-12345', statusCode: 502, ... }
   *
   * Calling `child` on a child re-merges (per-call wins), so chains compose.
   *
   * **Level inheritance.** The child inherits the parent's fixed `levelOverride`
   * (set at `createLogger` time). Canonical fields (`level`, `message`,
   * `component`, `timestamp`, `epoch_ms`) cannot be overridden via either
   * bound context or per-call `data` — they always reflect the call site values.
   */
  child(context: Record<string, unknown>): Logger;
}

/**
 * Create a logger.
 *
 * @param component  Identifier emitted as `component` on every log entry.
 *                   Convention: kebab-case module name (e.g. `'harvest-scheduler'`).
 * @param levelOverride
 *   Optional per-component minimum level. Pins this
 *   logger to the specified level for its lifetime, ignoring the
 *   process-wide `NEW_RELIC_AI_LOG_LEVEL` env var. Use this when one
 *   noisy module needs to be quieter (or louder) than the rest of the
 *   library — e.g.:
 *
 *       const logger = createLogger('http-client', 'error');
 *
 *   makes the http-client module emit only errors regardless of how the
 *   rest of the process is configured. Without an override, the level
 *   resolves from the env (cached) and tracks
 *   process-wide changes via `__resetLogLevelCache()`.
 */
export function createLogger(component: string, levelOverride?: LogLevel): Logger {
  return createLoggerInternal(component, levelOverride, undefined);
}

function createLoggerInternal(
  component: string,
  levelOverride: LogLevel | undefined,
  boundContext: Record<string, unknown> | undefined,
): Logger {
  // When no override is supplied, the minimum level is
  // resolved per-log-call via the cached `getMinLevel()` so a process-wide
  // log-level change (env mutation + cache reset) takes effect immediately
  // for already-constructed loggers — without a Map lookup penalty in the
  // common case (cached read after first call). When `levelOverride` is
  // explicit, it pins the level for this logger's lifetime.
  const fixedLevelOrder = levelOverride !== undefined ? LOG_LEVEL_ORDER[levelOverride] : null;

  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const minLevelOrder = fixedLevelOrder ?? LOG_LEVEL_ORDER[getMinLevel()];
    if (LOG_LEVEL_ORDER[level] < minLevelOrder) return;

    // Defensively redact secret-shaped keys from caller-supplied `data`
    // before merging into the log entry. Callers occasionally pass through
    // config objects (`{ ...config }`) or response payloads that contain
    // licenseKey / authorization headers; without this guard those fields
    // would land in stderr verbatim.
    const safeData = data === undefined ? undefined : redact(data);

    const now = new Date();
    const entry = {
      // Bound context first, per-call data wins on key collision.
      // Canonical fields come last so callers cannot accidentally overwrite
      // level, message, component, timestamp, or epoch_ms.
      ...(boundContext ?? {}),
      ...safeData,
      timestamp: now.toISOString(),
      // epoch_ms alongside ISO timestamp for NR Logs API ingestion.
      epoch_ms: now.getTime(),
      level,
      component,
      message,
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      // Per-field fallback. JSON.stringify on the whole entry threw,
      // but most fields are probably fine — only one or two values are bad
      // (e.g. a BigInt buried in caller data). Walk top-level keys and
      // replace ONLY the offending ones with '[unserializable]', so
      // operator-useful siblings (timestamp, level, component, message,
      // and any well-formed data fields) still surface. `data` is spread
      // into entry via `...safeData` above, so its keys are already
      // top-level here.
      // NOTE: this walk operates on top-level entry keys only. If a
      // data field is a nested object containing an unserializable value
      // (e.g. `data = { outer: { amount: 1n } }`), the entire `outer` key is
      // replaced with '[unserializable]' — not just the `amount` sub-key.
      // Per-field precision applies only at depth 1 (the entry level).
      const safeEntry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        try {
          JSON.stringify(v);
          safeEntry[k] = v;
        } catch {
          safeEntry[k] = '[unserializable]';
        }
      }
      serialized = JSON.stringify(safeEntry);
    }
    // Prefer console.error over a raw process.stderr.write. Both go to
    // the same underlying stream, but console.error uses Node's Console
    // implementation which handles formatting and any future buffering
    // changes — and it keeps log output cooperative with consumer code that
    // intercepts console.* (Jest, debugger UIs, log forwarders).
    console.error(serialized);
  }

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
    child: (context) =>
      createLoggerInternal(component, levelOverride, {
        ...(boundContext ?? {}),
        // Redacting at child-creation time avoids re-running redact() on the
        // bound context per log call. Note: per-call data is still
        // redacted on every emit — only bound context gets the
        // creation-time optimization.
        ...(redact(context) as Record<string, unknown>),
      }),
  };
}

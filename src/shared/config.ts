import type { LogLevel } from './logger.js';
import { createLogger } from './logger.js';
import type { TransportMode } from './transport/types.js';
import { DEFAULT_CLIENT_NAME, sanitizeClientString } from './transport/otlp-shared.js';

/**
 * Strings that count as `true`. The lowercased env
 * value is checked against these literal sets — any other value falls
 * through to the default.
 */
const ENV_TRUTHY = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Module-level config logger. The underlying
 * `createLogger` now resolves the minimum log level per-call via the cached
 * `getMinLevel()`, so a runtime env mutation followed by `__resetLogLevelCache()`
 * propagates here without re-constructing this logger.
 */
const configLogger = createLogger('config');

export interface AgentConfig {
  readonly licenseKey: string;
  readonly appName: string;
  readonly enabled: boolean;
  readonly recordContent: boolean;
  readonly costTrackingEnabled: boolean;
  readonly qualityTrackingEnabled: boolean;
  readonly conversationTrackingEnabled: boolean;
  readonly thinkingTrackingEnabled: boolean;
  readonly customPricingFile: string | null;
  readonly contentMaxLength: number;
  readonly highSecurity: boolean;
  readonly logLevel: LogLevel;
  readonly collectorHost: string | null;
  readonly accountId: string | null;
  readonly attributionDefaults: Record<string, string> | null;
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly transport: TransportMode;
  /**
   * Identifies the consuming client in telemetry identifiers: HTTP
   * `User-Agent` headers and OTel instrumentation scope / logger names.
   * Defaults to `'ai-telemetry'` when not set.
   *
   * Pass `'preflight'` from the Preflight MCP server or `'nr-ai-agent'`
   * from the TypeScript agent so telemetry from each consumer is
   * distinguishable in the NR UI.
   */
  readonly clientName: string;
  /**
   * Version of the consuming client, used in the `User-Agent` header
   * (e.g. `'1.2.0'`). Pass the consuming package's own version so NR
   * collector logs identify the exact client release. Defaults to `''`.
   */
  readonly clientVersion: string;
}

/**
 * Parse a boolean environment variable. Accepts `true|1|yes|on` as truthy
 * and `false|0|no|off` as falsy (case-insensitive). Any
 * other value (or missing env var) returns the default. Unknown values emit
 * a debug log so misconfigurations are diagnosable.
 */
function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const val = raw.toLowerCase().trim();
  if (ENV_TRUTHY.has(val)) return true;
  if (ENV_FALSY.has(val)) return false;
  configLogger.debug(
    `${key}: unrecognized boolean value, falling back to default. Accepted: true|1|yes|on or false|0|no|off`,
    { value: raw, defaultValue },
  );
  return defaultValue;
}

/**
 * Parse an integer environment variable. Out-of-bound values are clamped to
 * the bound and emit a debug log so the override is observable.
 */
function envInt(
  key: string,
  defaultValue: number,
  bounds?: { min?: number; max?: number },
): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  // Reject values with trailing garbage (e.g. '4kb', '1e3') that parseInt
  // would accept silently; fall back to the default with a diagnostic log.
  if (!/^-?\d+$/.test(val.trim())) {
    configLogger.debug(`${key}: not a valid integer, using default`, { value: val, defaultValue });
    return defaultValue;
  }
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  if (bounds?.min !== undefined && parsed < bounds.min) {
    configLogger.debug(`${key}: value clamped to min`, { requested: parsed, min: bounds.min });
    return bounds.min;
  }
  if (bounds?.max !== undefined && parsed > bounds.max) {
    configLogger.debug(`${key}: value clamped to max`, { requested: parsed, max: bounds.max });
    return bounds.max;
  }
  return parsed;
}

function envLogLevel(key: string, defaultValue: LogLevel): LogLevel {
  const val = process.env[key]?.toLowerCase().trim();
  if (val === 'debug' || val === 'info' || val === 'warn' || val === 'error') return val;
  if (val !== undefined) {
    // Use warn (not debug) so the diagnostic is visible even at the fallback
    // 'info' log level — an invalid log level is always worth surfacing.
    configLogger.warn(`${key}: unrecognized log level, using default`, {
      value: val,
      defaultValue,
    });
  }
  return defaultValue;
}

// Returns the env var value, or null if the var is absent or empty string.
// `export VAR=` in a shell produces '' — treat that the same as unset.
function envOrNull(key: string): string | null {
  const v = process.env[key];
  return v === undefined || v === '' ? null : v;
}

// Normalize a string override value: undefined passes through (fall back to
// env); empty string coerces to null; any other value (including null) wins
// over the env var. Mirrors envOrNull for the override path.
function overrideString(v: string | null | undefined, envFn: () => string | null): string | null {
  if (v === undefined) return envFn();
  return v === '' ? null : v;
}

/**
 * Parse the transport-mode env var. Accepts the same
 * values as the `transport` field on `AgentConfig`. Unrecognized values
 * fall back to the default and emit a debug log so misconfigurations are
 * diagnosable.
 */
function envTransport(key: string, defaultValue: TransportMode): TransportMode {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const val = raw.toLowerCase().trim();
  if (val === 'nr-events-api' || val === 'otlp' || val === 'both') return val;
  configLogger.debug(
    `${key}: unrecognized transport, falling back to default. Accepted: nr-events-api | otlp | both`,
    { value: raw, defaultValue },
  );
  return defaultValue;
}

function buildAttributionDefaults(
  overrideDefaults?: Record<string, string | undefined> | null,
): Record<string, string> | null {
  const result: Record<string, string> = {};

  // Env-var defaults for the four standard attribution fields.
  //
  // Empty-string env values are intentionally treated as
  // "not set" via the truthiness check below. NR's events API rejects empty
  // string attribute values, so a deliberately-empty env var (e.g. to "clear"
  // a higher-precedence default) would only produce a 400 at ingest time —
  // not the desired clear semantics. Consumers wanting to clear a default
  // should pass `attributionDefaults: { feature: undefined }` (or omit the
  // key entirely from overrides), not set the env var to "".
  const envFeature = process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE;
  const envTeam = process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM;
  const envUser = process.env.NEW_RELIC_AI_ATTRIBUTION_USER;
  const envEnvironment = process.env.NEW_RELIC_AI_ATTRIBUTION_ENVIRONMENT;

  // Truthiness check: exclude undefined (not set) and '' (empty — NR Events
  // API rejects empty-string attributes). Do NOT exclude '0' or
  // 'false' — those are valid attribution tag values.
  if (envFeature !== undefined && envFeature !== '') result.feature = envFeature;
  if (envTeam !== undefined && envTeam !== '') result.team = envTeam;
  if (envUser !== undefined && envUser !== '') result.user = envUser;
  if (envEnvironment !== undefined && envEnvironment !== '') result.environment = envEnvironment;

  // Merge override defaults (they win over env vars).
  // Passing `undefined` as a value explicitly removes the key so that
  // `attributionDefaults: { feature: undefined }` clears a prior env-set
  // default, matching the documented "clear" pattern.
  if (overrideDefaults) {
    for (const [k, v] of Object.entries(overrideDefaults)) {
      if (v === undefined) {
        delete result[k];
      } else {
        result[k] = v;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Per OTel spec for OTEL_EXPORTER_OTLP_HEADERS:
//   - Comma-separated list of `key=value` pairs.
//   - `=` and `,` inside a key OR value must be percent-encoded as `%3D` and `%2C`.
//   - Whitespace around the `=` is stripped.
//   - Only the FIRST `=` separates key from value (so a value can legitimately
//     contain `=` if it appears later in the substring after percent-decoding).
//   - Keys and values are percent-decoded after splitting.
function parseOtlpHeaders(headerString: string | undefined): Record<string, string> {
  if (!headerString) return {};
  const result: Record<string, string> = {};
  for (const pair of headerString.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue; // missing '=' or empty key — skip
    // OTel spec: trim key whitespace; do NOT trim value.
    const rawKey = pair.slice(0, eqIdx).trim();
    const rawValue = pair.slice(eqIdx + 1);
    if (!rawKey) continue;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // Warn so operators can diagnose a misconfigured auth header that
      // will be forwarded malformed and likely rejected by the OTLP collector.
      configLogger.warn(
        'OTEL_EXPORTER_OTLP_HEADERS: malformed percent-encoding in key — using raw string',
        { rawKey },
      );
      key = rawKey;
    }
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Same as key path — warn so a broken Authorization value is visible.
      configLogger.warn(
        'OTEL_EXPORTER_OTLP_HEADERS: malformed percent-encoding in value — using raw string',
        { rawKey },
      );
      value = rawValue;
    }
    result[key] = value;
  }
  return result;
}

// License keys must be printable ASCII (no whitespace, no control chars)
// and a plausible length. We're deliberately lenient on the exact format
// (no NRAL-suffix enforcement) to avoid false-rejecting older keys, but
// strict enough to catch common mistakes: trailing newlines from `cat`
// pipes, embedded CR/LF (would inject HTTP headers), or empty strings.
const LICENSE_KEY_RE = /^[\x21-\x7E]{20,128}$/;

/**
 * Load and validate agent config from `process.env`, with optional `overrides`
 * winning over the env values. Returns a deep-frozen `AgentConfig` so the
 * result cannot be mutated by accident or by a buggy consumer that holds a
 * shared reference.
 *
 * Precedence: `overrides` (when present per key) > env vars > defaults. The
 * function is stateless from the library's perspective — call it again to
 * pick up env-var changes (the SIGHUP pattern).
 *
 * License-key validation enforces a printable-ASCII regex (20–128 chars,
 * no whitespace) — strict enough to catch trailing newlines from `cat` pipes
 * and empty strings, lenient enough to accept older keys without an `NRAL`
 * suffix. Never logs the key value.
 *
 * @param overrides Optional partial config that wins over env vars.
 * @returns Deep-frozen `AgentConfig`.
 * @throws If `licenseKey` is missing or malformed.
 */
// Allows callers to pass `attributionDefaults: { feature: undefined }` to
// clear an env-set default. The resolved AgentConfig always contains
// only string values; the undefined is consumed at merge time.
// Exported so callers can type their partial config objects without using
// the opaque `Parameters<typeof loadConfig>[0]`.
export type AgentConfigInput = Omit<Partial<AgentConfig>, 'attributionDefaults'> & {
  attributionDefaults?: Record<string, string | undefined> | null;
};

export function loadConfig(overrides?: AgentConfigInput): Readonly<AgentConfig> {
  const rawLicenseKey = overrides?.licenseKey ?? process.env.NEW_RELIC_LICENSE_KEY;
  if (!rawLicenseKey) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_LICENSE_KEY. ' +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or pass licenseKey in options.',
    );
  }
  // Strip leading/trailing whitespace before validating — guards against
  // accidental newlines from `cat key.txt`-style sourcing.
  const licenseKey = rawLicenseKey.trim();
  if (!LICENSE_KEY_RE.test(licenseKey)) {
    throw new Error(
      'Invalid configuration: NEW_RELIC_LICENSE_KEY must be 20-128 printable ASCII ' +
        'characters with no whitespace. (Note: never log the key value.)',
    );
  }

  const appName = overrides?.appName ?? process.env.NEW_RELIC_APP_NAME;
  if (!appName) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_APP_NAME. ' +
        'Set the NEW_RELIC_APP_NAME environment variable or pass appName in options.',
    );
  }
  // Reject control characters (CR/LF etc.) to prevent header injection if
  // appName is ever used in an HTTP context, and cap length at 255 chars.
  if (/[\r\n\x00-\x1f]/.test(appName) || appName.length > 255) {
    throw new Error(
      'Invalid configuration: NEW_RELIC_APP_NAME must be 1-255 characters with no control characters.',
    );
  }

  // Use explicit undefined-check so `accountId: null` in overrides wins over the
  // env var — `??` would treat null as "not provided" and fall through to the
  // env var, silently ignoring an explicit null override.
  const accountId =
    overrides?.accountId !== undefined
      ? overrides.accountId
      : (process.env.NEW_RELIC_ACCOUNT_ID ?? null);
  if (accountId !== null && !/^[1-9]\d*$/.test(accountId)) {
    // Positive-integer-only, no leading zeros, any length.
    // - Removes the prior 12-digit cap so consumers don't have to release a
    //   new version when NR issues 13+ digit account IDs server-side.
    // - Rejects '0' / leading-zero strings (e.g. '07' would have passed the
    //   old `/^\d{1,12}$/` regex even though no NR account uses leading zeros).
    // The upper bound is enforced server-side by the ingest API.
    throw new Error(
      'Invalid configuration: NEW_RELIC_ACCOUNT_ID must be a positive decimal integer (no leading zeros). ' +
        `Received: "${accountId}"`,
    );
  }

  // Hoist `transport` resolution so we can fail fast when
  // accountId is missing for transports that need it. Without this check, the
  // NR Events API URL becomes ".../accounts/null/events", which NR returns 404
  // on; the harvest scheduler then silently retry-loops every batch until the
  // retry buffer overflows. Surface the misconfiguration at startup instead.
  const transport = overrides?.transport ?? envTransport('NEW_RELIC_AI_TRANSPORT', 'nr-events-api');
  if ((transport === 'nr-events-api' || transport === 'both') && accountId === null) {
    throw new Error(
      `Missing required configuration: NEW_RELIC_ACCOUNT_ID. ` +
        `Required when transport is "${transport}" (NR Events API URLs include the account ID in the path). ` +
        `Set the NEW_RELIC_ACCOUNT_ID environment variable or pass accountId in options. ` +
        `Only the "otlp" transport mode can omit accountId.`,
    );
  }

  const highSecurity = overrides?.highSecurity ?? envBool('NEW_RELIC_AI_HIGH_SECURITY', false);

  const recordContent = highSecurity
    ? false
    : (overrides?.recordContent ?? envBool('NEW_RELIC_AI_RECORD_CONTENT', false));

  // Build global attribution defaults from env vars and/or overrides
  const attributionDefaults = buildAttributionDefaults(overrides?.attributionDefaults);

  const config: AgentConfig = {
    licenseKey,
    appName,
    enabled: overrides?.enabled ?? envBool('NEW_RELIC_AI_ENABLED', true),
    recordContent,
    costTrackingEnabled:
      overrides?.costTrackingEnabled ?? envBool('NEW_RELIC_AI_COST_TRACKING', true),
    qualityTrackingEnabled:
      overrides?.qualityTrackingEnabled ?? envBool('NEW_RELIC_AI_QUALITY_TRACKING', true),
    conversationTrackingEnabled:
      overrides?.conversationTrackingEnabled ?? envBool('NEW_RELIC_AI_CONVERSATION_TRACKING', true),
    thinkingTrackingEnabled:
      overrides?.thinkingTrackingEnabled ?? envBool('NEW_RELIC_AI_THINKING_TRACKING', true),
    customPricingFile: overrideString(overrides?.customPricingFile, () =>
      envOrNull('NEW_RELIC_AI_CUSTOM_PRICING_FILE'),
    ),
    contentMaxLength:
      overrides?.contentMaxLength ??
      envInt('NEW_RELIC_AI_CONTENT_MAX_LENGTH', 4096, { min: 1, max: 1_048_576 }),
    highSecurity,
    logLevel: overrides?.logLevel ?? envLogLevel('NEW_RELIC_AI_LOG_LEVEL', 'info'),
    collectorHost: overrideString(overrides?.collectorHost, () => envOrNull('NEW_RELIC_HOST')),
    accountId,
    attributionDefaults,
    otlpEndpoint: overrideString(overrides?.otlpEndpoint, () =>
      envOrNull('OTEL_EXPORTER_OTLP_ENDPOINT'),
    ),
    otlpHeaders: overrides?.otlpHeaders ?? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    transport,
    clientName: sanitizeClientString(
      overrides?.clientName ?? process.env.NEW_RELIC_AI_CLIENT_NAME,
      DEFAULT_CLIENT_NAME,
    ),
    clientVersion: sanitizeClientString(
      overrides?.clientVersion ?? process.env.NEW_RELIC_AI_CLIENT_VERSION,
      '',
    ),
  };

  return deepFreeze(config);
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        deepFreeze(value);
      }
    }
    Object.freeze(obj);
  }
  return obj;
}

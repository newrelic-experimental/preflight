import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { createLogger } from './shared/index.js';
import type { LogLevel } from './shared/index.js';
import type { CliOptions } from './types.js';
import type { UpstreamConfig } from './proxy/types.js';
import type { PersonalAlertThresholds } from './alerts/types.js';
import { DEFAULT_PERSONAL_THRESHOLDS } from './alerts/types.js';
import { REDACTION_PATTERNS as DEFAULT_REDACTION_PATTERNS } from './redaction-patterns.js';
import { resolveRecordContent } from './record-content-gate.js';

const logger = createLogger('mcp-config');

export interface McpServerConfig {
  readonly licenseKey?: string;
  readonly accountId?: string;
  readonly appName: string;
  readonly developer: string;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly orgId: string | null;
  readonly model: string;
  readonly enabled: boolean;
  readonly highSecurity: boolean;
  readonly recordContent: boolean;
  readonly redactionPatterns: readonly RegExp[];
  readonly hookBufferPath: string;
  readonly storagePath: string;
  readonly harvestIntervalMs: { readonly events: number; readonly metrics: number };
  readonly sessionBudgetUsd: number | null;
  readonly dailyBudgetUsd: number | null;
  readonly weeklyBudgetUsd: number | null;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly collectorHost: string | null;
  readonly proxyUpstreams: readonly UpstreamConfig[];
  readonly nrApiKey: string | null;
  readonly digestWebhookUrl: string | null;
  readonly digestSchedule: string; // cron expression, default: "0 9 * * 1" (Monday 9am)
  /** Default: 90. `null` disables retention (only reachable via an explicit `null` in config.json). */
  readonly retainSessionsDays: number | null;
  readonly personalAlertThresholds: PersonalAlertThresholds;
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly transport: 'nr-events-api' | 'otlp' | 'both';
  readonly mode: 'cloud' | 'local' | 'both';
  readonly platformTarget?: PlatformTarget;
  /** Enable the local OTLP/HTTP receiver. Default: false. */
  readonly otlpReceiverEnabled: boolean;
  /** Port for the local OTLP/HTTP receiver. Default: 4318. */
  readonly otlpReceiverPort: number;
  /** Bind address for the local OTLP/HTTP receiver. Default: '127.0.0.1'. */
  readonly otlpReceiverBindAddress: string;
  /**
   * OTLP forward endpoint — where to relay received spans.
   * Defaults to New Relic US OTLP endpoint when licenseKey is present.
   * Set to null to disable forwarding (receive and enrich only, then drop).
   */
  readonly otlpForwardEndpoint: string | null;
  /**
   * HTTP headers added to every OTLP forward request (e.g. `{ 'api-key': licenseKey }`).
   * Defaults to `{ 'api-key': licenseKey }` when licenseKey is present.
   * Configurable via NR_AI_OTLP_FORWARD_HEADERS (comma-separated key=value pairs).
   */
  readonly otlpForwardHeaders: Readonly<Record<string, string>>;
  readonly dashboard: {
    readonly port: number;
    readonly host: string;
    readonly openOnStart: boolean;
  };
  /**
   * Local-alerts engine config block. Defaults: enabled=true when mode is
   * not 'cloud', interval=30s, OS notifications off, log retention 10 MB,
   * rules file at ~/.newrelic-preflight/alerts/rules.json.
   */
  readonly alerts: {
    readonly enabled: boolean;
    readonly evaluationIntervalSeconds: number;
    readonly osNotifications: boolean;
    readonly logRetentionMb: number;
    readonly rulesPath: string;
  };
}

export const DEFAULT_STORAGE_PATH = resolve(homedir(), '.newrelic-preflight');

// Applied only when neither the env var nor the config file specify
// retainSessionsDays at all — an explicit `null` in config.json still means
// "retention disabled" (see the resolution logic below).
const DEFAULT_RETAIN_SESSIONS_DAYS = 90;

export type PlatformTarget = 'native' | 'wsl-windows-cc' | 'wsl-linux-cc';

export const ConfigFileSchema = z
  .object({
    licenseKey: z.string().optional(),
    accountId: z.string().optional(),
    appName: z.string().optional(),
    developer: z.string().optional(),
    teamId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    orgId: z.string().nullable().optional(),
    model: z.string().optional(),
    enabled: z.boolean().optional(),
    highSecurity: z.boolean().optional(),
    recordContent: z.boolean().optional(),
    storagePath: z.string().optional(),
    hookBufferPath: z.string().optional(),
    harvestEventsMs: z.number().optional(),
    harvestMetricsMs: z.number().optional(),
    sessionBudgetUsd: z.number().nullable().optional(),
    dailyBudgetUsd: z.number().nullable().optional(),
    weeklyBudgetUsd: z.number().nullable().optional(),
    port: z.number().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    collectorHost: z.string().nullable().optional(),
    proxyUpstreams: z.array(z.unknown()).optional(),
    nrApiKey: z.string().nullable().optional(),
    digestWebhookUrl: z.string().nullable().optional(),
    digestSchedule: z.string().optional(),
    retainSessionsDays: z.number().nullable().optional(),
    otlpEndpoint: z.string().nullable().optional(),
    otlpHeaders: z.record(z.string(), z.string()).optional(),
    transport: z.enum(['nr-events-api', 'otlp', 'both']).optional(),
    mode: z.enum(['cloud', 'local', 'both']).optional(),
    platformTarget: z.enum(['native', 'wsl-windows-cc', 'wsl-linux-cc']).optional(),
    otlpReceiverEnabled: z.boolean().optional(),
    otlpReceiverPort: z.number().optional(),
    otlpReceiverBindAddress: z.string().optional(),
    otlpForwardEndpoint: z.string().nullable().optional(),
    otlpForwardHeaders: z.record(z.string(), z.string()).optional(),
    alerts: z
      .object({
        personal: z
          .object({
            dailyCostUsd: z.number().optional(),
            sessionCostUsd: z.number().optional(),
            efficiencyScoreMin: z.number().optional(),
            stuckLoopCountMax: z.number().optional(),
            antiPatternCountMax: z.number().optional(),
          })
          .passthrough()
          .optional(),
        enabled: z.boolean().optional(),
        evaluationIntervalSeconds: z.number().int().min(5).max(300).optional(),
        osNotifications: z.boolean().optional(),
        logRetentionMb: z.number().min(1).max(1024).optional(),
        rulesPath: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    dashboard: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        host: z.string().optional(),
        openOnStart: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  // Pre-launch we want graceful tolerance of unknown keys so that an older
  // ~/.newrelic-preflight/config.json doesn't brick the server on upgrade. Unknown
  // keys at every level (top-level, alerts, dashboard) are reported via
  // logger.warn at load time (see loadMcpConfig) so users still get a hint
  // without a fatal crash. Nested objects also use .passthrough() so the
  // warn block can see typos like `dashboard.openOnStarrt`.
  .passthrough();

// strip control chars and truncate before the value reaches any NR event field or log
export function sanitizeDeveloper(raw: string): string {
  return (
    raw
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, 128) || 'unknown'
  );
}

/**
 * Produces a lowercase, NRQL-safe identifier from a raw developer name.
 * "John Doe" → "john_doe", "my.user@host" → "my_user_host"
 */
export function normalizeDeveloperName(raw: string): string {
  const normalized = raw
    .replace(/[\x00-\x1f\x7f]/g, '') // strip control chars
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_'); // collapse non-alphanumeric runs to _

  // Trim leading/trailing underscores with an index walk instead of
  // anchored-quantifier regexes (/^_+/ and /_+$/) — the latter causes
  // O(n²) backtracking on underscore-heavy strings (CodeQL js/polynomial-redos).
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === '_') start++;
  while (end > start && normalized[end - 1] === '_') end--;
  return (normalized.slice(start, end) || 'unknown').slice(0, 64);
}

function sanitizeOrgField(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 128);
  return sanitized || null;
}

function inferDeveloper(): string {
  if (process.env.USER) return sanitizeDeveloper(process.env.USER);
  if (process.env.USERNAME) return sanitizeDeveloper(process.env.USERNAME);
  try {
    return sanitizeDeveloper(
      execSync('git config user.name', {
        encoding: 'utf-8',
        timeout: 2000,
        env: { ...process.env },
      }).trim(),
    );
  } catch {
    return 'unknown';
  }
}

function inferProjectId(): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...process.env },
    }).trim();
    // Extract "org/repo" from HTTPS or SSH remotes:
    // https://github.com/org/repo.git  → org/repo
    // git@github.com:org/repo.git      → org/repo
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key]?.trim().toLowerCase();
  if (val === 'true' || val === '1' || val === 'yes' || val === 'y' || val === 'on') return true;
  if (val === 'false' || val === '0' || val === 'no' || val === 'n' || val === 'off') return false;
  return defaultValue;
}

function envInt(
  key: string,
  defaultValue: number,
  bounds?: { min?: number; max?: number },
): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  if (bounds?.min !== undefined && parsed < bounds.min) return bounds.min;
  if (bounds?.max !== undefined && parsed > bounds.max) return bounds.max;
  return parsed;
}

function envLogLevel(key: string, defaultValue: LogLevel): LogLevel {
  const val = process.env[key]?.toLowerCase();
  if (val === 'debug' || val === 'info' || val === 'warn' || val === 'error') return val;
  return defaultValue;
}

function loadConfigFile(filePath: string): z.infer<typeof ConfigFileSchema> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Invalid JSON in config file', {
      filePath,
      error: errorMsg,
    });
    throw new Error(`Config file parsing failed at ${filePath}: ${errorMsg}`);
  }
  const validation = ConfigFileSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return `${path || 'root'}: ${issue.message}`;
      })
      .join('; ');
    logger.error('Config file validation failed', {
      filePath,
      issues,
    });
    throw new Error(`Config file validation failed at ${filePath}: ${issues}`);
  }
  return validation.data;
}

function resolveCollectorHost(
  licenseKey: string | undefined,
  explicit: string | null,
): string | null {
  if (explicit) return explicit;
  if (licenseKey?.toLowerCase().startsWith('eu01')) {
    return 'eu';
  }
  return null;
}

function isValidUpstream(u: unknown): u is UpstreamConfig {
  if (typeof u !== 'object' || u === null) return false;
  const obj = u as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (obj.transportType !== 'http' && obj.transportType !== 'stdio') return false;
  if (obj.transportType === 'http' && typeof obj.url !== 'string') return false;
  if (obj.transportType === 'stdio' && typeof obj.command !== 'string') return false;
  return true;
}

function parseOtlpHeaders(headerString: string | undefined): Record<string, string> {
  if (!headerString) return {};
  const result: Record<string, string> = {};
  const pairs = headerString.split(',');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Validate the alerts.rulesPath value. The path is read from the user's
 * config file or NR_AI_ALERTS_RULES_PATH env var; both are user-controlled
 * but worth a defensive guard to keep an accidental misconfiguration from
 * pointing fs.watch at /etc/hosts or similar. Rules:
 *
 *   1. Must end in `.json` (case-insensitive).
 *   2. Must resolve under `storagePath` (the configured storage root).
 *
 * The default rules path is `${storagePath}/alerts/rules.json`, which
 * always passes both checks. A bad path falls back to the default with a
 * logged warning rather than throwing — one bad config field shouldn't
 * brick the whole server.
 */
function validateRulesPath(rawPath: string, storagePath: string): string {
  const fallback = resolve(storagePath, 'alerts', 'rules.json');
  if (!rawPath.toLowerCase().endsWith('.json')) {
    logger.warn('alerts.rulesPath does not end in .json — falling back to default', {
      rawPath,
      fallback,
    });
    return fallback;
  }
  const resolved = resolve(rawPath);
  const storageResolved = resolve(storagePath);
  // Match prefix only on full path segments to avoid `/foo/bar` matching
  // `/foo/barbaz`.
  const prefix = storageResolved.endsWith('/') ? storageResolved : storageResolved + '/';
  if (resolved !== storageResolved && !resolved.startsWith(prefix)) {
    logger.warn('alerts.rulesPath resolves outside storagePath — falling back to default', {
      rawPath,
      resolved,
      storagePath: storageResolved,
      fallback,
    });
    return fallback;
  }
  return resolved;
}

function parseProxyUpstreams(
  envValue: string | undefined,
  fileValue: unknown,
): readonly UpstreamConfig[] {
  // Env var takes precedence (JSON string)
  if (envValue) {
    try {
      const parsed = JSON.parse(envValue);
      if (!Array.isArray(parsed)) {
        logger.warn(
          'NEW_RELIC_AI_MCP_PROXY_UPSTREAMS must be a JSON array — ignoring env var value',
        );
      } else {
        const valid = parsed.filter((u: unknown) => {
          if (isValidUpstream(u)) return true;
          logger.warn(
            'Skipping invalid proxy upstream entry (missing name, transportType, or url/command)',
            { entry: u },
          );
          return false;
        });
        return valid as UpstreamConfig[];
      }
    } catch {
      logger.warn('Invalid JSON in NEW_RELIC_AI_MCP_PROXY_UPSTREAMS env var');
    }
  }
  // Config file
  if (Array.isArray(fileValue)) {
    const valid = fileValue.filter((u: unknown) => {
      if (isValidUpstream(u)) return true;
      logger.warn(
        'Skipping invalid proxy upstream entry (missing name, transportType, or url/command)',
        { entry: u },
      );
      return false;
    });
    return valid as UpstreamConfig[];
  }
  return [];
}

export function loadMcpConfig(cliOptions?: Partial<CliOptions>): Readonly<McpServerConfig> {
  const configFilePath = cliOptions?.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const file = loadConfigFile(configFilePath);

  // Warn (don't crash) when the user's config file contains keys we don't
  // recognize. Schema is `.passthrough()` at every level so unknown keys come
  // through intact — surface them in logs so a typo or stale field is visible
  // to the user without bricking the server on upgrade.
  const knownTopKeys = new Set(Object.keys(ConfigFileSchema.shape));
  const unknownTopKeys = Object.keys(file).filter((k) => !knownTopKeys.has(k));
  if (unknownTopKeys.length > 0) {
    logger.warn('Unknown keys in config file (ignored)', {
      unknownFields: unknownTopKeys,
      path: configFilePath,
    });
  }
  // Nested objects: alerts, dashboard. Hardcoded known-key sets keep this
  // simple and avoid Zod schema introspection (the typed shape requires
  // unwrapping .optional() and .passthrough()). If you add a new field to
  // these schemas, add it here too.
  const knownAlertsKeys = new Set([
    'personal',
    'enabled',
    'evaluationIntervalSeconds',
    'osNotifications',
    'logRetentionMb',
    'rulesPath',
  ]);
  const knownAlertsPersonalKeys = new Set([
    'dailyCostUsd',
    'sessionCostUsd',
    'efficiencyScoreMin',
    'stuckLoopCountMax',
    'antiPatternCountMax',
  ]);
  const knownDashboardKeys = new Set(['port', 'host', 'openOnStart']);
  if (file.alerts && typeof file.alerts === 'object') {
    const alerts = file.alerts;
    const unknownAlertsKeys = Object.keys(alerts).filter((k) => !knownAlertsKeys.has(k));
    if (unknownAlertsKeys.length > 0) {
      logger.warn('Unknown keys in alerts config (ignored)', {
        unknownFields: unknownAlertsKeys,
        path: configFilePath,
      });
    }
    if (alerts.personal && typeof alerts.personal === 'object') {
      const personal = alerts.personal;
      const unknownAlertsPersonalKeys = Object.keys(personal).filter(
        (k) => !knownAlertsPersonalKeys.has(k),
      );
      if (unknownAlertsPersonalKeys.length > 0) {
        logger.warn('Unknown keys in alerts.personal config (ignored)', {
          unknownFields: unknownAlertsPersonalKeys,
          path: configFilePath,
        });
      }
    }
  }
  if (file.dashboard && typeof file.dashboard === 'object') {
    const dashboard = file.dashboard;
    const unknownDashboardKeys = Object.keys(dashboard).filter((k) => !knownDashboardKeys.has(k));
    if (unknownDashboardKeys.length > 0) {
      logger.warn('Unknown keys in dashboard config (ignored)', {
        unknownFields: unknownDashboardKeys,
        path: configFilePath,
      });
    }
  }

  // --- Resolve mode early so we can gate licenseKey/accountId requirements ---
  // File mode is already validated by the zod schema in loadConfigFile.
  const VALID_MODES = ['cloud', 'local', 'both'] as const;
  type Mode = (typeof VALID_MODES)[number];
  const isValidMode = (v: string | undefined): v is Mode =>
    v !== undefined && (VALID_MODES as readonly string[]).includes(v);
  const envMode = process.env.NR_AI_MODE;
  if (envMode !== undefined && envMode !== '' && !isValidMode(envMode)) {
    throw new Error(`Invalid NR_AI_MODE='${envMode}'. Must be one of: ${VALID_MODES.join(', ')}.`);
  }
  const mode: Mode =
    (isValidMode(envMode) ? envMode : undefined) ?? (file.mode as Mode | undefined) ?? 'cloud';

  // --- licenseKey: CLI has no flag for this, so env > file ---
  const licenseKeyRaw =
    process.env.NEW_RELIC_LICENSE_KEY ??
    (typeof file.licenseKey === 'string' ? file.licenseKey : undefined);
  if (mode !== 'local' && !licenseKeyRaw) {
    throw new Error(
      `Missing required configuration: licenseKey (mode='${mode}'). ` +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or add "licenseKey" to ' +
        configFilePath +
        ", or switch to mode='local' to skip cloud transport.",
    );
  }
  // Reject the literal string "null" — it's truthy but not a valid key
  // and would cause silent auth failures at transport time.
  if (licenseKeyRaw === 'null') {
    throw new Error(
      'Invalid licenseKey: the string "null" is not a valid New Relic license key. ' +
        'Remove it from the config file or set the correct key in NEW_RELIC_LICENSE_KEY.',
    );
  }
  // In local mode, undefined if licenseKey is missing (NR transport won't be used)
  const licenseKey = licenseKeyRaw;

  // --- accountId: env > file ---
  const accountIdRaw =
    process.env.NEW_RELIC_ACCOUNT_ID ??
    (typeof file.accountId === 'string' ? file.accountId : undefined);
  if (mode !== 'local' && !accountIdRaw) {
    throw new Error(
      `Missing required configuration: accountId (mode='${mode}'). ` +
        'Set the NEW_RELIC_ACCOUNT_ID environment variable or add "accountId" to ' +
        configFilePath +
        ", or switch to mode='local' to skip cloud transport.",
    );
  }
  if (accountIdRaw && !/^\d{1,12}$/.test(accountIdRaw)) {
    throw new Error(
      'Invalid configuration: accountId must be 1–12 decimal digits. ' +
        `Received: "${accountIdRaw}"`,
    );
  }
  // In local mode, undefined if accountId is missing (NR transport won't be used)
  const accountId = accountIdRaw;

  // --- Build config with priority: CLI > env > file > defaults ---
  const storagePath =
    process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ??
    (typeof file.storagePath === 'string' ? file.storagePath : DEFAULT_STORAGE_PATH);

  // highSecurity must be resolved before recordContent so it can override it
  const highSecurity = envBool(
    'NEW_RELIC_AI_HIGH_SECURITY',
    typeof file.highSecurity === 'boolean' ? file.highSecurity : false,
  );

  const config: McpServerConfig = {
    licenseKey,
    accountId,

    appName:
      process.env.NEW_RELIC_AI_MCP_APP_NAME ??
      (typeof file.appName === 'string' ? file.appName : 'preflight'),

    model:
      process.env.NEW_RELIC_AI_MODEL ??
      (typeof file.model === 'string' ? file.model : 'claude-sonnet-4-6'),

    developer: normalizeDeveloperName(
      process.env.NEW_RELIC_AI_MCP_DEVELOPER ??
        (typeof file.developer === 'string' ? file.developer : inferDeveloper()),
    ),

    teamId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_TEAM_ID ?? (typeof file.teamId === 'string' ? file.teamId : null),
    ),

    projectId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_PROJECT_ID ??
        (typeof file.projectId === 'string' ? file.projectId : inferProjectId()),
    ),

    orgId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_ORG_ID ?? (typeof file.orgId === 'string' ? file.orgId : null),
    ),

    enabled: envBool(
      'NEW_RELIC_AI_MCP_ENABLED',
      typeof file.enabled === 'boolean' ? file.enabled : true,
    ),

    highSecurity,

    recordContent: resolveRecordContent(
      highSecurity,
      envBool(
        'NEW_RELIC_AI_MCP_RECORD_CONTENT',
        typeof file.recordContent === 'boolean' ? file.recordContent : false,
      ),
    ),

    redactionPatterns: DEFAULT_REDACTION_PATTERNS,

    hookBufferPath:
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH ??
      (typeof file.hookBufferPath === 'string'
        ? file.hookBufferPath
        : resolve(storagePath, 'buffer.jsonl')),

    storagePath,

    harvestIntervalMs: {
      events: envInt(
        'NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS',
        typeof file.harvestEventsMs === 'number' ? file.harvestEventsMs : 5000,
        { min: 100, max: 3_600_000 },
      ),
      metrics: envInt(
        'NEW_RELIC_AI_MCP_HARVEST_METRICS_MS',
        typeof file.harvestMetricsMs === 'number' ? file.harvestMetricsMs : 60000,
        { min: 100, max: 3_600_000 },
      ),
    },

    sessionBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_SESSION_BUDGET_USD;
      if (raw !== undefined && raw !== '') {
        const v = parseFloat(raw);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return typeof file.sessionBudgetUsd === 'number' ? file.sessionBudgetUsd : null;
    })(),

    dailyBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_DAILY_BUDGET_USD;
      if (raw !== undefined && raw !== '') {
        const v = parseFloat(raw);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return typeof file.dailyBudgetUsd === 'number' ? file.dailyBudgetUsd : null;
    })(),

    weeklyBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD;
      if (raw !== undefined && raw !== '') {
        const v = parseFloat(raw);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return typeof file.weeklyBudgetUsd === 'number' ? file.weeklyBudgetUsd : null;
    })(),

    port:
      cliOptions?.port ??
      envInt('NEW_RELIC_AI_MCP_PORT', typeof file.port === 'number' ? file.port : 9847, {
        min: 1,
        max: 65535,
      }),

    logLevel:
      cliOptions?.logLevel ??
      envLogLevel(
        'NEW_RELIC_AI_MCP_LOG_LEVEL',
        typeof file.logLevel === 'string' &&
          ['debug', 'info', 'warn', 'error'].includes(file.logLevel)
          ? (file.logLevel as LogLevel)
          : 'info',
      ),

    collectorHost: resolveCollectorHost(
      licenseKey,
      process.env.NEW_RELIC_HOST ??
        (typeof file.collectorHost === 'string' ? file.collectorHost : null),
    ),

    proxyUpstreams: parseProxyUpstreams(
      process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS,
      file.proxyUpstreams,
    ),

    nrApiKey:
      process.env.NEW_RELIC_API_KEY ?? (typeof file.nrApiKey === 'string' ? file.nrApiKey : null),

    digestWebhookUrl:
      process.env.NEW_RELIC_AI_DIGEST_WEBHOOK_URL ??
      (typeof file.digestWebhookUrl === 'string' ? file.digestWebhookUrl : null),

    digestSchedule:
      process.env.NEW_RELIC_AI_DIGEST_SCHEDULE ??
      (typeof file.digestSchedule === 'string' ? file.digestSchedule : '0 9 * * 1'),

    retainSessionsDays: (() => {
      const raw = process.env.NEW_RELIC_AI_RETAIN_SESSIONS_DAYS;
      if (raw !== undefined && raw !== '') {
        const v = parseInt(raw, 10);
        if (Number.isFinite(v) && v > 0) return v;
      }
      if (typeof file.retainSessionsDays === 'number') return file.retainSessionsDays;
      // Explicit `null` in the config file is a deliberate opt-out — distinct
      // from the key being absent entirely, which falls through to the default.
      if (file.retainSessionsDays === null) return null;
      return DEFAULT_RETAIN_SESSIONS_DAYS;
    })(),

    otlpEndpoint:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      (typeof file.otlpEndpoint === 'string' ? file.otlpEndpoint : null),

    otlpHeaders: (() => {
      const envValue = process.env.OTEL_EXPORTER_OTLP_HEADERS;
      if (envValue) return parseOtlpHeaders(envValue);
      return typeof file.otlpHeaders === 'object' && file.otlpHeaders !== null
        ? (file.otlpHeaders as Record<string, string>)
        : {};
    })(),

    transport:
      process.env.NEW_RELIC_AI_TRANSPORT === 'otlp'
        ? 'otlp'
        : process.env.NEW_RELIC_AI_TRANSPORT === 'both'
          ? 'both'
          : typeof file.transport === 'string' &&
              (file.transport === 'otlp' || file.transport === 'both')
            ? file.transport
            : 'nr-events-api',

    mode,

    otlpReceiverEnabled: envBool(
      'NR_AI_OTLP_RECEIVER_ENABLED',
      typeof file.otlpReceiverEnabled === 'boolean' ? file.otlpReceiverEnabled : false,
    ),

    otlpReceiverPort: envInt(
      'NR_AI_OTLP_RECEIVER_PORT',
      typeof file.otlpReceiverPort === 'number' ? file.otlpReceiverPort : 4318,
      { min: 1, max: 65535 },
    ),

    otlpReceiverBindAddress: (() => {
      const envVal = process.env.NR_AI_OTLP_RECEIVER_BIND_ADDRESS;
      if (envVal !== undefined && envVal !== '') return envVal;
      if (typeof file.otlpReceiverBindAddress === 'string' && file.otlpReceiverBindAddress !== '') {
        return file.otlpReceiverBindAddress;
      }
      return '127.0.0.1';
    })(),

    otlpForwardEndpoint: (() => {
      const envVal = process.env.NR_AI_OTLP_FORWARD_ENDPOINT;
      // Default to the NR OTLP endpoint only when not in local mode. Local users
      // may still set the value explicitly via env or config file (e.g. to point
      // at a self-hosted collector); we just don't synthesize a NR default for them.
      const defaultEndpoint =
        mode !== 'local' && licenseKey !== undefined ? 'https://otlp.nr-data.net' : null;
      const endpoint =
        envVal !== undefined
          ? envVal || null
          : typeof file.otlpForwardEndpoint === 'string'
            ? file.otlpForwardEndpoint || null
            : defaultEndpoint;
      if (endpoint === null) return null;
      try {
        const url = new URL(endpoint);
        if (url.protocol === 'https:') return endpoint;
        if (url.protocol === 'http:') {
          logger.warn('OTLP forward endpoint uses http:// instead of https:// — TLS not enabled', {
            endpoint,
          });
          return endpoint;
        }
        logger.warn('OTLP forward endpoint has unexpected protocol', {
          endpoint,
          protocol: url.protocol,
        });
        return endpoint;
      } catch (_err) {
        logger.error('OTLP forward endpoint is not a valid URL', { endpoint });
        return null;
      }
    })(),

    otlpForwardHeaders: (() => {
      const envValue = process.env.NR_AI_OTLP_FORWARD_HEADERS;
      if (envValue !== undefined) return parseOtlpHeaders(envValue);
      if (typeof file.otlpForwardHeaders === 'object' && file.otlpForwardHeaders !== null) {
        return file.otlpForwardHeaders as Record<string, string>;
      }
      // Don't synthesize a NR api-key header default in local mode — the licenseKey
      // may be present in the env from another tool, and we must not leak it to a
      // forward target the user didn't explicitly configure.
      return mode !== 'local' && licenseKey !== undefined ? { 'api-key': licenseKey } : {};
    })(),

    personalAlertThresholds: (() => {
      const fileThresholds = file.alerts?.personal;
      if (typeof fileThresholds !== 'object' || fileThresholds === null) {
        return DEFAULT_PERSONAL_THRESHOLDS;
      }
      const t = fileThresholds;
      return {
        dailyCostUsd:
          typeof t.dailyCostUsd === 'number'
            ? t.dailyCostUsd
            : DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
        sessionCostUsd:
          typeof t.sessionCostUsd === 'number'
            ? t.sessionCostUsd
            : DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
        efficiencyScoreMin:
          typeof t.efficiencyScoreMin === 'number'
            ? t.efficiencyScoreMin
            : DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
        stuckLoopCountMax:
          typeof t.stuckLoopCountMax === 'number'
            ? t.stuckLoopCountMax
            : DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
        antiPatternCountMax:
          typeof t.antiPatternCountMax === 'number'
            ? t.antiPatternCountMax
            : DEFAULT_PERSONAL_THRESHOLDS.antiPatternCountMax,
      };
    })(),

    dashboard: (() => {
      const dashboardFile = (file.dashboard ?? {}) as {
        port?: number;
        host?: string;
        openOnStart?: boolean;
      };
      const dashboardPortRaw = process.env.NR_AI_DASHBOARD_PORT
        ? parseInt(process.env.NR_AI_DASHBOARD_PORT, 10)
        : dashboardFile.port;
      // Allow port 0 — Node's server.listen(0) assigns an OS-ephemeral port,
      // which is essential for parallel test runs and useful when the user
      // wants to avoid hard-coding a port. Negative or out-of-range values
      // still fall back to the default 7777.
      const dashboardPort =
        Number.isFinite(dashboardPortRaw) && dashboardPortRaw! >= 0 && dashboardPortRaw! <= 65535
          ? dashboardPortRaw!
          : 7777;
      const requestedHost = process.env.NR_AI_DASHBOARD_HOST ?? dashboardFile.host ?? '127.0.0.1';
      let dashboardHost = '127.0.0.1';
      if (requestedHost !== '127.0.0.1' && requestedHost !== 'localhost') {
        logger.warn(
          `dashboard.host '${requestedHost}' is non-loopback; v1 only supports loopback. Forcing 127.0.0.1.`,
        );
      } else {
        dashboardHost = requestedHost === 'localhost' ? '127.0.0.1' : requestedHost;
      }
      const dashboardOpenOnStart = envBool(
        'NR_AI_DASHBOARD_OPEN',
        dashboardFile.openOnStart === true,
      );
      return {
        port: dashboardPort,
        host: dashboardHost,
        openOnStart: dashboardOpenOnStart,
      };
    })(),

    platformTarget: file.platformTarget as PlatformTarget | undefined,

    alerts: (() => {
      // The alerts config is a separate top-level block from
      // `personalAlertThresholds` (above) — they share the `alerts` key in
      // the file schema for backwards compatibility, but expose different
      // fields. `enabled` defaults to true outside of cloud-only mode.
      const alertsFile = file.alerts ?? {};
      const fileEnabled = typeof alertsFile.enabled === 'boolean' ? alertsFile.enabled : undefined;
      const fileInterval =
        typeof alertsFile.evaluationIntervalSeconds === 'number'
          ? alertsFile.evaluationIntervalSeconds
          : undefined;
      const fileOsNotifications =
        typeof alertsFile.osNotifications === 'boolean' ? alertsFile.osNotifications : undefined;
      const fileLogRetention =
        typeof alertsFile.logRetentionMb === 'number' ? alertsFile.logRetentionMb : undefined;
      const fileRulesPath =
        typeof alertsFile.rulesPath === 'string' ? alertsFile.rulesPath : undefined;

      const enabledDefault = mode !== 'cloud';
      const enabled = envBool('NR_AI_ALERTS_ENABLED', fileEnabled ?? enabledDefault);

      const intervalSeconds = envInt('NR_AI_ALERTS_INTERVAL_SECONDS', fileInterval ?? 30, {
        min: 5,
        max: 300,
      });

      const osNotifications = envBool(
        'NR_AI_ALERTS_OS_NOTIFICATIONS',
        fileOsNotifications ?? false,
      );

      const logRetentionMb = envInt('NR_AI_ALERTS_LOG_RETENTION_MB', fileLogRetention ?? 10, {
        min: 1,
        max: 1024,
      });

      const envRulesPath = process.env.NR_AI_ALERTS_RULES_PATH;
      const rawRulesPath =
        envRulesPath !== undefined && envRulesPath !== ''
          ? envRulesPath
          : (fileRulesPath ?? resolve(storagePath, 'alerts', 'rules.json'));
      // Defensive validation: rulesPath is read from user config, so reject
      // values that don't end in .json or that resolve outside storagePath.
      // Prevents accidental fs.watch handles on system files like /etc/hosts
      // or path-traversal probes via env-var injection. The default path is
      // always permitted.
      const rulesPath = validateRulesPath(rawRulesPath, storagePath);

      return {
        enabled,
        evaluationIntervalSeconds: intervalSeconds,
        osNotifications,
        logRetentionMb,
        rulesPath,
      };
    })(),
  };

  logger.debug('Configuration loaded', {
    appName: config.appName,
    developer: config.developer,
    teamId: config.teamId,
    projectId: config.projectId,
    orgId: config.orgId,
    enabled: config.enabled,
    highSecurity: config.highSecurity,
    recordContent: config.recordContent,
    storagePath: config.storagePath,
    port: config.port,
    collectorHost: config.collectorHost ?? 'us (default)',
    sessionBudgetUsd: config.sessionBudgetUsd,
    dailyBudgetUsd: config.dailyBudgetUsd,
    weeklyBudgetUsd: config.weeklyBudgetUsd,
  });

  return Object.freeze(config);
}

// ---------------------------------------------------------------------------
// Config file validation (used by `preflight validate` CLI command)
// ---------------------------------------------------------------------------

export interface ConfigValidationResult {
  readonly filePath: string;
  readonly fileExists: boolean;
  /** True when the file existed but could not be read or parsed as a JSON object. */
  readonly malformed: boolean;
  /** The `mode` field from the parsed config, if the file was parseable. */
  readonly mode?: string;
  /** The `storagePath` field from the parsed config, if present and a string. */
  readonly storagePath?: string;
  /** True when a non-blank licenseKey is present in the parsed config. Raw value is intentionally not exposed. */
  readonly hasLicenseKey: boolean;
  /** Fatal problems that will prevent the MCP server from starting. */
  readonly errors: readonly string[];
  /** Non-fatal problems that may cause settings to be silently ignored. */
  readonly warnings: readonly string[];
}

/**
 * Validate a config file and return structured results — no throws, no logging.
 * The CLI `validate` command uses this to surface issues in human-readable form
 * before the user attempts to start the MCP server.
 */
export function validateConfigFile(filePath: string): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(filePath)) {
    return {
      filePath,
      fileExists: false,
      malformed: false,
      hasLicenseKey: false,
      errors,
      warnings,
    };
  }

  // Read and parse the file
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    errors.push(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    return { filePath, fileExists: true, malformed: true, hasLicenseKey: false, errors, warnings };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { filePath, fileExists: true, malformed: true, hasLicenseKey: false, errors, warnings };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push('Config must be a JSON object, not an array or primitive value');
    return { filePath, fileExists: true, malformed: true, hasLicenseKey: false, errors, warnings };
  }

  // Zod type/value errors
  const validation = ConfigFileSchema.safeParse(parsed);
  if (!validation.success) {
    for (const issue of validation.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      errors.push(`${path}: ${issue.message}`);
    }
  }

  // Unknown key detection with "did you mean" suggestions
  const file = parsed as Record<string, unknown>;

  const knownTopKeys = new Set(Object.keys(ConfigFileSchema.shape));
  for (const key of Object.keys(file)) {
    if (!knownTopKeys.has(key)) {
      const suggestion = findSuggestion(key, knownTopKeys);
      warnings.push(
        `Unknown key "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ' — not a recognized config field'}`,
      );
    }
  }

  const knownAlertsKeys = new Set([
    'personal',
    'enabled',
    'evaluationIntervalSeconds',
    'osNotifications',
    'logRetentionMb',
    'rulesPath',
  ]);
  const knownAlertsPersonalKeys = new Set([
    'dailyCostUsd',
    'sessionCostUsd',
    'efficiencyScoreMin',
    'stuckLoopCountMax',
    'antiPatternCountMax',
  ]);
  const knownDashboardKeys = new Set(['port', 'host', 'openOnStart']);

  if (file.alerts && typeof file.alerts === 'object' && !Array.isArray(file.alerts)) {
    const alerts = file.alerts as Record<string, unknown>;
    for (const key of Object.keys(alerts)) {
      if (!knownAlertsKeys.has(key)) {
        const suggestion = findSuggestion(key, knownAlertsKeys);
        warnings.push(
          `Unknown key "alerts.${key}"${suggestion ? ` — did you mean "alerts.${suggestion}"?` : ''}`,
        );
      }
    }
    if (alerts.personal && typeof alerts.personal === 'object' && !Array.isArray(alerts.personal)) {
      const personal = alerts.personal as Record<string, unknown>;
      for (const key of Object.keys(personal)) {
        if (!knownAlertsPersonalKeys.has(key)) {
          const suggestion = findSuggestion(key, knownAlertsPersonalKeys);
          warnings.push(
            `Unknown key "alerts.personal.${key}"${suggestion ? ` — did you mean "alerts.personal.${suggestion}"?` : ''}`,
          );
        }
      }
    }
  }

  if (file.dashboard && typeof file.dashboard === 'object' && !Array.isArray(file.dashboard)) {
    const dashboard = file.dashboard as Record<string, unknown>;
    for (const key of Object.keys(dashboard)) {
      if (!knownDashboardKeys.has(key)) {
        const suggestion = findSuggestion(key, knownDashboardKeys);
        warnings.push(
          `Unknown key "dashboard.${key}"${suggestion ? ` — did you mean "dashboard.${suggestion}"?` : ''}`,
        );
      }
    }
  }

  return {
    filePath,
    fileExists: true,
    malformed: false,
    mode: typeof file.mode === 'string' ? file.mode : undefined,
    storagePath: typeof file.storagePath === 'string' ? file.storagePath : undefined,
    hasLicenseKey: typeof file.licenseKey === 'string' && file.licenseKey.trim().length > 0,
    errors,
    warnings,
  };
}

/** Return a suggestion from known keys if the unknown key is a case-insensitive
 *  match or a single-character edit away (insertion, deletion, or substitution). */
function findSuggestion(unknown: string, knownKeys: Set<string>): string | null {
  const lower = unknown.toLowerCase();
  // Exact case-insensitive match — covers the most common typo (e.g. licensekey → licenseKey)
  for (const k of knownKeys) {
    if (k.toLowerCase() === lower) return k;
  }
  // Single-character difference (insertion, deletion, or substitution)
  for (const k of knownKeys) {
    if (editDistance(unknown, k) <= 1) return k;
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const MAX_REDACT_LEN = 1_048_576; // 1 MB

export function redactSensitive(value: string, patterns?: readonly RegExp[]): string {
  if (typeof value !== 'string') return String(value ?? '');
  const pats = patterns ?? DEFAULT_REDACTION_PATTERNS;
  let result = value.length > MAX_REDACT_LEN ? value.slice(0, MAX_REDACT_LEN) : value;
  for (const pattern of pats) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

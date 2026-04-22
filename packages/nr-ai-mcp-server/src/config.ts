import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@nr-ai-observatory/shared';
import type { LogLevel } from '@nr-ai-observatory/shared';
import type { CliOptions } from './types.js';
import type { UpstreamConfig } from './proxy/types.js';

const logger = createLogger('mcp-config');

export interface McpServerConfig {
  readonly licenseKey: string;
  readonly accountId: string;
  readonly appName: string;
  readonly developer: string;
  readonly enabled: boolean;
  readonly recordContent: boolean;
  readonly redactionPatterns: readonly RegExp[];
  readonly hookBufferPath: string;
  readonly storagePath: string;
  readonly harvestIntervalMs: { readonly events: number; readonly metrics: number };
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly collectorHost: string | null;
  readonly proxyUpstreams: readonly UpstreamConfig[];
}

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.nr-ai-observe');

const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
];

function inferDeveloper(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  try {
    return execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function envLogLevel(key: string, defaultValue: LogLevel): LogLevel {
  const val = process.env[key]?.toLowerCase();
  if (val === 'debug' || val === 'info' || val === 'warn' || val === 'error') return val;
  return defaultValue;
}

function loadConfigFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('Failed to parse config file — ignoring', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function resolveCollectorHost(
  licenseKey: string,
  explicit: string | null,
): string | null {
  if (explicit) return explicit;
  if (licenseKey.toLowerCase().startsWith('eu01')) {
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
          logger.warn('Skipping invalid proxy upstream entry (missing name, transportType, or url/command)', { entry: u });
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
      logger.warn('Skipping invalid proxy upstream entry (missing name, transportType, or url/command)', { entry: u });
      return false;
    });
    return valid as UpstreamConfig[];
  }
  return [];
}

export function loadMcpConfig(cliOptions?: Partial<CliOptions>): Readonly<McpServerConfig> {
  const configFilePath = cliOptions?.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const file = loadConfigFile(configFilePath);

  // --- licenseKey: CLI has no flag for this, so env > file ---
  const licenseKey =
    process.env.NEW_RELIC_LICENSE_KEY ??
    (typeof file.licenseKey === 'string' ? file.licenseKey : undefined);
  if (!licenseKey) {
    throw new Error(
      'Missing required configuration: licenseKey. ' +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or add "licenseKey" to ' +
        configFilePath +
        '.',
    );
  }

  // --- accountId: env > file ---
  const accountId =
    process.env.NEW_RELIC_ACCOUNT_ID ??
    (typeof file.accountId === 'string' ? file.accountId : undefined);
  if (!accountId) {
    throw new Error(
      'Missing required configuration: accountId. ' +
        'Set the NEW_RELIC_ACCOUNT_ID environment variable or add "accountId" to ' +
        configFilePath +
        '.',
    );
  }

  // --- Build config with priority: CLI > env > file > defaults ---
  const storagePath =
    process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ??
    (typeof file.storagePath === 'string' ? file.storagePath : DEFAULT_STORAGE_PATH);

  const config: McpServerConfig = {
    licenseKey,
    accountId,

    appName:
      process.env.NEW_RELIC_AI_MCP_APP_NAME ??
      (typeof file.appName === 'string' ? file.appName : 'nr-ai-mcp-server'),

    developer:
      process.env.NEW_RELIC_AI_MCP_DEVELOPER ??
      (typeof file.developer === 'string' ? file.developer : inferDeveloper()),

    enabled:
      envBool('NEW_RELIC_AI_MCP_ENABLED', typeof file.enabled === 'boolean' ? file.enabled : true),

    recordContent: envBool(
      'NEW_RELIC_AI_MCP_RECORD_CONTENT',
      typeof file.recordContent === 'boolean' ? file.recordContent : false,
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
      ),
      metrics: envInt(
        'NEW_RELIC_AI_MCP_HARVEST_METRICS_MS',
        typeof file.harvestMetricsMs === 'number' ? file.harvestMetricsMs : 60000,
      ),
    },

    port: cliOptions?.port ?? envInt(
      'NEW_RELIC_AI_MCP_PORT',
      typeof file.port === 'number' ? file.port : 9847,
    ),

    logLevel: cliOptions?.logLevel ?? envLogLevel(
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
  };

  logger.debug('Configuration loaded', {
    appName: config.appName,
    developer: config.developer,
    enabled: config.enabled,
    recordContent: config.recordContent,
    storagePath: config.storagePath,
    port: config.port,
    collectorHost: config.collectorHost ?? 'us (default)',
  });

  return Object.freeze(config);
}

export function redactSensitive(value: string, patterns?: readonly RegExp[]): string {
  const pats = patterns ?? DEFAULT_REDACTION_PATTERNS;
  let result = value;
  for (const pattern of pats) {
    // Clone the regex to reset lastIndex for global patterns
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, '[REDACTED]');
  }
  return result;
}

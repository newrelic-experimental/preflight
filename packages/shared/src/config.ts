import type { LogLevel } from './logger.js';

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

export function loadConfig(overrides?: Partial<AgentConfig>): Readonly<AgentConfig> {
  const licenseKey = overrides?.licenseKey ?? process.env.NEW_RELIC_LICENSE_KEY;
  if (!licenseKey) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_LICENSE_KEY. ' +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or pass licenseKey in options.',
    );
  }

  const appName = overrides?.appName ?? process.env.NEW_RELIC_APP_NAME;
  if (!appName) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_APP_NAME. ' +
        'Set the NEW_RELIC_APP_NAME environment variable or pass appName in options.',
    );
  }

  const highSecurity = overrides?.highSecurity ?? envBool('NEW_RELIC_AI_HIGH_SECURITY', false);

  const recordContent = highSecurity
    ? false
    : (overrides?.recordContent ?? envBool('NEW_RELIC_AI_RECORD_CONTENT', false));

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
    customPricingFile:
      overrides?.customPricingFile ?? process.env.NEW_RELIC_AI_CUSTOM_PRICING_FILE ?? null,
    contentMaxLength:
      overrides?.contentMaxLength ?? envInt('NEW_RELIC_AI_CONTENT_MAX_LENGTH', 4096),
    highSecurity,
    logLevel: overrides?.logLevel ?? envLogLevel('NEW_RELIC_AI_LOG_LEVEL', 'info'),
    collectorHost: overrides?.collectorHost ?? process.env.NEW_RELIC_HOST ?? null,
    accountId: overrides?.accountId ?? process.env.NEW_RELIC_ACCOUNT_ID ?? null,
  };

  return Object.freeze(config);
}

/**
 * Fixed values for opt-in usage reports. Everything a report can contain is
 * enumerated here, so PRIVACY.md and the tests have one list to check against.
 */

/** A constant, so no config or env var can redirect reports. */
export const USAGE_REPORTS_ENDPOINT = 'https://taxonomy-enforcer.service.newrelic.com/events';

/** Bumped when a field is added. An install sends only the fields its consent covered. */
export const FIELD_LIST_VERSION = 1;

export const PROMPT_TEXT = 'Share anonymous usage statistics with the Preflight team at New Relic?';

/** Unanswered prompts per install, counted across every surface, before Preflight stops asking. */
export const MAX_UNANSWERED_PROMPTS = 3;

export const SEND_TIMEOUT_MS = 5_000;
export const MAX_CONSECUTIVE_SEND_FAILURES = 3;
export const PENDING_FLUSH_INTERVAL_MS = 5 * 60_000;
export const REPORT_INTERVAL_MS = 60 * 60_000;
export const CLAIM_ABANDONED_MS = 60 * 60_000;
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A completed day is summarized only after this grace period, so late flushes land first. */
export const SUMMARY_GRACE_MS = 15 * 60_000;

export const PLATFORM = 'preflight';
export const SECTION = 'usage_reports';
export const PATH = '/preflight/usage-reports';
export const EVENT_TYPE = 'state_load';

/**
 * taxonomy-enforcer accepts only names that end in one of its actions, and its
 * schema for these lives in schemas/capabilities/preflight.yml there.
 */
export const EVENTS = {
  install: 'preflight/install state_loaded',
  feature: 'preflight/feature state_loaded',
  usage: 'preflight/daily_usage state_loaded',
  dashboard: 'preflight/dashboard_usage state_loaded',
  tool: 'preflight/tool_usage state_loaded',
} as const;

export type UsageEventName = (typeof EVENTS)[keyof typeof EVENTS];

const COMMON_PROPERTIES = ['platform', 'section', 'path', 'event_type', 'session_id'] as const;

/**
 * Every property each event may carry, with the field-list version that
 * introduced it. `buildEvent()` drops anything not listed here, and anything
 * newer than the install's consent. Names carry a `preflight_` prefix because
 * taxonomy-enforcer registers event properties in one list shared by every
 * product. A field added later must be optional in that schema, since installs
 * that consented earlier never send it.
 */
export const EVENT_PROPERTIES: Record<UsageEventName, Readonly<Record<string, number>>> = {
  [EVENTS.install]: {
    preflight_version: 1,
    preflight_os: 1,
    preflight_arch: 1,
    preflight_node_major: 1,
    preflight_adapter: 1,
    preflight_install_channel: 1,
    preflight_mode: 1,
    preflight_hooks_installed: 1,
  },
  [EVENTS.feature]: { preflight_feature: 1, preflight_feature_enabled: 1 },
  [EVENTS.usage]: { preflight_usage_date: 1, preflight_sessions_observed: 1 },
  [EVENTS.dashboard]: {
    preflight_usage_date: 1,
    preflight_page_loads: 1,
    preflight_live_connections: 1,
    preflight_open_on_start: 1,
  },
  [EVENTS.tool]: { preflight_usage_date: 1, preflight_tool_name: 1, preflight_call_count: 1 },
};

/**
 * What each event tells the Preflight team, in the words the prompts and the
 * dashboard show. Keyed by event, so a new event can't ship without a line.
 */
export const EVENT_SUMMARIES: Record<UsageEventName, string> = {
  [EVENTS.install]:
    'Preflight, OS and Node.js versions, your AI assistant, install method and mode',
  [EVENTS.feature]: 'Which Preflight features are turned on',
  [EVENTS.usage]: 'How many Preflight sessions ran each day',
  [EVENTS.dashboard]: 'How often the dashboard was opened each day',
  [EVENTS.tool]: 'How many times each Preflight tool was called each day',
};

/** Everything a report holds, as the list each prompt shows. */
export const REPORT_SUMMARY: readonly string[] = [
  ...Object.values(EVENT_SUMMARIES),
  'A random install ID, which you can reset at any time',
];

export const NEVER_SENT =
  'Never your code, prompts, file paths, commands, usernames, cost or account details.';

export const SHOW_COMMAND = 'preflight usage-reports show';

/**
 * PRIVACY.md as of the running version, so it describes this code. Without
 * the section anchor it's short enough for one line of the MCP form.
 */
export function privacyUrl(version: string, section = true): string {
  const doc = `https://github.com/newrelic-experimental/preflight/blob/v${version}/PRIVACY.md`;
  return section ? `${doc}#usage-reports-opt-in` : doc;
}

export function isCommonProperty(key: string): boolean {
  return (COMMON_PROPERTIES as readonly string[]).includes(key);
}

export const FEATURES = [
  'otlp_export',
  'otlp_receiver',
  'proxy',
  'budget',
  'digest',
  'alerts',
  'tiers',
  'companion_mode',
] as const;
export type FeatureName = (typeof FEATURES)[number];

export const INSTALL_CHANNELS = [
  'npm',
  'homebrew',
  'git',
  'claude_plugin',
  'smithery',
  'other',
] as const;
export type InstallChannel = (typeof INSTALL_CHANNELS)[number];

export const PROMPT_SURFACES = [
  'setup_wizard',
  'tool_call_form',
  'session_start_form',
  'dashboard_banner',
  'cli_enable',
  'cli_disable',
] as const;
export type PromptSurface = (typeof PROMPT_SURFACES)[number];

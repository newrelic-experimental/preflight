/**
 * The runner's inherited Preflight, New Relic, OTel and Claude Code variables. Shared by the
 * Jest global setup and playwright.config.ts so the two isolations cannot drift apart.
 */
export const INHERITED_SETTINGS_PATTERN = /^(NEW_RELIC_|NR_AI_|OTEL_|CLAUDE|MCP_CLIENT)/;

/**
 * Credential-only variables the opt-in live tests (events-api, logs-api) read to decide
 * whether to run. They redirect no path and select no mode, so Jest keeps them. Playwright
 * still scrubs them: it starts a real server, and a license key there would ship the run's
 * telemetry to the developer's account.
 */
export const KEPT_CREDENTIALS: ReadonlySet<string> = new Set([
  'NEW_RELIC_LICENSE_KEY',
  'NEW_RELIC_ACCOUNT_ID',
]);

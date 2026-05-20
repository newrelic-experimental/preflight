/**
 * Example configuration for nr-ai-mcp-server.
 *
 * Copy this file to ~/.nr-ai-observe/config.json (as JSON, without comments)
 * and fill in your values. Every field is optional except licenseKey and accountId.
 *
 * Load priority: CLI flags > environment variables > config file > defaults.
 * Environment variable names are noted inline for each field.
 */

export default {
  // ── Required ──────────────────────────────────────────────────────────────

  // New Relic ingest license key (40-char hex + NRAL suffix).
  // Env: NEW_RELIC_LICENSE_KEY
  licenseKey: 'YOUR_LICENSE_KEY_NRAL',

  // New Relic account ID (1–12 decimal digits).
  // Env: NEW_RELIC_ACCOUNT_ID
  accountId: 'YOUR_ACCOUNT_ID',

  // ── Identity ──────────────────────────────────────────────────────────────

  // Developer identifier stamped on every NR event.
  // Normalised to lowercase with underscores (e.g. "John Doe" → "john_doe").
  // Falls back to $USER → $USERNAME → git config user.name → "unknown".
  // Env: NEW_RELIC_AI_MCP_DEVELOPER
  developer: 'jane_doe',

  // Team identifier for aggregated team dashboards.
  // Env: NEW_RELIC_AI_TEAM_ID
  teamId: 'my-team',

  // Project identifier. Auto-derived from git remote if omitted.
  // Env: NEW_RELIC_AI_PROJECT_ID
  projectId: 'my-project',

  // Organisation identifier for org-level grouping.
  // Env: NEW_RELIC_AI_ORG_ID
  orgId: 'my-org',

  // ── Budget caps (optional — null disables the cap) ─────────────────────

  // Maximum spend per session in USD before a budget warning is emitted.
  // Env: NEW_RELIC_AI_SESSION_BUDGET_USD
  sessionBudgetUsd: 5.00,

  // Maximum spend per calendar day in USD.
  // Env: NEW_RELIC_AI_DAILY_BUDGET_USD
  dailyBudgetUsd: 20.00,

  // Maximum spend per calendar week in USD.
  // Env: NEW_RELIC_AI_WEEKLY_BUDGET_USD
  weeklyBudgetUsd: 100.00,

  // ── Personal alert thresholds ─────────────────────────────────────────────
  // Used by: npx tsx scripts/deploy-alerts.ts --developer <name>
  // Defaults: dailyCostUsd: 2, sessionCostUsd: 0.50, efficiencyScoreMin: 40, stuckLoopCountMax: 2

  alerts: {
    personal: {
      dailyCostUsd: 2,
      sessionCostUsd: 0.50,
      efficiencyScoreMin: 40,
      stuckLoopCountMax: 2,
    },
  },

  // ── Security ──────────────────────────────────────────────────────────────

  // When true, recordContent is forced off and tool input/output is never sent to NR.
  // Env: NEW_RELIC_AI_HIGH_SECURITY  (true/false)
  // Default: false
  highSecurity: false,

  // When true, tool input/output content is included in NR events.
  // Forced off when highSecurity is true.
  // Env: NEW_RELIC_AI_MCP_RECORD_CONTENT  (true/false)
  // Default: false
  recordContent: false,

  // ── Storage ───────────────────────────────────────────────────────────────

  // Root directory for local storage (sessions, buffer, weekly summaries).
  // Env: NEW_RELIC_AI_MCP_STORAGE_PATH
  // Default: ~/.nr-ai-observe
  storagePath: '~/.nr-ai-observe',

  // Auto-purge session files older than this many days. null = keep forever.
  // Env: NEW_RELIC_AI_RETAIN_SESSIONS_DAYS
  retainSessionsDays: 30,

  // ── Harvest intervals ─────────────────────────────────────────────────────

  // How often to flush buffered events to NR (milliseconds). Min: 100, Max: 3600000.
  // Env: NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS
  // Default: 5000
  harvestEventsMs: 5000,

  // How often to flush aggregated metrics to NR (milliseconds). Min: 100, Max: 3600000.
  // Env: NEW_RELIC_AI_MCP_HARVEST_METRICS_MS
  // Default: 60000
  harvestMetricsMs: 60000,

  // ── Connectivity ──────────────────────────────────────────────────────────

  // New Relic region. Set to "eu" for EU accounts; auto-detected from license key prefix.
  // Env: NEW_RELIC_HOST  ("us", "eu", or "staging")
  // Default: null (US)
  collectorHost: null,

  // HTTP port for proxy mode.
  // Env: NEW_RELIC_AI_MCP_PORT
  // Default: 9847
  port: 9847,

  // Log level for stderr output.
  // Env: NEW_RELIC_AI_MCP_LOG_LEVEL  ("debug" | "info" | "warn" | "error")
  // Default: "info"
  logLevel: 'info',

  // ── NR User API key (for team summary NerdGraph queries) ──────────────────

  // User API key (NRAK-...). Required only for nr_observe_get_team_summary.
  // Env: NEW_RELIC_API_KEY
  nrApiKey: 'NRAK-XXXXXXXXXXXXXXXXXXXXXXXXXX',

  // ── Weekly digest ─────────────────────────────────────────────────────────

  // Slack incoming webhook URL for weekly cost/efficiency digest.
  // Env: NEW_RELIC_AI_DIGEST_WEBHOOK_URL
  digestWebhookUrl: 'https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXXXX',

  // Cron expression for digest delivery schedule (server's local timezone).
  // Env: NEW_RELIC_AI_DIGEST_SCHEDULE
  // Default: "0 9 * * 1" (Monday 9am)
  digestSchedule: '0 9 * * 1',

  // ── Model ─────────────────────────────────────────────────────────────────

  // AI model identifier stamped on NR events when not inferred from tool calls.
  // Env: NEW_RELIC_AI_MODEL
  // Default: "claude-sonnet-4-6"
  model: 'claude-sonnet-4-6',

  // ── Proxy upstreams (proxy mode only) ─────────────────────────────────────
  // Used when running: nr-ai-observe proxy --port 9847
  // Env: NEW_RELIC_AI_MCP_PROXY_UPSTREAMS (JSON array string)

  proxyUpstreams: [
    // HTTP upstream example:
    {
      name: 'my-http-server',
      transportType: 'http',
      url: 'http://localhost:3000/mcp',
    },
    // Stdio upstream example:
    {
      name: 'my-stdio-server',
      transportType: 'stdio',
      command: '/usr/local/bin/my-mcp-server',
      args: ['--flag', 'value'],
    },
  ],
};

/**
 * NR AI MCP Server — Annotated Example Configuration
 *
 * This file documents every available option with its type, default value,
 * and the environment variable that overrides it.
 *
 * HOW TO USE
 * ----------
 * The real config file is plain JSON at ~/.nr-ai-observe/config.json.
 * JSON does not allow comments, so use this file as a reference, then copy
 * only the fields you need into config.json.
 *
 * Load priority for every field: CLI flag > environment variable > config file > built-in default.
 *
 * MINIMUM WORKING CONFIG
 * ----------------------
 * Only licenseKey and accountId are required. Everything else has a sensible default.
 *
 * {
 *   "licenseKey": "YOUR_LICENSE_KEY_NRAL",
 *   "accountId": "YOUR_ACCOUNT_ID"
 * }
 */

export default {

  // ---------------------------------------------------------------------------
  // Required
  // ---------------------------------------------------------------------------

  // New Relic ingest license key (starts with the account's license key suffix).
  // Use a License key, NOT a User API key (NRAK-...).
  // Where to find it: NR One → top-right menu → API keys → create a License key.
  // Env: NEW_RELIC_LICENSE_KEY
  // Default: none (required — server will not start without it)
  licenseKey: 'YOUR_LICENSE_KEY_NRAL',

  // Your New Relic account ID — the number visible in the URL when logged in.
  // e.g., https://one.newrelic.com/nr1-core?account=12345
  // Env: NEW_RELIC_ACCOUNT_ID
  // Default: none (required — server will not start without it)
  accountId: 'YOUR_ACCOUNT_ID',

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  // Your developer handle. Appears as the `developer` attribute on every NR
  // event and metric, enabling per-developer filtering in dashboards and alerts.
  // Normalized to lowercase with underscores: "John Doe" → "john_doe".
  // If unset, falls back to $USER → $USERNAME → git config user.name → "unknown".
  // Env: NEW_RELIC_AI_MCP_DEVELOPER
  // Default: inferred from $USER / $USERNAME / git
  developer: 'john_doe',

  // Application name tag applied to all NR events.
  // Env: NEW_RELIC_AI_MCP_APP_NAME
  // Default: "nr-ai-mcp-server"
  appName: 'nr-ai-mcp-server',

  // Team identifier — tags all events with a team dimension so you can filter
  // dashboards and alerts by team across multiple developers.
  // Env: NEW_RELIC_AI_TEAM_ID
  // Default: null (no team tagging)
  teamId: 'backend-team',

  // Project identifier. Auto-inferred from your git remote URL if not set
  // (e.g., github.com:mycompany/my-app.git → "mycompany/my-app").
  // Set explicitly if your git remote differs from your logical project name.
  // Env: NEW_RELIC_AI_PROJECT_ID
  // Default: derived from git remote
  projectId: 'my-app',

  // Organization identifier for multi-org NR accounts.
  // Env: NEW_RELIC_AI_ORG_ID
  // Default: null
  orgId: 'mycompany',

  // ---------------------------------------------------------------------------
  // Budget Thresholds
  // ---------------------------------------------------------------------------
  // When a budget threshold is crossed, the server emits an AiBudgetWarning
  // event and logs a warning. Budget warnings fire at 50%, 80%, and 100%.
  // Set to null to disable budget tracking for that period.

  // Maximum USD spend in a single session.
  // Env: NEW_RELIC_AI_SESSION_BUDGET_USD
  // Default: null (unlimited)
  sessionBudgetUsd: 5.00,

  // Maximum USD spend in a single calendar day (rolling sum of sessions today).
  // Env: NEW_RELIC_AI_DAILY_BUDGET_USD
  // Default: null (unlimited)
  dailyBudgetUsd: 10.00,

  // Maximum USD spend across the current rolling 7-day window.
  // Env: NEW_RELIC_AI_WEEKLY_BUDGET_USD
  // Default: null (unlimited)
  weeklyBudgetUsd: 50.00,

  // ---------------------------------------------------------------------------
  // Personal Alert Thresholds
  // ---------------------------------------------------------------------------
  // Used by deploy-alerts.ts --developer <name> to create a per-developer
  // alert policy with thresholds tailored to your usage patterns.
  // These are not enforced at runtime — they configure the NR alert conditions
  // deployed via the script.

  alerts: {
    personal: {
      // Fire when daily spend exceeds this amount (USD).
      // Default: 2
      dailyCostUsd: 2,

      // Fire when a single session exceeds this amount (USD).
      // Default: 0.50
      sessionCostUsd: 0.50,

      // Fire when your efficiency score stays below this for 30+ minutes.
      // Default: 40
      efficiencyScoreMin: 40,

      // Fire when stuck-loop anti-patterns exceed this count in a 5-minute window.
      // Default: 2
      stuckLoopCountMax: 2,
    },
  },

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------

  // High security mode. Forces recordContent to false regardless of other settings.
  // When true, no tool input/output content is ever stored or sent to NR.
  // Env: NEW_RELIC_AI_HIGH_SECURITY
  // Default: false
  highSecurity: false,

  // Whether to include tool call content (file contents, command output) in NR events.
  // Automatically disabled when highSecurity is true.
  // Env: NEW_RELIC_AI_MCP_RECORD_CONTENT
  // Default: false
  recordContent: false,

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  // Root directory for all local storage (sessions/, weekly_summaries/, buffer.jsonl).
  // Env: NEW_RELIC_AI_MCP_STORAGE_PATH
  // Default: ~/.nr-ai-observe
  storagePath: '~/.nr-ai-observe',

  // Path to the hook event buffer file. The collector-script writes here;
  // the MCP server drains it on its poll interval.
  // Env: NEW_RELIC_AI_MCP_BUFFER_PATH
  // Default: <storagePath>/buffer.jsonl
  hookBufferPath: '~/.nr-ai-observe/buffer.jsonl',

  // Auto-purge session files older than this many days on server startup.
  // Set to null to keep sessions indefinitely.
  // Env: NEW_RELIC_AI_RETAIN_SESSIONS_DAYS
  // Default: null (unlimited retention)
  retainSessionsDays: 90,

  // ---------------------------------------------------------------------------
  // Telemetry Harvest
  // ---------------------------------------------------------------------------

  // How often to flush buffered events to the NR Events API (milliseconds).
  // Env: NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS
  // Range: 100–3600000. Default: 5000 (5 seconds)
  harvestEventsMs: 5000,

  // How often to flush aggregated metrics to the NR Metric API (milliseconds).
  // Env: NEW_RELIC_AI_MCP_HARVEST_METRICS_MS
  // Range: 100–3600000. Default: 60000 (60 seconds)
  harvestMetricsMs: 60000,

  // ---------------------------------------------------------------------------
  // New Relic Connectivity
  // ---------------------------------------------------------------------------

  // Override the NR collector endpoint region.
  // "eu"       → routes to the EU data center (metric-api.eu.newrelic.com, etc.)
  // "staging"  → routes to the NR staging environment (for NR employees/testers)
  // null       → US data center (default)
  // Auto-set to "eu" when licenseKey starts with "eu01".
  // Env: NEW_RELIC_HOST
  // Default: null (US)
  collectorHost: null,

  // New Relic User API key (starts with NRAK-). Used by the
  // nr_observe_get_team_summary tool to query NR via NerdGraph.
  // Not required for telemetry ingestion — only for the cross-account NerdGraph calls.
  // Where to find it: NR One → top-right menu → API keys → create a User key.
  // Env: NEW_RELIC_API_KEY
  // Default: null
  nrApiKey: 'NRAK-XXXXXXXXXXXXXXXXXXXXXXXXXX',

  // ---------------------------------------------------------------------------
  // Weekly Digest
  // ---------------------------------------------------------------------------

  // Slack (or any HTTP) webhook URL for automated weekly cost + efficiency digests.
  // Use nr_observe_subscribe_digest to set this interactively via MCP.
  // Env: NEW_RELIC_AI_DIGEST_WEBHOOK_URL
  // Default: null (digest delivery disabled)
  digestWebhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX',

  // Cron expression for when the weekly digest is sent (server's local time).
  // Env: NEW_RELIC_AI_DIGEST_SCHEDULE
  // Default: "0 9 * * 1" (Monday at 9:00 AM)
  digestSchedule: '0 9 * * 1',

  // ---------------------------------------------------------------------------
  // AI Model
  // ---------------------------------------------------------------------------

  // The AI model in use. Used for cost estimation when token counts are not
  // reported via nr_observe_report_tokens (byte-size fallback path).
  // Must match a model name in the pricing table (packages/shared/src/pricing-data.ts).
  // Env: NEW_RELIC_AI_MODEL
  // Default: "claude-sonnet-4-6"
  model: 'claude-sonnet-4-6',

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  // Set to false to disable the MCP server entirely without uninstalling it.
  // The server will start, complete the MCP handshake, and exit cleanly.
  // Env: NEW_RELIC_AI_MCP_ENABLED
  // Default: true
  enabled: true,

  // Log level for the server's structured stderr output.
  // Env: NEW_RELIC_AI_LOG_LEVEL
  // Default: "info"
  logLevel: 'info',  // "debug" | "info" | "warn" | "error"

  // HTTP port used in proxy mode (--no-stdio flag). Not used in stdio mode.
  // Env: NEW_RELIC_AI_MCP_PORT
  // Default: 9847
  port: 9847,

  // ---------------------------------------------------------------------------
  // Proxy Mode Upstreams (advanced)
  // ---------------------------------------------------------------------------
  // Used only when running the server in HTTP proxy mode (without --stdio).
  // Each entry describes an upstream MCP server to forward requests to.
  // Env: NEW_RELIC_AI_MCP_PROXY_UPSTREAMS (JSON array string)
  // Default: [] (proxy mode is disabled when this is empty)

  proxyUpstreams: [
    // HTTP upstream — forward to another MCP server running over HTTP
    {
      name: 'my-remote-mcp',
      transportType: 'http',
      url: 'http://localhost:3000/mcp',
      // Request timeout in milliseconds. Default: 30000
      timeoutMs: 30000,
      // Allow private/loopback addresses (127.x, 10.x, etc.).
      // For local dev only — never set true in production.
      allowPrivateHosts: false,
    },

    // Stdio upstream — spawn a local MCP server as a child process
    {
      name: 'my-local-mcp',
      transportType: 'stdio',
      command: '/usr/bin/node',
      args: ['dist/server.js', '--stdio'],
      // Additional environment variables for the child process (optional).
      env: {
        SOME_VAR: 'value',
      },
      // Allow bare command names (e.g., "node" instead of "/usr/bin/node").
      // For local dev only — never set true in production.
      allowBareCommand: false,
    },
  ],
};

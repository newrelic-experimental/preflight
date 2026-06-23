/**
 * Example configuration for preflight.
 *
 * Use this as a reference when creating ~/.newrelic-preflight/config.json.
 * The config file must be valid JSON — copy individual fields you want to set
 * and omit the JS comments. Every field is optional except licenseKey and accountId.
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

  // User-defined team label (e.g. 'platform-eng') stamped on every NR event as team_id
  // for cross-developer queries. Not your NR account ID — a free-form slug you choose.
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
  sessionBudgetUsd: 5.0,

  // Maximum spend per calendar day in USD before a budget warning event is emitted.
  // Env: NEW_RELIC_AI_DAILY_BUDGET_USD
  dailyBudgetUsd: 20.0,

  // Maximum spend per calendar week in USD before a budget warning event is emitted.
  // Env: NEW_RELIC_AI_WEEKLY_BUDGET_USD
  weeklyBudgetUsd: 100.0,

  // ── Personal alert thresholds ─────────────────────────────────────────────
  // Used by: preflight deploy-alerts --developer <name>
  // Defaults: dailyCostUsd: 2, sessionCostUsd: 0.50, efficiencyScoreMin: 40, stuckLoopCountMax: 2

  alerts: {
    personal: {
      dailyCostUsd: 2,
      sessionCostUsd: 0.5,
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
  // Default: ~/.newrelic-preflight
  storagePath: '~/.newrelic-preflight',

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

  // New Relic region. Auto-detected from license key prefix; override only if needed.
  // Env: NEW_RELIC_HOST  (null = US default, "eu" = EU, "gov" = FedRAMP)
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

  // ── OTLP/HTTP transport (optional — for Datadog, Grafana Cloud, etc.) ───────

  // OTLP/HTTP endpoint URL. When set, telemetry is also exported via OTLP.
  // For New Relic OTLP endpoints:
  //   US: https://otlp.nr-data.net
  //   EU: https://otlp.eu01.nr-data.net
  // For other backends (Datadog, Grafana Cloud, Honeycomb), use their OTLP endpoint.
  // Env: OTEL_EXPORTER_OTLP_ENDPOINT
  // Default: null (disabled)
  otlpEndpoint: null,

  // Additional HTTP headers for OTLP exporter (e.g., authentication).
  // For New Relic OTLP, use: { "api-key": "<NR_LICENSE_KEY>" }
  // For Datadog, use: { "dd-api-key": "<DATADOG_API_KEY>" }
  // Env: OTEL_EXPORTER_OTLP_HEADERS (comma-separated key=value pairs, e.g. "api-key=xxx,other=yyy")
  // Default: {}
  otlpHeaders: {},

  // Transport mode when otlpEndpoint is configured.
  // - 'nr-events-api' (default): NR Events API + Metric API only
  // - 'otlp': OTLP/HTTP only (requires otlpEndpoint)
  // - 'both': NR Events API + OTLP simultaneously
  // Env: NEW_RELIC_AI_TRANSPORT
  // Default: "nr-events-api"
  transport: 'nr-events-api',

  // ── OTLP receiver (proxy mode only — receives OTel spans from local apps) ───

  // Enable a local OTLP/HTTP receiver on the proxy. Any app pointing at
  // http://localhost:<otlpReceiverPort> will have its spans enriched with the
  // current coding session context and forwarded to New Relic.
  // Env: NR_AI_OTLP_RECEIVER_ENABLED  (true/false)
  // Default: false
  otlpReceiverEnabled: false,

  // Port for the local OTLP/HTTP receiver.
  // Env: NR_AI_OTLP_RECEIVER_PORT
  // Default: 4318
  otlpReceiverPort: 4318,

  // Where to forward received spans. Defaults to the NR US OTLP endpoint when
  // licenseKey is present. Set to null to receive and enrich only (no forward).
  // Env: NR_AI_OTLP_FORWARD_ENDPOINT
  otlpForwardEndpoint: 'https://otlp.nr-data.net',

  // HTTP headers added to every forwarded OTLP request.
  // Defaults to { 'api-key': licenseKey } when licenseKey is present.
  // Env: NR_AI_OTLP_FORWARD_HEADERS (comma-separated key=value pairs)
  otlpForwardHeaders: { 'api-key': 'YOUR_LICENSE_KEY_NRAL' },

  // ── NR User API key (for team queries and deploying dashboards/alerts) ───────

  // User API key (NRAK-...). Used for team summary queries and deploying dashboards/alerts.
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

  // ── Local dashboard mode ───────────────────────────────────────────────────
  //
  // `mode` controls what destinations receive your AI-coding telemetry:
  //
  //   'cloud' — (default) ship every event to New Relic. Existing behaviour.
  //             Requires `licenseKey` and `accountId`.
  //   'local' — keep all data on your machine. The MCP server boots an
  //             embedded HTTP dashboard at http://127.0.0.1:7777 and does
  //             NOT send anything to NR. `licenseKey` is optional.
  //   'both'  — do both. Useful as a transition aid.
  //
  // Env: NR_AI_MODE
  // Default: "cloud"
  // mode: 'cloud',
  //
  // dashboard: {
  //   port: 7777,             // local HTTP port for the dashboard
  //   host: '127.0.0.1',      // non-loopback values are warned and overridden
  //   openOnStart: false,
  // },

  // ── Model ─────────────────────────────────────────────────────────────────

  // AI model identifier stamped on NR events when not inferred from tool calls.
  // Env: NEW_RELIC_AI_MODEL
  // Default: "claude-sonnet-4-6"
  model: 'claude-sonnet-4-6',

  // ── Proxy upstreams (proxy mode only) ─────────────────────────────────────
  // Used when running: preflight proxy --port 9847
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

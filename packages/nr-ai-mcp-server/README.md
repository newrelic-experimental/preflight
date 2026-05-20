# nr-ai-mcp-server

MCP server for New Relic observability of AI coding assistants. Hooks into Claude Code (and other IDE tools) to capture tool calls, track costs, detect anti-patterns, and measure developer efficiency — all telemetry flows to New Relic.

## Features

- **16+ MCP tools** — Query session stats, cost breakdowns, efficiency scores, anti-patterns, recommendations, and more from Claude Code
- **18 metric analyzers** — Cost tracking, budget alerts, anti-pattern detection, efficiency scoring, context window analysis, latency percentiles, task completion rates, collaboration profiling, personal coaching, and more
- **7 platform adapters** — Claude Code, Cursor, Windsurf, GitHub Copilot, Zed, Continue.dev, Amazon Q Developer
- **Pre-built dashboards** — Deploy 7 ready-to-use New Relic dashboards (overview, security, platform comparison, team view, session detail, manager view, personal)
- **Alert conditions** — 5 NRQL-based alert conditions for tracking sessions, cost budgets, and efficiency thresholds
- **HTTP proxy** — Optional proxy mode for forwarding requests to upstream MCP servers while recording metrics
- **Local persistence** — Session histories, weekly summaries, audit trail
- **Budget tracking** — Session/daily/weekly spending caps with threshold-based warnings (50%, 80%, 100%)

## Installation

```bash
npm install -g nr-ai-mcp-server
```

## Quick Start

### 1. Install the hook

```bash
nr-ai-observe install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID
```

This sets up the hook script in Claude Code to capture every tool call. The server runs as a persistent process.

### 2. Deploy dashboards (optional)

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all
```

Deploys 7 pre-built dashboards to your New Relic account. Add `--staging` if your account is on the New Relic staging environment.

### 3. Start querying

In Claude Code, ask: *"Can you call `nr_observe_get_session_stats` and show me the result?"*

The server exposes 16+ tools that Claude Code can invoke to analyze your current session.

---

## MCP Tools

All tools query running metric analyzers. Key tools:

| Tool | Purpose |
|------|---------|
| `nr_observe_get_session_stats` | Session overview (tool counts, total time, distinct tools) |
| `nr_observe_get_efficiency_score` | Composite efficiency score (0-100) with per-dimension breakdown |
| `nr_observe_get_cost_breakdown` | Cost breakdown by tool, model, and outcome type |
| `nr_observe_get_budget_status` | Current spend vs session/daily/weekly caps |
| `nr_observe_get_cost_forecast` | Projected spend for end-of-day, end-of-week, end-of-session |
| `nr_observe_get_anti_patterns` | Detected thrashing, re-reads, blind edits, stuck loops |
| `nr_observe_get_context_efficiency` | File read metrics (unique vs repeated, top re-read files) |
| `nr_observe_get_latency_percentiles` | p50/p95/p99 latency per tool type |
| `nr_observe_get_model_usage` | Per-model request counts, tokens, cost, cost-efficiency ratio |
| `nr_observe_get_team_summary` | Team-aggregated metrics (requires team config) |
| `nr_observe_get_recommendations` | Personalized optimization recommendations |
| `nr_observe_get_personal_insights` | Narrative coaching report vs. personal weekly baseline (requires 2+ weeks of history) |
| `nr_observe_subscribe_digest` | Enable weekly cost/efficiency digest to Slack webhook |
| `nr_observe_unsubscribe_digest` | Remove registered Slack webhook for weekly digests |
| `nr_observe_send_digest` | Generate and POST the current week's digest immediately |

See [COMMANDS_TABLE.md](../../docs/COMMANDS_TABLE.md) for full documentation.

---

## Configuration

Config loads from **CLI > environment variables > config file > defaults**.

### Key Environment Variables

```bash
# New Relic (required)
export NEW_RELIC_LICENSE_KEY="175cae4b..."
export NEW_RELIC_ACCOUNT_ID=12345
export NEW_RELIC_REGION=us                    # or eu

# MCP Server
export NEW_RELIC_AI_PLATFORM=claude-code      # auto-detect if not set
export NEW_RELIC_AI_HARVEST_EVENTS_MS=5000
export NEW_RELIC_AI_HARVEST_METRICS_MS=60000

# Budget thresholds (optional)
export NEW_RELIC_AI_SESSION_BUDGET_USD=5.00   # Per-session cap
export NEW_RELIC_AI_DAILY_BUDGET_USD=10.00    # Per-day cap
export NEW_RELIC_AI_WEEKLY_BUDGET_USD=50.00   # Per-week cap

# Developer identity (normalised to lowercase with underscores)
export NEW_RELIC_AI_MCP_DEVELOPER=john_doe    # Falls back to $USER / $USERNAME / git user.name

# Team/org tagging
export NEW_RELIC_AI_TEAM_ID=backend-team
export NEW_RELIC_AI_PROJECT_ID=my-app         # Auto-derived from git if not set
export NEW_RELIC_AI_ORG_ID=mycompany

# Session retention
export NEW_RELIC_AI_RETAIN_SESSIONS_DAYS=30   # Auto-purge old sessions

# Weekly digest
export NEW_RELIC_AI_DIGEST_WEBHOOK_URL=https://hooks.slack.com/services/...
export NEW_RELIC_AI_DIGEST_SCHEDULE="0 9 * * 1"  # Cron: Mon 9am
```

Or via config file at `~/.nr-ai-observe/config.json`:

```json
{
  "licenseKey": "175cae4b...",
  "accountId": 12345,
  "appName": "my-app",
  "developer": "john_doe",
  "teamId": "backend-team",
  "projectId": "my-app",
  "orgId": "mycompany",
  "sessionBudgetUsd": 5.00,
  "dailyBudgetUsd": 10.00,
  "weeklyBudgetUsd": 50.00,
  "retainSessionsDays": 30,
  "digestWebhookUrl": "https://hooks.slack.com/...",
  "digestSchedule": "0 9 * * 1"
}
```

For every available option with descriptions, types, defaults, and env variable overrides, see [`example.config.js`](./example.config.js).

---

## Platforms Supported

| Platform | Setup | Auto-detect |
|----------|-------|-------------|
| Claude Code | `nr-ai-observe install` | ✅ |
| Cursor | Env: `NEW_RELIC_AI_PLATFORM=cursor` | ✅ (if Cursor config exists) |
| Windsurf | Env: `NEW_RELIC_AI_PLATFORM=windsurf` | ✅ (if Windsurf config exists) |
| GitHub Copilot | Env: `NEW_RELIC_AI_PLATFORM=copilot` | Manual setup required |
| Zed | Env: `NEW_RELIC_AI_PLATFORM=zed` | ✅ (if Zed config exists) |
| Continue.dev | Env: `NEW_RELIC_AI_PLATFORM=continue` | ✅ (if Continue config exists) |
| Amazon Q Developer | Env: `NEW_RELIC_AI_PLATFORM=amazonq` | AWS IDE plugin required |

All platforms normalize tool calls into the shared `AiToolCall` event schema, so dashboards and metrics work uniformly across all tools.

---

## Architecture

### Metric Analyzers (18 total)

The server runs 18 analyzer classes that each receive tool call records and maintain running state:

1. **SessionTracker** — Per-session tool call aggregation
2. **CostTracker** — Token cost calculation and per-model breakdown
3. **BudgetTracker** — Spending caps and threshold alerts
4. **TaskDetector** — Task boundary detection and multi-turn tracking
5. **AntiPatternDetector** — Thrashing, re-reads, blind edits, stuck loops
6. **EfficiencyScorer** — Composite efficiency score (0-100)
7. **TrendAnalyzer** — Weekly trend analysis and historical tracking
8. **CollaborationProfiler** — Developer collaboration patterns and metrics
9. **ClaudeMdTracker** — CLAUDE.md change impact analysis
10. **CostPerOutcomeAnalyzer** — Cost breakdown by outcome type (bug fix, feature, refactor, etc.)
11. **PromptFeedbackEngine** — Feedback collection and quality signal tracking
12. **RecommendationEngine** — Personalized optimization recommendations
13. **ContextWindowTracker** — Context window usage and pressure analysis
14. **LatencyTracker** — Tool latency distribution and percentiles
15. **TaskCompletionTracker** — Task lifecycle metrics (duration, status transitions)
16. **ModelUsageTracker** — Per-model usage and efficiency analysis
17. **ProxyMetricsTracker** — Upstream server latency and tool popularity (proxy mode only)
18. **PersonalCoach** — Narrative coaching report comparing the developer's current week to their historical baseline (powers `nr_observe_get_personal_insights`)

### Event Flow (Stdio Mode)

```
Claude Code
  ├─ PreToolUse / PostToolUse hooks
  │    └─> nr-ai-observe (collector-script)
  │         └─> buffer.jsonl (LocalStore)
  │
  └─ MCP stdio connection
       └─> NrMcpServer
            ├─ HookEventProcessor (polls buffer)
            │    └─> pairs pre/post → ToolCallRecord
            │         └─> 17 metric analyzers
            │
            ├─ NrIngestManager
            │    ├─ Events → NR Events API (5s)
            │    └─ Metrics → NR Metric API (60s)
            │
            └─ MCP Tools (queried by Claude Code)
                 └─ 16+ tools via registerTools()
```

---

## Dashboards

### Deploy all dashboards

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all
```

Add `--staging` to target the New Relic staging environment.

### Available dashboards

1. **Overview** — Session stats, efficiency score, cost summary, top tools
2. **Security** — Sensitive file access, destructive commands, audit trail
3. **Platform Comparison** — Metrics across Claude Code, Cursor, Windsurf, etc.
4. **Team View** — Aggregated team and project metrics
5. **Session Detail** — Deep dive into a specific session with all analyzer output
6. **Manager View** — Team-level cost and efficiency by developer (no tool-call content)
7. **Personal** — 30-day self-reflection view scoped to one developer (deploy with `--developer <name>`)

Use `--print` to output JSON for manual import via the New Relic UI.

### Personal developer dashboard

Deploy a self-reflection dashboard pre-filtered to your identity:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer cdehaan
```

The `--developer` flag sets the default filter so the dashboard opens pre-scoped to your data.

---

## Alert Conditions

### Deploy alerts

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts
```

Add `--staging` to target the New Relic staging environment.

Creates an "AI Coding Assistant Alerts" policy with 5 conditions:

1. **High error rate** (error rate > 5%)
2. **Session timeout** (no tool calls for 10+ min)
3. **Efficiency drop** (efficiency score < 40)
4. **Cost spike** (hourly cost > $5)
5. **Budget warning** (spend > threshold) — disabled by default

Use `--dry-run` to preview. Use `--teardown` to remove all conditions.

### Personal alert conditions

Deploy alert conditions scoped to a single developer:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --developer cdehaan
```

This creates a separate policy named "AI Coding — Personal — cdehaan" with tighter thresholds.

To customise personal thresholds, add an `alerts.personal` section to `~/.nr-ai-observe/config.json`:

```json
{
  "alerts": {
    "personal": {
      "dailyCostUsd": 3,
      "sessionCostUsd": 0.75,
      "efficiencyScoreMin": 35
    }
  }
}
```

To remove:
```bash
npx tsx scripts/deploy-alerts.ts --developer cdehaan --teardown
```

### Backfilling session history

If you have NR telemetry from prior sessions but no local session files, use the backfill script to seed the local store so `nr_observe_get_personal_insights` and weekly summaries have data to work from:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/backfill-sessions.ts \
  --developer <your-name> [--days 90] [--dry-run] [--staging]
```

Sessions already present locally are skipped. Run `--dry-run` first to preview what would be written.

---

## Testing

```bash
npm test -- packages/nr-ai-mcp-server
```

Key test patterns:
- Mock `process.stderr.write` to suppress logger output
- Use factory helpers: `makeRecord()`, `makeSummary()`, `makeManager()`
- Fake timers for harvest scheduler and poll interval tests
- Temp directories with cleanup for storage tests

---

## TypeScript

- ESM modules with `.js` import extensions
- Strict mode enabled
- Dependencies: `@modelcontextprotocol/sdk`, `zod`, `commander`
- Project references to `@nr-ai-observatory/shared`

---

## See Also

- [@nr-ai-observatory/shared](../shared/) — Transport layer, events, pricing
- [nr-ai-agent](../nr-ai-agent/) — SDK wrappers for AI model clients
- [CLAUDE.md](../../CLAUDE.md) — Full technical reference
- [COMMANDS_TABLE.md](../../docs/COMMANDS_TABLE.md) — All 16+ MCP tools
- [METRICS_TABLE.md](../../docs/METRICS_TABLE.md) — Event and metric schema

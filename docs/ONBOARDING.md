# NR AI Observatory — New Developer Onboarding

Welcome! This guide walks you through everything you need to get productive in this repo. It covers what the project does, how to set up your environment, how the code is organized, and the conventions we follow.

---

## What Is This Project?

NR AI Observatory provides **observability for AI coding assistants**. When developers use tools like Claude Code, Cursor, Windsurf, or Copilot, this project captures what's happening — tool calls, token usage, costs, efficiency patterns — and sends it all to New Relic.

There are two main integration points:

1. **MCP Server (this repo)** — Hooks into Claude Code via the Model Context Protocol. It captures every tool call, computes metrics like efficiency scores and anti-pattern detection, and exposes MCP tools that Claude Code can query directly (e.g., "show me my session stats").

2. **SDK Agent** — Lives in the separate [`nr-ai-typescript-agent`](https://github.com/) repo. Wraps Anthropic, Google Gemini, OpenAI, AWS Bedrock, Mistral, and Cohere SDK clients. Your application code uses the wrapped client exactly like the original, but every API call is automatically instrumented and sent to New Relic.

Both projects share a common transport layer that handles event buffering, metric aggregation, and HTTP delivery to New Relic's APIs. In this repo it lives at `src/shared/` (synced from `nr-ai-typescript-shared` via `npm run sync:shared`); in the agent repo it lives in the `nr-ai-typescript-shared` package itself.

---

## Getting Started

### Prerequisites

- Node.js v24 (check `.nvmrc`)
- A New Relic account with a license key and account ID
- Access to New Relic's private npm registry ([setup guide](https://source.datanerd.us/commune/npm-setup))

### First-time setup

```bash
nvm install        # Install the right Node version (v24, from .nvmrc)
nvm use            # Activate it
# Clone the shared sibling repo at ../nr-ai-typescript-shared if you plan to pull updates with `npm run sync:shared`.
# Day-to-day development does NOT require it — `src/shared/` is checked in.
npm install        # Install dependencies
npm run build      # Build TypeScript and chmod +x the CLI binaries
npm link           # Register nr-ai-observe on PATH (required for Claude Code hooks)
npm test           # Verify everything works
```

### Useful commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Build TypeScript (`tsc --build`) and chmod the CLI binaries |
| `npm run build:clean` | Remove build output |
| `npm test` | Run the full Jest suite (`maxWorkers: 1`) |
| `npm run lint` | ESLint over `src/` |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check (no writes) |
| `npm run sync:shared` | Pull latest source from `../nr-ai-typescript-shared` into `src/shared/` (warns on dirty upstream) |
| `npm run deploy:dashboard` | Deploy the default NR dashboard |
| `npm run deploy:dashboard:all` | Deploy every pre-built dashboard |
| `npm run deploy:dashboard:update` | Sync every pre-built dashboard in place (preserves GUID/URL) |
| `npm run deploy:dashboard:teardown` | Delete every pre-built dashboard (matches by name; missing = skipped) |
| `npm run deploy:alerts` | Deploy the alert policy + conditions to NR |
| `npm run deploy:alerts:update` | Sync conditions on the existing alert policy in place |
| `npm run deploy:alerts:teardown` | Delete the alert policy and all its conditions |
| `npm run backfill:sessions` | Backfill local session JSON files from NR event history |

To run a single test file:

```bash
npx jest -- src/metrics/cost-tracker.test.ts
npx jest -- src/shared/harvest/harvest-scheduler.test.ts
```

To build directly without the chmod step:

```bash
npx tsc -b .
```

**Working with shared code:** `src/shared/` is a **read-only mirror** — never edit it directly here. Make the change in the upstream `nr-ai-typescript-shared` repo, then run `npm run sync:shared` to pull it in and commit the regenerated tree. Only code that is consumed by **both** this MCP server and the `nr-ai-typescript-agent` belongs in shared. See [CLAUDE.md](../CLAUDE.md) for the full rules.

---

## Project Structure

This is a flat single-package repo. Source lives directly under `src/`. There is no `packages/` directory and no npm workspaces. The TypeScript SDK agent (`nr-ai-agent`) lives in the separate `nr-ai-typescript-agent` repo, and CI/CD tooling lives in `nr-ai-github-tools`.

```
nr-ai-observatory/
  src/
    shared/        # Transport, events, pricing, harvest scheduler (synced from nr-ai-typescript-shared)
    hooks/         # Hook collector + pre/post event pairing
    metrics/       # 19 analyzer classes (session, cost, anti-patterns, efficiency, …)
    tools/         # MCP tool handlers
    proxy/         # HTTP proxy + upstream transports
    storage/       # JSON session and weekly summary persistence
    security/      # Audit trail + SSRF helpers
    tracing/       # OTel span lifecycle
    transport/     # NR ingest manager + log ingest
    platforms/     # 8 platform adapters (Claude Code, Cursor, Windsurf, …)
    digest/        # Slack digest formatter and sender
    install/       # nr-ai-observe install / setup CLI
    alerts/        # Alert TS types (JSON files live in alerts/ at repo root)
  alerts/          # Alert policy + condition JSON definitions
  dashboards/      # Pre-built NR dashboard JSON files
  scripts/         # sync-shared.ts, deploy-dashboard.ts, deploy-alerts.ts, backfill-sessions.ts
```

For a complete annotated tree, see [CLAUDE.md](../CLAUDE.md).

### Shared transport layer (`src/shared/`)

The foundation layer is checked in at `src/shared/` and synced from the upstream `nr-ai-typescript-shared` package via `npm run sync:shared`. Internal imports use a relative path: `import { createLogger } from '../shared/index.js'`. Provides:

- **Event creation** — `createAiRequest()`, `createAiResponse()`, serialization to NR format
- **Transport** — HTTP clients for New Relic's Events, Metric, and Logs APIs, plus an OTLP/HTTP exporter
- **Harvest scheduler** — Periodic flush of buffered events (5s) and metrics (60s) with bounded retry buffers
- **Token utilities** — Extract token counts from Anthropic/Gemini API responses
- **Pricing** — Calculate USD cost from token counts using model-specific pricing tables
- **Logger** — `createLogger('name')` writes structured JSON to stderr

### SDK Agent (separate repo)

The agent that wraps Anthropic, Google Gemini, OpenAI, Bedrock, Mistral, and Cohere SDKs is maintained in the `nr-ai-typescript-agent` repo:

```typescript
import { init } from 'nr-ai-agent';
const agent = init({ licenseKey: '...', accountId: '12345' });
const client = agent.wrapAnthropicClient(rawAnthropicClient);
// Use client normally — agent captures everything in the background
await agent.shutdown();
```

Look there for SDK-instrumentation work; this repo only contains the MCP server.

### MCP server subsystems

The MCP server is composed of these subsystems under `src/`:

- **Hooks** (`src/hooks/`) — Claude Code invokes a hook script on every tool use. The collector writes events to a local JSONL buffer. The event processor drains the buffer, pairs pre/post events, and emits `ToolCallRecord` objects.

- **Metrics** (`src/metrics/`) — 19 analyzer classes that each receive tool call records and maintain running state. Session tracking, cost tracking + forecasting, task detection, anti-pattern detection, efficiency scoring, trend analysis, collaboration profiling, proxy metrics, personal coaching, and more.

- **Tools** (`src/tools/`) — MCP tool handlers that query the metric trackers and return results. These are the tools that Claude Code can call (e.g., `nr_observe_get_session_stats`). Registered via `registerTools()` in `src/tools/session-stats.ts`.

- **Proxy** (`src/proxy/`) — HTTP proxy layer that forwards requests to upstream MCP servers while recording latency and tool call metrics.

- **Storage** (`src/storage/`) — Local file persistence for session summaries and weekly aggregations under `~/.nr-ai-observe/`.

- **Security** (`src/security/`) — Audit trail that classifies tool calls and flags sensitive file access or destructive commands; SSRF validation for outbound URLs.

- **Tracing** (`src/tracing/`) — OTel span management. When `transport !== 'nr-events-api'`, emits a session root span, intermediate task spans from `TaskDetector` boundaries, and a leaf span per `ToolCallRecord`. The resulting waterfall is visible in any OTel-compatible backend.

---

## Key Concepts

### ToolCallRecord

The central data type. Every tool call captured by the hooks becomes a `ToolCallRecord` with fields like `toolName`, `durationMs`, `success`, `filePath`, `command`, `exitCode`, etc. This record flows through all metric trackers.

### HarvestScheduler

Events and metrics are buffered in memory and flushed to New Relic on a timer. Events flush every 5 seconds, metrics every 60 seconds. Failed batches are re-queued with a bounded retry buffer. The scheduler handles graceful shutdown by awaiting a final flush.

### Metric Trackers

All trackers follow the same pattern:
```typescript
tracker.recordToolCall(record);    // feed data in
tracker.getMetrics();               // read state out
tracker.reset(sessionId);           // clear for new session
```

Each tracker has a corresponding test file with factory helpers.

### MCP (Model Context Protocol)

The server communicates with Claude Code over stdio using JSON-RPC. It registers tools that Claude Code can discover and invoke. The `@modelcontextprotocol/sdk` package handles the protocol; our code registers tool handlers and implements the business logic.

---

## Configuration Reference

For a complete annotated reference of every config option — including types, defaults, and env variable overrides — see [`example.config.js`](../example.config.js).

### Choosing a mode

NR AI Observatory supports three modes via the `mode` config field:

1. **`cloud`** (default) — telemetry ships to New Relic. Required for cross-team dashboards.
2. **`local`** — telemetry stays on your machine; dashboard runs at `http://127.0.0.1:7777`.
3. **`both`** — both behaviors active. Useful as a transition aid or to verify local data matches cloud.

If you're not sure, start with **`local`** to see what data the tool collects before opting into cloud transport.

#### Verifying local mode

After setting `mode: 'local'`:

```bash
# Restart Claude Code, then:
curl -s http://127.0.0.1:7777/api/health
# Expected: {"ok":true,"uptime":<number>}
```

You should also see this line in Claude Code's MCP startup logs:

```
Dashboard ready at http://127.0.0.1:7777
```

If the URL is unreachable, check whether port 7777 is in use (`lsof -i:7777`) and override with `NR_AI_DASHBOARD_PORT`.

#### Local alerts

In local and both modes, the server evaluates threshold rules in-process and surfaces firing alerts in the dashboard banner stack. Rules live at `~/.nr-ai-observe/alerts/rules.json`; a starter set is copied into place by the setup wizard. To customise: edit the file in your editor — the engine watches the file and reloads on save (within ~200 ms, no restart needed). To disable a rule, set its `"enabled": false` field; to disable the engine entirely, set `alerts.enabled: false` in your config (or `NR_AI_ALERTS_ENABLED=false`). To opt into native OS notifications for critical alerts, set `alerts.osNotifications: true` in your config and add `"os"` to the relevant rule's `channels` array. See the [Local Alerts](../README.md#local-alerts) section of the README for the full list of rule types and config knobs.

### Budget Thresholds

Control spending with optional session/daily/weekly budget caps:

```bash
export NEW_RELIC_AI_SESSION_BUDGET_USD=5.00      # Max spend per session
export NEW_RELIC_AI_DAILY_BUDGET_USD=10.00       # Max spend per day
export NEW_RELIC_AI_WEEKLY_BUDGET_USD=50.00      # Max spend per week
```

The server emits `AiBudgetWarning` events at 50%, 80%, and 100% of each threshold. Set thresholds to `null` (default) for unlimited spending.

### Developer Identity

Set your developer identifier for all NR events. If not set, the server will infer it from `$USER`, `$USERNAME`, or `git config user.name`:

```bash
export NEW_RELIC_AI_MCP_DEVELOPER=john_doe       # Your identifier on all NR events
```

The developer name is normalized to lowercase with underscores (e.g., "John Doe" → "john_doe", "my.user@host" → "my_user_host"). This normalized form is used for exact-match NRQL queries. Set this explicitly if your `$USER` environment variable differs between machines.

### Team and Organization

Tag all telemetry with team/project/org identifiers:

```bash
export NEW_RELIC_AI_TEAM_ID=backend-team         # Your team name
export NEW_RELIC_AI_PROJECT_ID=my-app            # Auto-derived from git remote if not set
export NEW_RELIC_AI_ORG_ID=mycompany             # Organization identifier
```

`projectId` is automatically inferred from your git remote URL (e.g., `github.com:mycompany/my-app.git` → `my-app`). Set explicitly to override.

### Data Retention

Auto-purge old session files to minimize storage:

```bash
export NEW_RELIC_AI_RETAIN_SESSIONS_DAYS=30      # Keep only sessions from last 30 days
```

Default: unlimited retention. Purge happens on server startup.

### Weekly Digest Subscription

Receive automated cost and efficiency summaries:

```bash
export NEW_RELIC_AI_DIGEST_WEBHOOK_URL=https://hooks.slack.com/services/...
export NEW_RELIC_AI_DIGEST_SCHEDULE="0 9 * * 1" # Cron: Mon 9am (default)
```

Or use the MCP tool:
```
nr_observe_subscribe_digest(webhookUrl: "https://hooks.slack.com/services/...")
```

### OTLP Transport (Advanced)

By default, telemetry flows to New Relic's proprietary Events API and Metrics API. To also export to any OpenTelemetry-compatible backend (Datadog, Grafana Cloud, Honeycomb, a self-hosted Collector, or New Relic's OTLP endpoint), configure the `transport` setting:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net     # NR US; or any OTel backend
export OTEL_EXPORTER_OTLP_HEADERS="api-key=your-license-key"    # Comma-separated key=value
export NEW_RELIC_AI_TRANSPORT=both   # 'nr-events-api' (default), 'otlp', or 'both'
```

| Transport mode | Behavior |
|----------------|----------|
| `nr-events-api` | NR Events API + Metric API only (default) |
| `otlp` | OTLP/HTTP only — requires `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `both` | Both transports simultaneously (concurrent export) |

New Relic OTLP endpoints: US `https://otlp.nr-data.net`, EU `https://otlp.eu01.nr-data.net`.

### Inbound OTLP Receiver (Proxy Mode)

When running in **proxy mode**, the observatory can also act as a local OpenTelemetry Collector for other apps running on your machine. Enable it to accept telemetry from any OTel-instrumented application, enrich it with the current session context (`ai.session.id`, `ai.developer`, `ai.project_id`), and forward it to NR. This ties traces from your AI-coded applications back to the coding session that produced them.

```bash
export NR_AI_OTLP_RECEIVER_ENABLED=true                        # Enable inbound OTLP receiver
export NR_AI_OTLP_RECEIVER_PORT=4318                           # Default: 4318 (standard OTLP/HTTP port)
export NR_AI_OTLP_FORWARD_ENDPOINT=https://otlp.nr-data.net   # Where to forward enriched payloads
export NR_AI_OTLP_FORWARD_HEADERS="api-key=your-license-key"  # Auth headers (defaults to your license key)
```

Point your application's OTel SDK at `http://localhost:4318` and its spans/metrics/logs will be enriched and forwarded automatically. JSON OTLP payloads are enriched; protobuf payloads are forwarded as-is.

## Code Conventions

### TypeScript

- ESM modules with `.js` import extensions (required for NodeNext resolution)
- Strict mode enabled
- `readonly` on all interface fields
- `interface` for API contracts, `type` for unions and local aliases

### File Organization

- One module per file, co-located tests: `foo.ts` + `foo.test.ts`
- Files use `kebab-case` naming
- Classes use `PascalCase`, functions use `camelCase`
- Module-level constants use `SCREAMING_SNAKE_CASE`

### Logging

Every module creates a scoped logger:
```typescript
import { createLogger } from '../shared/index.js';
const logger = createLogger('my-module');
```
Logger writes to **stderr** as JSON. Never write to stdout — it's reserved for the MCP stdio transport.

### Error Handling

- Failed network sends re-queue batches for retry (bounded buffer)
- Graceful degradation: if a tracker is unavailable, tools return sensible defaults
- `try/catch` around file I/O operations with logger warnings
- Clock skew protection: `Math.max(0, ...)` on computed durations

---

## Testing

Tests live next to the code they test (`foo.test.ts` alongside `foo.ts`).

### Writing tests

Most test files follow this pattern:

```typescript
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return { id: 'rec-001', toolName: 'Read', /* sensible defaults */ ...overrides };
}
```

- Suppress logger output by mocking `process.stderr.write`
- Use `make*` factory functions with optional `Partial<T>` overrides
- Use `jest.useFakeTimers()` for anything time-dependent
- Create temp directories for storage tests, clean up in `afterEach`

See [TEST_PATTERNS.md](./TEST_PATTERNS.md) for the full testing guide.

### Before opening a PR

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] You've reviewed your own diff

---

## Git Workflow

### Commit messages

```
Type: Short description

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

Types: `Fix`, `Feat`, `Refactor`, `Chore`, `Test`, `Docs`

### Branches

Use descriptive branch names: `yourname/short-description` or `fix/issue-description`.

---

## Security

This codebase sends telemetry to New Relic and can spawn child processes and proxy network requests. A few things to be aware of before your first contribution:

- **Redact before you log or send.** Any string that might contain secrets — error messages from upstream APIs, tool output, file content — must pass through `redact()` (agent) or `redactSensitive()` (MCP server) before it reaches a logger or NR event. The patterns cover API keys, tokens, PEM blocks, JWTs, and more.
- **Validate external strings at the boundary.** `accountId` is validated as 1–12 decimal digits at config load. Tool names are truncated and stripped of control characters. Any new field that goes into a URL path or NR event should get the same treatment.
- **Subprocess commands need absolute paths.** `StdioUpstream` rejects relative command names and strips dangerous dynamic-linker env vars (`LD_PRELOAD`, etc.) before spawning a child process.
- **HTTP upstream URLs are SSRF-checked.** `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts. Don't bypass this for convenience.
- **High security mode is absolute.** When `highSecurity=true`, `recordContent` is always `false`. This invariant must never be bypassed.

See [SECURITY.md](./SECURITY.md) for the full guidelines, code examples, and a code review checklist.

---

## Platform Setup

The MCP server automatically detects and supports multiple AI coding platforms:

| Platform | Setup | Notes |
|----------|-------|-------|
| **Claude Code** | Built-in | Default platform; install hook via `nr-ai-observe install` |
| **Cursor** | Env var: `NEW_RELIC_AI_PLATFORM=cursor` | Auto-detected if Cursor config present |
| **Windsurf** | Env var: `NEW_RELIC_AI_PLATFORM=windsurf` | Auto-detected if Windsurf config present |
| **GitHub Copilot** | Env var: `NEW_RELIC_AI_PLATFORM=copilot` | Requires manual hook setup |
| **Zed** | Env var: `NEW_RELIC_AI_PLATFORM=zed` | Auto-detected from Zed config directory |
| **Continue.dev** | Env var: `NEW_RELIC_AI_PLATFORM=continue` | Auto-detected from Continue config |
| **Amazon Q Developer** | Env var: `NEW_RELIC_AI_PLATFORM=amazonq` | Requires AWS IDE plugin setup |

Each platform normalizes tool calls into the shared `AiToolCall` event schema, so dashboards and tools work uniformly across all platforms.

## Deploying to New Relic

### Deploy dashboards

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --all
```

Add `--staging` if your account is on the New Relic staging environment. Deploys all seven pre-built dashboards (overview, security, platform comparison, team view, session detail, manager view, personal). Use `--print` to output JSON for manual import via the New Relic UI.

For a self-reflection dashboard pre-filtered to your identity, deploy the personal dashboard with `--developer <name>`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer <your-name>
```

To replace existing dashboards in place (preserves GUID and URL), add `--update`. The script looks up each dashboard by name and calls `dashboardUpdate`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --all --update
```

To remove all deployed dashboards:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --all --teardown
```

`--teardown` matches dashboards by name and calls `dashboardDelete`. Missing dashboards are skipped (no-op), so it's safe to re-run. Pair with a single filename to delete one dashboard, or use `--all` to delete every pre-built one. `--teardown` is mutually exclusive with `--update` and `--print`.

### Deploy alert conditions

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts
```

Add `--staging` if your account is on the New Relic staging environment. Deploys the "AI Coding Assistant Alerts" policy with five NRQL conditions. Use `--dry-run` to preview without hitting the API. Conditions 1–4 are enabled by default; condition 05 (session budget) is disabled and requires adjusting the threshold in `alerts/conditions/05-session-cost-budget.json`.

To sync conditions on an existing policy in place (preserves the policy's id and condition history; matches conditions by name to update them, creates new ones, and deletes any condition not present locally):

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts --update
```

`--update` only syncs conditions inside the policy. Renaming the policy or changing its `incidentPreference` still requires `--teardown` then redeploy. `--update` is mutually exclusive with `--dry-run` and `--teardown`. Combine with `--developer <name>` to update the personal policy.

To remove all deployed alert conditions:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts --teardown
```

For per-developer alerts scoped to one identity (lower personal thresholds, separate policy from the team one), pass `--developer <name>`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --developer <your-name>
```

This creates a separate policy `AI Coding — Personal — <name>` from the JSON files in `alerts/conditions-personal/`, with `developer = '<name>'` injected into every NRQL query. The flag is additive — running without it deploys only the team policy; running with it deploys only the personal policy. Use `--teardown` alongside `--developer` to remove just the personal policy.

Override the personal thresholds in `~/.nr-ai-observe/config.json`:

```json
{
  "alerts": {
    "personal": {
      "dailyCostUsd": 3,
      "sessionCostUsd": 0.75,
      "efficiencyScoreMin": 35,
      "stuckLoopCountMax": 3
    }
  }
}
```

Defaults are `dailyCostUsd: 2`, `sessionCostUsd: 0.50`, `efficiencyScoreMin: 40`, `stuckLoopCountMax: 2`.

### Backfilling session history

If you have existing NR telemetry but no local session files (e.g. because you updated from a version that didn't persist sessions at shutdown), run the backfill script to seed your local history so `nr_observe_get_personal_insights` and the weekly summary tools have data:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/backfill-sessions.ts \
  --developer <your-name> [--days 90] [--dry-run] [--staging]
```

The script queries NR for your past sessions, reconstructs session summaries, writes them to `~/.nr-ai-observe/sessions/`, and regenerates weekly summaries. Sessions already present locally are skipped. Run `--dry-run` first to see what would be written.

---

## Where to Go for Help

- **[CLAUDE.md](../CLAUDE.md)** — The full technical reference for this repo. Architecture, conventions, every pattern in detail. This is your cheat sheet once you're up to speed.
- **[SECURITY.md](./SECURITY.md)** — Security practices, invariants, and a code review checklist. Read this before your first PR that touches config loading, network requests, subprocess execution, or telemetry fields.
- **[TEST_PATTERNS.md](./TEST_PATTERNS.md)** — Testing conventions, factory patterns, mock strategies. Read this before writing your first test.
- **The code itself** — The best examples of our patterns are in `src/metrics/` (tracker pattern), `src/shared/harvest/` (scheduler/buffer pattern), and the test files alongside them.

Welcome to the project!

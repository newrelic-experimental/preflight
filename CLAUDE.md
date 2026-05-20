# NR AI Observatory

An npm workspaces monorepo providing observability for AI coding assistants. Two active packages: `@nr-ai-observatory/shared` (transport, events, pricing — source committed in `packages/shared/src/`; run `node scripts/sync-shared.js` to pull upstream changes from `nr-ai-typescript-shared`) and `nr-ai-mcp-server` (MCP server + metrics engine + HTTP proxy). All telemetry flows to New Relic. The TypeScript SDK agent lives in the separate `nr-ai-typescript-agent` repo. CI/CD tooling and GitHub App webhook server live in the separate `nr-ai-github-tools` repo.

## Development Commands

```bash
npm run build              # TypeScript build (all packages via project references)
npm run build:clean        # Clean build output
npm test                   # Run all tests (Jest, maxWorkers: 1)
npm run lint               # ESLint across all packages
npm run format             # Prettier (write)
npm run format:check       # Prettier (check only)
```

Build a single package:

```bash
npx tsc -b packages/shared && npx tsc -b packages/nr-ai-mcp-server
```

To pull in upstream changes from `nr-ai-typescript-shared` first: `node scripts/sync-shared.js` (then commit the result).

Run tests for a single file:

```bash
npx jest -- src/metrics/cost-tracker.test.ts
npx jest -- packages/shared/src/harvest/harvest-scheduler.test.ts
```

## Project Structure

```
nr-ai-observatory/
  packages/
    shared/                             # @nr-ai-observatory/shared
      src/
        config.ts                       # AgentConfig loader (env > file > defaults)
        logger.ts                       # createLogger() — stderr JSON logger
        pricing.ts / pricing-data.ts    # Token pricing tables (Anthropic, Gemini)
        tokens.ts                       # Token extraction/accumulation
        timing.ts                       # RequestTimer for latency measurement
        errors.ts                       # Error classification, retry logic
        events/                         # NR event creation and serialization
        harvest/                        # EventBuffer, MetricAggregator, HarvestScheduler
        transport/                      # HTTP clients for Events, Metric, and Logs APIs; OtlpTransport and OtlpEventBridge for OTLP/HTTP export

    nr-ai-agent/ and test-app/          # *(now in `nr-ai-typescript-agent` repo)*

    nr-ai-mcp-server/                   # nr-ai-mcp-server
      src/
        index.ts                        # CLI entry point (parseArgs, stdio vs proxy mode)
        server.ts                       # NrMcpServer — MCP server over stdio transport
        config.ts                       # McpServerConfig loader
        hooks/
          collector-script.ts           # nr-ai-observe binary (hook event collector)
          event-processor.ts            # Pairs pre/post hook events into ToolCallRecords
          tool-parsers.ts               # INPUT_PARSERS / OUTPUT_PARSERS for tool fields
        metrics/                        # 18 analyzer classes
          session-tracker.ts            # Per-session tool call tracking
          cost-tracker.ts               # Token cost calculation (per-model)
          task-detector.ts              # Task boundary detection
          anti-patterns.ts              # Thrashing, re-reads, blind edits, stuck loops
          efficiency-score.ts           # Composite efficiency score
          trend-analyzer.ts             # Weekly trend analysis
          collaboration-profile.ts      # Developer collaboration patterns
          claudemd-tracker.ts           # CLAUDE.md change impact tracking
          cost-per-outcome.ts           # Cost breakdown by outcome type
          prompt-feedback.ts            # Feedback collection engine
          recommendation-engine.ts      # Personalized optimization recommendations
          proxy-metrics.ts              # Proxy mode server latency and tool popularity tracking
          budget-tracker.ts             # Session/daily/weekly budget monitoring
          context-window-tracker.ts     # Context waste detection (repeated file reads)
          latency-tracker.ts            # Tool call latency percentiles (p50/p95/p99)
          task-completion-tracker.ts    # Task lifecycle tracking (completed/abandoned)
          model-usage-tracker.ts        # Cost-efficiency per AI model
          personal-coach.ts             # Narrative coaching report comparing weekly metrics to personal baseline
        platforms/                      # 7 platform adapters
          claude-code-adapter.ts        # Claude Code (default)
          cursor-adapter.ts             # Cursor IDE
          windsurf-adapter.ts           # Windsurf IDE
          copilot-adapter.ts            # GitHub Copilot
          zed-adapter.ts                # Zed IDE
          continue-adapter.ts           # Continue.dev
          amazon-q-adapter.ts           # Amazon Q Developer
          platform-registry.ts          # Registry + factory
        proxy/                          # HTTP proxy layer
          proxy-manager.ts              # HTTP server, routing, interception
          upstream-http.ts              # HTTP upstream transport
          upstream-stdio.ts             # Stdio upstream transport (child process)
        storage/                        # Local file persistence
          local-store.ts                # JSONL buffer file + atomic drain
          session-store.ts              # Session history (YYYY-MM-DD_sessionId.json)
          weekly-summary.ts             # Cross-session weekly aggregation
          retention.ts                  # purgeOldSessions() — delete sessions older than N days
        digest/                         # Weekly digest formatting and delivery
          digest-formatter.ts           # formatSlackDigest() — Slack Block Kit payload builder
          digest-sender.ts              # sendSlackDigest() — HTTP POST to Slack webhook
        security/
          audit-trail.ts                # Security audit trail (sensitive files, destructive commands)
        tools/                          # MCP tool handlers
          session-stats.ts              # registerTools() + session stat tools
          cost-tools.ts                 # Cost analysis tools
          workflow-tools.ts             # Workflow analysis + feedback tools
          cross-session-tools.ts        # Cross-session analysis tools
        tracing/                        # OTel span management for MCP tool call tracing
          mcp-tracer.ts               # getMcpTracer() / initMcpTracer() — tracer singleton
          session-span.ts             # SessionSpan — root span lifecycle (start at startup, end at shutdown)
          tool-call-span.ts           # emitToolCallSpan() — one child span per ToolCallRecord
          task-span-tracker.ts        # TaskSpanTracker — intermediate task span lifecycle
        transport/
          nr-ingest.ts                  # NrIngestManager (events + metrics + logs)
          log-ingest.ts                 # Log ingestion with buffering
        install/                        # Claude Code hook installation CLI
          cli.ts                        # nr-ai-observe install/uninstall commands
          setup-wizard.ts               # nr-ai-observe setup interactive wizard
        alerts/                         # Alert TypeScript types + validation tests
          types.ts                      # AlertConditionDefinition, AlertPolicyDefinition interfaces
          alerts.test.ts                # JSON structure validation (reads from ../alerts/)
      alerts/                           # Alert policy and condition JSON definitions (data, not source)
        policy.json                     # Policy metadata (name, incident preference)
        conditions/                     # NRQL alert condition JSON files
      dashboards/                       # Pre-built NR dashboard JSON files (data, not source)
      scripts/                          # Deploy scripts (deploy-dashboard.ts, deploy-alerts.ts)
```

## Architecture

### Data Flow (MCP Server — Stdio Mode)

```
Claude Code
  │
  ├─ PreToolUse / PostToolUse hooks
  │    └─> nr-ai-observe (collector-script.ts)
  │         └─> writes to buffer.jsonl (LocalStore)
  │
  └─ MCP stdio connection
       └─> NrMcpServer (server.ts)
            ├─ HookEventProcessor reads buffer.jsonl on poll interval
            │    └─> pairs pre/post → ToolCallRecord
            │         └─> feeds to all metric trackers:
            │              SessionTracker, CostTracker, TaskDetector,
            │              AntiPatternDetector, AuditTrailManager
            │
            ├─ NrIngestManager (HarvestScheduler)
            │    ├─ Events → NR Events API (every 5s)
            │    └─ Metrics → NR Metric API (every 60s)
            │
            └─ MCP Tools (queried by Claude Code)
                 ├─ nr_observe_get_session_stats
                 ├─ nr_observe_get_efficiency_score
                 ├─ nr_observe_get_cost_breakdown
                 ├─ nr_observe_get_anti_patterns
                 ├─ nr_observe_get_recommendations
                 └─ ... (16 tools total)
```

### Package Dependencies

- `shared` has zero runtime dependencies (pure TypeScript)
- `nr-ai-mcp-server` depends on `shared`, `@modelcontextprotocol/sdk`, `zod`, `commander`

## TypeScript Conventions

### Module System
- ESM throughout (`"type": "module"` in all package.json files)
- `NodeNext` module resolution
- All internal imports use `.js` extensions (required for ESM)
- Strict mode enabled

### Type Patterns
- `interface` for public API contracts and tracker return types
- `type` for unions, intersections, and local aliases
- `readonly` on all interface fields for immutable data shapes
- `Record<string, T>` for dynamic key maps (tool breakdowns, exit code maps)

### Naming
- Files: `kebab-case.ts` (e.g., `session-tracker.ts`, `cost-tracker.test.ts`)
- Classes: `PascalCase` (e.g., `SessionTracker`, `HookEventProcessor`)
- Interfaces: `PascalCase` (e.g., `McpServerConfig`, `FullSessionSummary`)
- Functions: `camelCase` (e.g., `buildSessionSummary`, `parseToolSpecificFields`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `DEFAULT_HARVEST_MS`, `TRACKED_METHODS`)
- Test helpers: `camelCase` with `make` prefix (e.g., `makeRecord`, `makeSummary`, `makeManager`)

### Import Order
1. Node.js builtins (`node:fs`, `node:path`, `node:crypto`)
2. External packages (`@modelcontextprotocol/sdk`, `zod`, `commander`)
3. Blank line
4. Internal package imports (`@nr-ai-observatory/shared`)
5. Local imports (`./types.js`, `../metrics/session-tracker.js`)

### Logger Pattern
Every module creates a scoped logger at module level:
```typescript
import { createLogger } from '@nr-ai-observatory/shared';
const logger = createLogger('module-name');
```
Logger writes to stderr as JSON. Never write to stdout (reserved for MCP stdio transport).

## Metric Tracker Pattern

All 12 metric trackers in `src/metrics/` follow the same shape:

```typescript
class XxxTracker {
  constructor(options?: XxxOptions);
  recordToolCall(record: ToolCallRecord): void;  // or similar input method
  getMetrics(): XxxMetrics;                       // returns current state
  reset(sessionId: string): void;                 // clears state for new session
}
```

Each tracker:
- Receives `ToolCallRecord` objects from the event processor
- Maintains internal state (maps, counters, arrays)
- Exposes a `getMetrics()` method returning a typed snapshot
- Has a corresponding `*.test.ts` file with factory helpers

## MCP Tool Registration

Tools are registered in `src/tools/session-stats.ts` via `registerTools()`, which receives all tracker instances and calls `server.tool()` for each MCP tool. Each tool handler:
1. Reads current state from the relevant tracker(s) via `getMetrics()`
2. Formats the result as a text content block
3. Returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`

Tools are conditionally registered based on available dependencies (e.g., cross-session tools only register when `SessionStore` + `WeeklySummaryGenerator` are available).

### MCP Tools (16 total)

**Session Tools:**
- `nr_observe_get_session_stats` — current session metrics
- `nr_observe_get_session_timeline` — recent tool calls with timestamps
- `nr_observe_get_efficiency_score` — composite efficiency scoring

**Cost and Budget Tools:**
- `nr_observe_get_cost_breakdown` — cost by tool type and model
- `nr_observe_get_cost_forecast` — project future spend
- `nr_observe_get_budget_status` — current spend vs. budget caps

**Workflow and Anti-Pattern Tools:**
- `nr_observe_get_anti_patterns` — detected thrashing, re-reads, blind edits, stuck loops
- `nr_observe_get_workflow_trace` — ordered sequence of recent tool calls

**Analytics Tools:**
- `nr_observe_get_context_efficiency` — context window waste (repeated reads)
- `nr_observe_get_latency_percentiles` — p50/p95/p99 per tool type
- `nr_observe_get_task_completion_rate` — task lifecycle (completed vs. abandoned)
- `nr_observe_get_model_usage` — cost-efficiency per AI model

**Cross-Session Tools (require SessionStore + WeeklySummaryGenerator):**
- `nr_observe_get_weekly_summary` — aggregated metrics across the week
- `nr_observe_get_trends` — weekly metric trends (efficiency, cost, task success)
- `nr_observe_get_team_summary` — team-level aggregations
- `nr_observe_get_collaboration_profile` — developer working style classification
- `nr_observe_get_claudemd_impact` — CLAUDE.md change impact analysis
- `nr_observe_get_cost_per_outcome` — cost breakdown by task outcome type
- `nr_observe_get_recommendations` — personalized optimization recommendations
- `nr_observe_get_personal_insights` — narrative coaching report vs. personal weekly baseline
- `nr_observe_get_platform_comparison` — side-by-side platform metrics

**Digest and Subscription Tools:**
- `nr_observe_subscribe_digest` — register webhook for weekly summaries
- `nr_observe_unsubscribe_digest` — disable digest delivery
- `nr_observe_send_digest` — generate and POST the current week's digest immediately

See [COMMANDS_TABLE.md](./docs/COMMANDS_TABLE.md) for complete tool specifications.

## Configuration

Config loading priority: **CLI > environment variables > config file > defaults**.

The config file path defaults to `~/.nr-ai-observe/config.json` or can be passed via `--config`.

Key config interfaces:
- `McpServerConfig` in `nr-ai-mcp-server/src/config.ts`
- `AgentConfig` in `shared/src/config.ts`

### New Configuration Fields (Phases 6–10)

| Field | Env Var | Type | Purpose |
|-------|---------|------|---------|
| `developer` | `NEW_RELIC_AI_MCP_DEVELOPER` | string | Developer identifier on all NR events. Normalised to lowercase with underscores via `normalizeDeveloperName()`. Falls back to `$USER` → `$USERNAME` → `git config user.name` → `'unknown'` when unset. |
| `sessionBudgetUsd` | `NEW_RELIC_AI_SESSION_BUDGET_USD` | number | Session spend limit (USD) |
| `dailyBudgetUsd` | `NEW_RELIC_AI_DAILY_BUDGET_USD` | number | Daily spend limit (USD) |
| `weeklyBudgetUsd` | `NEW_RELIC_AI_WEEKLY_BUDGET_USD` | number | Weekly spend limit (USD) |
| `teamId` | `NEW_RELIC_AI_TEAM_ID` | string | Team identifier for aggregation |
| `projectId` | `NEW_RELIC_AI_PROJECT_ID` | string | Project identifier (auto-derived from git) |
| `orgId` | `NEW_RELIC_AI_ORG_ID` | string | Organization identifier |
| `nrApiKey` | `NEW_RELIC_API_KEY` | string | User API key (NRAK-...) for team summary NerdGraph queries |
| `digestWebhookUrl` | `NEW_RELIC_AI_DIGEST_WEBHOOK_URL` | string | Slack/HTTP webhook for weekly digest |
| `digestSchedule` | `NEW_RELIC_AI_DIGEST_SCHEDULE` | string | Cron expression for digest delivery |
| `retainSessionsDays` | `NEW_RELIC_AI_RETAIN_SESSIONS_DAYS` | number | Auto-purge sessions older than N days |
| `otlpEndpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | string \| null | OTLP/HTTP endpoint URL (e.g. `https://otlp.nr-data.net` for NR US). When set, enables OTLP export. |
| `otlpHeaders` | `OTEL_EXPORTER_OTLP_HEADERS` | Record\<string, string\> | Auth headers for OTLP endpoint. Env var uses comma-separated `key=value` pairs. |
| `transport` | `NEW_RELIC_AI_TRANSPORT` | `'nr-events-api' \| 'otlp' \| 'both'` | `nr-events-api` (default): NR APIs only. `otlp`: OTLP only. `both`: concurrent. |

### New Event Types

| Event Type | Emitted By | Use Case |
|-----------|-----------|----------|
| `AiBudgetWarning` | `BudgetTracker` | Budget threshold crossed (50%, 80%, 100%) |

### Enhanced Events

All MCP server events (`AiToolCall`, `AiCodingTask`, `AiAntiPattern`, `AiMcpToolCall`, `AiProxyRequest`, `AiAuditEvent`) now include team attribution fields:
- `team_id` — team identifier (from config)
- `project_id` — project identifier (auto-derived or configured)
- `org_id` — organization identifier (from config)

### Phase 4 SDK Agent Events

*(Emitted by `nr-ai-agent`, now in the `nr-ai-typescript-agent` repo.)*

Emitted by `nr-ai-agent` from the intelligence modules (Phases 4.1–4.7):

| Event Type | Emitted By | Cadence | Use Case |
|-----------|-----------|---------|----------|
| `AiCostGrowthAlert` | `CostForecaster` | On threshold | Monthly cost growth rate exceeded configured threshold |
| `AiCostForecastAlert` | `CostForecaster` | On threshold | Projected monthly cost exceeds configured budget |
| `AiExperimentSummary` | `ExperimentTracker` | Every 6 hours | Per-experiment results snapshot with per-variant stats |
| `AiExperimentConclusion` | `ExperimentTracker` | On conclusion | Winner declared or end date reached — fires once per experiment |
| `AiRecommendation` | `RecommendationEngine` | Every 5 minutes | Automated optimization recommendations (cache, model, context) |

### Provider Support

*(Now in the `nr-ai-typescript-agent` repo.)*

SDK agent wrappers now support 6 AI providers:
- `anthropic` — Anthropic Claude models
- `google` — Google Gemini models
- `openai` — OpenAI GPT/o1/o3 models
- `bedrock` — AWS Bedrock models
- `mistral` — Mistral AI models
- `cohere` — Cohere models

## Storage

All local persistence lives under `~/.nr-ai-observe/` by default:

| Path | Format | Purpose |
|------|--------|---------|
| `buffer.jsonl` | JSONL | Hook event buffer (written by collector, drained by processor) |
| `sessions/` | JSON files | Session summaries (`YYYY-MM-DD_sessionId.json`) |
| `weekly_summaries/` | JSON files | Cross-session weekly aggregations |

`LocalStore` handles atomic buffer operations (append, drain with rename-then-read pattern).

## Harvest and Ingestion

`HarvestScheduler` (in `shared`) manages periodic flush of events and metrics to New Relic:
- Events flush every 5 seconds (configurable)
- Metrics flush every 60 seconds (configurable)
- Failed batches are re-queued with bounded retry buffers
- `stop()` is idempotent — concurrent callers await the same flush promise

`NrIngestManager` (in `nr-ai-mcp-server`) wraps `HarvestScheduler` and adds log ingestion.

## Security

See [SECURITY.md](./docs/SECURITY.md) for the full guidelines, invariants, and code review checklist. Key points:

- **Redaction** — `DEFAULT_REDACTION_PATTERNS` in `nr-ai-mcp-server/src/config.ts` covers API keys, Bearer tokens, AWS/Google/npm/Slack secrets, JWTs, and PEM blocks. Apply `redact()` / `redactSensitive()` before any string reaches a log or NR event field.
- **Input validation** — `accountId` is validated as `/^\d{1,12}$/` at config load. `envInt` callers supply `{ min, max }` bounds. Tool names are truncated to 256 chars with control chars stripped.
- **SSRF protection** — `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts before connecting.
- **Process safety** — `StdioUpstream` requires an absolute command path and strips `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, and related keys from the child env.
- **Storage permissions** — Directories created with `0o700`, files with `0o600`.
- **High security mode** — `highSecurity=true` forces `recordContent=false`; this must never be bypassed.
- **Audit trail** — `AuditTrailManager` classifies every tool call (sensitive file access, destructive commands, external network requests) and persists records to disk in real time.

## Linting

The codebase targets **0 ESLint errors and 0 warnings**. Do not introduce new lint issues when writing or modifying code:

- Never add `eslint-disable` comments to suppress warnings — fix the underlying issue instead
- Never use `as any` — use `as unknown as T` for forced type coercions, or define a typed mock interface
- Never use `: any` as a type annotation — use a concrete type, `unknown`, or a generic
- For jest mock args, use `unknown[]` instead of `any[]` (e.g. `jest.fn<Promise<T>, unknown[]>()`)
- For unused required parameters, prefix with `_` (e.g. `_config`) — configured in `eslint.config.mjs`

Run `npm run lint` before committing to verify the lint target is still met.

## Testing Conventions

- Co-located test files: `foo.ts` → `foo.test.ts` (same directory)
- Jest with `ts-jest/presets/default-esm` preset, `node` environment
- `maxWorkers: 1` to avoid stdio deadlocks
- Tests mock `process.stderr.write` to suppress logger output
- Factory helpers (`makeRecord`, `makeSummary`, etc.) use optional `Partial<T>` overrides
- Fake timers (`jest.useFakeTimers()`) for harvest scheduler and poll interval tests
- Temp directories via `os.tmpdir()` + cleanup in `afterEach` for storage tests
- See [TEST_PATTERNS.md](./docs/TEST_PATTERNS.md) for full conventions

## Git Commit Conventions

- Format: `Type: Short description` (e.g., `Fix #13: Re-queue events on send failure`)
- Types: `Fix`, `Feat`, `Refactor`, `Chore`, `Test`, `Docs`
- Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` when AI-assisted
- One logical change per commit

## Pull Requests

- Title: short, under 72 characters
- Body: Summary (bullet points), Test plan (checklist)
- Always run `npm run build && npm test` before opening

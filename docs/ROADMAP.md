# NR AI Observatory — Roadmap

This document tracks planned features and improvements. Each section links to a detailed implementation plan in `docs/roadmap/`. Items are roughly sequenced by impact-to-effort ratio, but the order is not strict.

---

## Table of Contents

1. [Session Trace ID](#1-session-trace-id)
2. [Session ID Dashboard Updates](#2-session-id-dashboard-updates)
3. [Alert Conditions](#3-alert-conditions)
4. [OpenAI SDK Wrapper](#4-openai-sdk-wrapper)
5. [CI/CD Integration](#5-cicd-integration)
6. [Cost Budgets and Forecasting](#6-cost-budgets-and-forecasting)
7. [Additional Platform Adapters](#7-additional-platform-adapters)
8. [New Metric Trackers](#8-new-metric-trackers)
9. [Team and Org Analytics](#9-team-and-org-analytics)
10. [Developer Experience Improvements](#10-developer-experience-improvements)
11. [Additional SDK Wrappers](#11-additional-sdk-wrappers)
12. [✅ Developer Identity as Explicit Config](#12-developer-identity-as-explicit-config)
13. [✅ Personal Developer Dashboard](#13-personal-developer-dashboard)
14. [✅ Developer-Scoped Alert Deployments](#14-developer-scoped-alert-deployments)
15. [✅ Personal Coaching MCP Tool](#15-personal-coaching-mcp-tool)
16. [✅ GitHub App Integration](#16-github-app-integration)
17. [✅ GenAI Semantic Convention Mapping](#17-genai-semantic-convention-mapping)
18. [OTLP Transport Option](#18-otlp-transport-option)
19. [OTel Spans in SDK Wrappers](#19-otel-spans-in-sdk-wrappers)
20. [MCP Tool Call Tracing](#20-mcp-tool-call-tracing)
21. [OTLP Input in Proxy Mode](#21-otlp-input-in-proxy-mode)

---

## ✅ 1. Session Trace ID

**Status:** Done

Generate a UUID at server startup and thread it through every NR event, metric data point, and log entry emitted during that session. This makes every signal for a given session joinable in NRQL via a single `session_id` attribute — enabling per-session deep analysis, cost attribution, and timeline reconstruction without relying on approximate time windows.

**Scope:**
- Generate `sessionTraceId = randomUUID()` in `index.ts` at startup
- Pass `sessionTraceId` into `NrIngestManager` constructor; stored as `this.sessionTraceId`
- Add `session_id` attribute to every `AiToolCall`, `AiCodingTask`, and `AiAntiPattern` NR event in `toolCallToNrEvent()` / `aiCodingTaskToNrEvent()` / `antiPatternToNrEvent()`
- Add `session_id` as a common metric attribute on all `Gauge` data points emitted by `NrIngestManager`
- Expose `sessionTraceId` via `nr_observe_get_session_stats` MCP tool response
- Tests asserting `session_id` is present on all emitted event and metric types

---

## ✅ 2. Session ID Dashboard Updates

**Status:** Done

Update all 4 existing dashboards to include a `session_id` template variable that optionally scopes every widget to a single session. Create a new dedicated session detail dashboard with per-session timeline, task, file, and anti-pattern widgets for post-session analysis.

**Scope:**
- Add `session_id` NR template variable to all 4 existing dashboard JSON files
- Inject `WHERE session_id = '{{session_id}}'` into every event-type NRQL query in those dashboards
- Create `ai-coding-assistant-session-detail.json` with 2 pages and 12 widgets
- Verify deploy script handles the new file without changes

---

## ✅ 3. Alert Conditions

**Status:** Done

Ship pre-built New Relic alert policies alongside the dashboards. One command deploys a complete set of NRQL alert conditions covering cost spikes, low efficiency, anti-pattern frequency, and session budget overruns. Mirrors the dashboard deploy UX.

**Scope:**
- CLI command `nr-ai-mcp-server alerts deploy`
- Five initial alert conditions (cost spike, low efficiency, stuck loop rate, anti-pattern rate, budget exceeded)
- JSON policy/condition definitions stored in `src/alerts/`
- NerdGraph mutations to create policies and conditions
- Dry-run mode, idempotent upsert, teardown command

---

## ✅ 4. OpenAI SDK Wrapper

**Status:** Done

Add an OpenAI SDK wrapper to `nr-ai-agent` matching the shape of the existing Anthropic and Gemini wrappers. Covers `chat.completions.create` (streaming and non-streaming), pricing tables for GPT-4o / o1 / o3 family, and token extraction from OpenAI response shapes.

**Scope:**
- `packages/nr-ai-agent/src/wrappers/openai.ts`
- Pricing data for all current OpenAI models
- Streaming support (SSE delta accumulation)
- Tests mirroring `anthropic.ts` test coverage
- `nr-ai-agent` peer dependency on `openai` package

---

## ✅ 5. CI/CD Integration

**Status:** Done

A GitHub Actions composite action (and matching GitLab CI job template) that reads session telemetry from the current branch, computes cost and efficiency deltas, and posts a structured comment on the pull request. Brings AI coding observability into code review.

**Scope:**
- `packages/nr-ai-cicd/` new package
- `nr-ai-report` CLI binary (reads NR NRQL, formats markdown)
- GitHub Actions composite action (`actions/report/action.yml`)
- GitLab CI job template (`.gitlab-ci-template.yml`)
- PR comment format: cost delta, efficiency score, top anti-patterns, model breakdown
- Threshold-based pass/fail status check (configurable)

---

## ✅ 6. Cost Budgets and Forecasting

**Status:** Done

Config-level budget caps (`dailyBudgetUsd`, `sessionBudgetUsd`, `weeklyBudgetUsd`) that emit warnings when thresholds are approached. A new `nr_observe_get_cost_forecast` MCP tool that extrapolates spend from the current session and weekly trend. Budget state surfaces in the efficiency score and anti-pattern reports.

**Scope:**
- Budget fields in `McpServerConfig`
- `BudgetTracker` class in `src/metrics/`
- `nr_observe_get_budget_status` and `nr_observe_get_cost_forecast` MCP tools
- Warning events emitted to NR when budget thresholds crossed (50%, 80%, 100%)
- Budget state included in session stats and weekly summary

---

## ✅ 7. Additional Platform Adapters

**Status:** Done

Add adapters for Zed, Continue.dev, and Amazon Q Developer to match the existing Claude Code / Cursor / Windsurf / Copilot coverage. Each adapter normalizes platform-specific hook or event formats into the shared `ToolCallRecord` shape.

**Scope:**
- `packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts`
- `packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts`
- `packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts`
- Platform detection heuristics for each (env vars, config file presence)
- Tests for each adapter
- Platform registry updates

---

## ✅ 8. New Metric Trackers

**Status:** Done

Four new tracker classes following the established metric tracker pattern:

- **ContextWindowTracker** — measures what fraction of the context window is productive signal vs. repeated content (boilerplate, repeated reads)
- **LatencyTracker** — p50/p95/p99 latency per tool type and per session
- **TaskCompletionTracker** — tracks task lifecycle (detected → in-progress → completed vs. abandoned)
- **ModelUsageTracker** — records which model was used per request and computes cost-efficiency ratios across models

**Scope:**
- Four new tracker files + corresponding test files
- MCP tools for each tracker (`nr_observe_get_context_efficiency`, `nr_observe_get_latency_percentiles`, `nr_observe_get_task_completion_rate`, `nr_observe_get_model_usage`)
- Integration into `registerTools()` and `NrMcpServer`
- NR metric/event emission for each

---

## ✅ 9. Team and Org Analytics

**Status:** Done

Lift the single-developer model to support team-level aggregation. Telemetry is tagged with a `teamId` and `projectId` derived from git remote URL and config. A separate read-only "manager dashboard" shows cost allocation by developer, project, and sprint without exposing tool-call content.

**Scope:**
- `teamId` and `projectId` dimensions added to all NR events/metrics
- Git remote URL → project slug extraction utility
- Manager dashboard JSON (cost + efficiency only, no content)
- Developer dashboard retains full detail
- `nr_observe_get_team_summary` MCP tool (aggregates across developers' NR data via NRQL)
- Config fields: `teamId`, `projectId`, `orgId`

---

## ✅ 10. Developer Experience Improvements

**Status:** Done

Three distinct DX improvements:

- **Setup wizard** — `npx nr-ai-mcp-server setup` interactive CLI that walks through NR account ID, API key, hook install, and first dashboard deploy
- **Weekly digest** — `nr_observe_subscribe_digest` MCP tool registers a Slack webhook or email address for a weekly cost + efficiency summary
- **Data retention** — `retainSessionsDays` config field with automatic purge of old session files; GDPR-friendly data minimization

**Scope:**
- `packages/nr-ai-mcp-server/src/install/setup-wizard.ts` (interactive prompts via `readline`)
- `packages/nr-ai-mcp-server/src/digest/` digest scheduler and formatter
- `packages/nr-ai-mcp-server/src/storage/retention.ts` purge logic
- `nr_observe_subscribe_digest` and `nr_observe_unsubscribe_digest` MCP tools
- Config fields: `retainSessionsDays`, `digestWebhookUrl`, `digestSchedule`

---

## ✅ 11. Additional SDK Wrappers

**Status:** Done

Extend `nr-ai-agent` with wrappers for AWS Bedrock (native SDK), Mistral, and Cohere to cover the remaining major enterprise AI providers.

**Scope:**
- `packages/nr-ai-agent/src/wrappers/bedrock.ts` — `@aws-sdk/client-bedrock-runtime` `InvokeModelCommand` + `InvokeModelWithResponseStreamCommand`
- `packages/nr-ai-agent/src/wrappers/mistral.ts` — `@mistralai/mistralai` `chat.complete` / `chat.stream`
- `packages/nr-ai-agent/src/wrappers/cohere.ts` — `cohere-ai` `chat` / `chatStream`
- Pricing data for all three providers
- Tests for each wrapper
- Peer dependencies added to `nr-ai-agent/package.json`

---

## ✅ 12. Developer Identity as Explicit Config

**Status:** Done

Make `developer` a first-class configured identity rather than a value inferred from `$USER` or git config. The setup wizard confirms or sets it once; every subsequent NR event, metric, and log carries that value reliably. This is the prerequisite for items 13–15 — without an explicit, stable identity, per-developer dashboards and alerts split silently when a user switches machines, renames their OS user, or works in a containerized environment.

**Scope:**
- `normalizeDeveloperName()` in `packages/nr-ai-mcp-server/src/config.ts` — lowercase, collapse non-alphanumeric (except `-`) to `_`, strip leading/trailing `_`, truncate to 64 chars, fall back to `'unknown'`
- `loadMcpConfig()` uses `normalizeDeveloperName` for the resolved `developer` field; env var `NEW_RELIC_AI_MCP_DEVELOPER` > config file > inferred (`$USER` / `$USERNAME` / `git config user.name` / `'unknown'`)
- Setup wizard (`setup-wizard.ts`) prompts for the developer name, persists it in normalised form, and prints the normalised value back when it differs from the raw input
- `nr_observe_get_session_stats` response includes an `identity` block with `developer` / `teamId` / `projectId` so callers can verify the resolved identity at runtime
- `ServerOptions` (`types.ts`) carries `developer`/`teamId`/`projectId` end-to-end for library consumers
- Comprehensive `normalizeDeveloperName` test suite in `config.test.ts`
- `NEW_RELIC_AI_MCP_DEVELOPER` documented in `docs/ONBOARDING.md`

---

## ✅ 13. Personal Developer Dashboard

**Status:** Done

A new dashboard JSON file designed for individual self-reflection rather than team oversight. Pre-filtered to the configured developer identity, it surfaces personal efficiency trends, personal anti-pattern history, model cost breakdown over 30 days, and a "best session" highlight. Unlike the existing overview dashboard (which uses `{{developer}}` as an optional filter), this dashboard treats the developer as the fixed subject and optimises every widget for personal insight rather than comparison.

**Scope:**
- New file `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-personal.json`
- Page 1 — **My Trends**: 30-day cost sparkline, efficiency score trend, tool call volume over time, model mix pie
- Page 2 — **My Patterns**: top anti-patterns (personal frequency vs. personal average), most-read files, re-read rate, task completion rate
- Page 3 — **My Best Sessions**: top-5 highest-efficiency sessions (linked via `session_id`), average cost per completed task, "personal record" efficiency score callout
- All queries hard-scoped with a `developer` template variable defaulting to `{{developer_identity}}` (populated from config at deploy time via a new `--developer` flag on `deploy-dashboard`)
- Update `deploy-dashboard.ts` to accept `--developer <name>` and substitute the default value into the deployed dashboard JSON
- Verified by deploying against a real account and checking all widgets render without empty-state errors

---

## ✅ 14. Developer-Scoped Alert Deployments

**Status:** Done

Extend the alert deploy CLI with a `--developer <name>` mode that deploys a personal alert policy alongside (not instead of) any team-wide policy. Each condition injects `AND developer = '<name>'` into its NRQL and uses individually appropriate thresholds — a personal daily cost spike at $2 is meaningful where a team threshold of $50 would never fire for one person. Personal thresholds are configurable via a `alerts.personal` config section so developers can tune them without touching the shared alert definitions.

**Scope:**
- New CLI flag: `deploy-alerts --developer <name>` (reads configured developer identity if `<name>` omitted)
- New conditions JSON directory `src/alerts/conditions-personal/` with five personal variants of the existing conditions, each with tighter default thresholds and a `WHERE developer = '{{developer}}'` clause
- `deploy-alerts.ts` substitutes the developer name into condition NRQL and policy name (`AI Coding — Personal — <name>`) at deploy time
- New config section `alerts.personal`: `dailyCostUsd` (default `2`), `sessionCostUsd` (default `0.50`), `efficiencyScoreMin` (default `40`), `antiPatternRateMax` (default `0.15`)
- Idempotent upsert and teardown parity with existing deploy logic
- `--developer` flag is additive — running without it deploys team policy; running with it deploys the personal policy; running both is valid
- Tests for NRQL substitution and threshold override logic

---

## ✅ 15. Personal Coaching MCP Tool

**Status:** Done

A new MCP tool `nr_observe_get_personal_insights` that produces a narrative coaching report comparing the developer's current week against their own historical baseline. Rather than raw metrics, it surfaces actionable observations: "you re-read files 40% more than your average this week," "your highest-efficiency sessions all start with a Read tool call before any Edit," "Tuesday afternoons are consistently your lowest-efficiency period." The tool extends the existing `RecommendationEngine` and `TrendAnalyzer` but outputs prose coaching text keyed to personal patterns rather than generic best-practice advice. Degrades gracefully when fewer than two weeks of data exist.

**Scope:**
- New MCP tool `nr_observe_get_personal_insights` registered in `src/tools/cross-session-tools.ts`
- `PersonalCoach` class in `src/metrics/personal-coach.ts` accepting `SessionStore` + `WeeklySummaryGenerator`
- Analysis dimensions: re-read rate vs. personal mean, efficiency score trend, anti-pattern frequency vs. personal baseline, cost-per-task trend, time-of-day efficiency pattern (derived from session `startTime`)
- Output: a `PersonalInsightsReport` interface with `highlights` (string[]), `regressions` (string[]), `streaks` (string[]), and `topRecommendation` (string)
- Sparse-data guard: returns a `{ status: 'insufficient_data', weeksAvailable: N, weeksRequired: 2 }` shape when history is thin
- Narrative generation from structured data (template strings over the computed deltas — no LLM call required)
- Tests with mock session histories covering improvement, regression, and sparse-data cases

---

## ✅ 16. GitHub App Integration

**Status:** Done

A GitHub App that posts AI coding cost and efficiency reports directly on pull requests, without requiring GitHub Actions. Useful when Actions are disabled on an Enterprise account. The app runs as a small webhook server (deployable anywhere — Vercel, Railway, any Node host) that listens for `pull_request` events, fetches metrics from New Relic using the existing `nr-ai-cicd` library, and posts the formatted report as a PR comment via the GitHub API.

**Scope:**
- `packages/nr-ai-github-app/` new package with `nr-ai-github-app` binary
- Webhook server using `@octokit/app` (handles signature verification and installation auth automatically)
- Reuses `fetchCurrentMetrics`, `fetchBaselineMetrics`, `formatReport` from `nr-ai-cicd` unchanged
- Config via env vars: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`
- Optional `NR_AI_REPORT_HOURS` (default `24`) and `NR_AI_REPORT_FAIL_BELOW` quality gate (sets commit status)
- GitHub App manifest and setup instructions in `packages/nr-ai-github-app/README.md`

---

## ✅ 17. GenAI Semantic Convention Mapping

**Status:** Done
**Implementation plan:** [docs/roadmap/17-genai-semantic-conventions.md](docs/roadmap/17-genai-semantic-conventions.md)

Enrich all `AiRequest` and `AiResponse` NR events with the standardized `gen_ai.*` attributes defined by the OpenTelemetry GenAI semantic conventions. Additive change — existing custom field names are preserved. The new attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.) make NR's out-of-the-box AI monitoring views work automatically and enable cross-platform NRQL queries using standardized names.

**Scope:**
- Two mapping tables in `packages/shared/src/events/serialize.ts`: `PROVIDER_TO_GENAI_SYSTEM` and `METHOD_TO_GENAI_OPERATION`
- Extend `aiRequestToNrEvent()` with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.stream`
- Extend `aiResponseToNrEvent()` with `gen_ai.system`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.response.finish_reason`
- Tests asserting every new attribute is present (and absent when the source value is null/zero)

---

## 18. OTLP Transport Option

**Status:** Planned
**Implementation plan:** [docs/roadmap/18-otlp-transport.md](docs/roadmap/18-otlp-transport.md)

Add an OTLP/HTTP transport as an optional alternative or complement to the existing NR Events API + Metric API transports. When `otlpEndpoint` is configured, telemetry can be routed to any OpenTelemetry-compatible backend (Datadog, Honeycomb, Grafana Cloud, self-hosted OTel Collector, or NR's own OTLP ingest). The default `nr-events-api` path is unchanged; OTLP is strictly additive. A `transport: 'both'` mode sends to both simultaneously.

**Scope:**
- New `OtlpTransport` class in `packages/shared/src/transport/otlp-transport.ts` (wraps OTel SDK `BasicTracerProvider` + `BatchSpanProcessor`)
- New `OtlpEventBridge` in `packages/shared/src/transport/otlp-event-bridge.ts` (converts `NrEventData[]` to OTel log records via `LoggerProvider`)
- Config fields: `otlpEndpoint`, `otlpHeaders`, `transport: 'nr-events-api' | 'otlp' | 'both'` in both `AgentConfig` and `McpServerConfig`
- `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` env var support (standard OTel variable names)
- `HarvestScheduler` routing updated to dispatch based on `transport` config
- OTel SDK packages added as dependencies to `packages/shared`
- Wire-up in `NrAiAgent` (`agent.ts`) and `NrIngestManager` (`nr-ingest.ts`)

---

## 19. OTel Spans in SDK Wrappers

**Status:** Planned
**Implementation plan:** [docs/roadmap/19-otel-spans-sdk-wrappers.md](docs/roadmap/19-otel-spans-sdk-wrappers.md)

Make `nr-ai-agent` emit proper OpenTelemetry trace spans from all six SDK wrappers (Anthropic, Gemini, OpenAI, Bedrock, Mistral, Cohere), following the GenAI semantic conventions. This fills the gap in the OTel ecosystem — no official auto-instrumentation packages exist for these SDKs. Each LLM call becomes a span named `"{operation} {model}"` with `gen_ai.*` request and response attributes. When OTLP is not configured, the OTel no-op tracer is used so there is zero overhead.

**Scope:**
- New `packages/nr-ai-agent/src/tracing.ts` — `initTracer()` / `getTracer()` module singleton
- New `packages/nr-ai-agent/src/span-attributes.ts` — `buildSpanName()`, `buildRequestAttributes()`, `buildResponseAttributes()` helpers
- All six wrappers extended to start a span before the SDK call and end it in success/error callbacks (streaming spans end after the last chunk)
- Error spans call `span.recordException()` and set `SpanStatusCode.ERROR`
- `agent.ts` calls `initTracer()` when `transport !== 'nr-events-api'`
- Existing `AiRequestRecord` emission via `onRecord` is untouched

---

## 20. MCP Tool Call Tracing

**Status:** Planned
**Implementation plan:** [docs/roadmap/20-mcp-tool-call-tracing.md](docs/roadmap/20-mcp-tool-call-tracing.md)

Trace every Claude Code tool call as an OpenTelemetry span, creating the first-ever OTel instrumentation for MCP sessions. The span hierarchy mirrors session structure: a root session span contains task spans (from `TaskDetector` boundaries), which contain individual tool call spans. Each span carries `mcp.tool.name`, `mcp.tool.use_id`, `ai.session.id`, `ai.task.id`, and duration. The resulting waterfall in any OTel backend shows exactly what the AI coding assistant did, task by task, tool by tool.

**Scope:**
- New `packages/nr-ai-mcp-server/src/tracing/` directory with four modules: `mcp-tracer.ts`, `session-span.ts`, `tool-call-span.ts`, `task-span-tracker.ts`
- `SessionSpan` manages the root span lifecycle (start at server startup, end at shutdown with `tool_call_count` and `task_count`)
- `TaskSpanTracker` opens/closes intermediate task spans based on `TaskDetector` boundary events
- `emitToolCallSpan()` creates a child span from each completed `ToolCallRecord`; failed records set `ERROR` status
- `TaskDetector` extended with `getActiveTaskId()` to expose current task for span parenting
- Wired into `NrMcpServer` — guards on `transport !== 'nr-events-api'` so tracing is zero-cost when OTLP is disabled

---

## 21. OTLP Input in Proxy Mode

**Status:** Planned
**Implementation plan:** [docs/roadmap/21-otlp-proxy-input.md](docs/roadmap/21-otlp-proxy-input.md)

When running in proxy mode, start a local OTLP/HTTP receiver (default port 4318) that accepts telemetry from any OTel-instrumented application on the developer's machine. The receiver enriches every received resource with the current session context (`ai.session.id`, `ai.developer`, `ai.project_id`) and forwards the enriched payload to NR's OTLP ingest endpoint. This makes the observatory act as a local OTel Collector that ties AI-coded application spans back to the coding session that produced them.

**Scope:**
- New `OtlpReceiver` class in `packages/nr-ai-mcp-server/src/proxy/otlp-receiver.ts` — HTTP server accepting `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- JSON-encoded OTLP payloads have enrichment attributes injected into all `resourceSpans` / `resourceMetrics` / `resourceLogs` resource arrays; protobuf payloads are forwarded as-is
- SSRF guard: `otlpForwardEndpoint` validated against RFC-1918/loopback at startup; receiver disabled with warning if invalid
- Config fields: `otlpReceiverEnabled` (default `false`), `otlpReceiverPort` (default `4318`), `otlpForwardEndpoint` (default NR US OTLP endpoint)
- `OtlpReceiver` started/stopped in `ProxyManager` alongside the existing proxy HTTP server
- `NR_AI_OTLP_RECEIVER_ENABLED`, `NR_AI_OTLP_RECEIVER_PORT`, `NR_AI_OTLP_FORWARD_ENDPOINT` env vars

---

## Implementation Notes

All implementation plans are structured so a capable coding agent (e.g., Claude Haiku) can execute them autonomously. Each plan includes:
- Exact file paths to create or modify
- Interface definitions to implement
- Test cases to write
- Build/lint/test commands to verify completion
- Acceptance criteria

New packages follow the monorepo conventions in `CLAUDE.md`. All new code must pass `npm run build && npm test && npm run lint` before merging.

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
12. [Developer Identity as Explicit Config](#12-developer-identity-as-explicit-config)
13. [Personal Developer Dashboard](#13-personal-developer-dashboard)
14. [Developer-Scoped Alert Deployments](#14-developer-scoped-alert-deployments)
15. [Personal Coaching MCP Tool](#15-personal-coaching-mcp-tool)
16. [GitHub App Integration](#16-github-app-integration)

---

## ✅ 1. Session Trace ID

**Status:** Done
**Implementation plan:** [docs/roadmap/01-session-trace-id.md](docs/roadmap/01-session-trace-id.md)

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
**Implementation plan:** [docs/roadmap/02-session-id-dashboards.md](docs/roadmap/02-session-id-dashboards.md)

Update all 4 existing dashboards to include a `session_id` template variable that optionally scopes every widget to a single session. Create a new dedicated session detail dashboard with per-session timeline, task, file, and anti-pattern widgets for post-session analysis.

**Scope:**
- Add `session_id` NR template variable to all 4 existing dashboard JSON files
- Inject `WHERE session_id = '{{session_id}}'` into every event-type NRQL query in those dashboards
- Create `ai-coding-assistant-session-detail.json` with 2 pages and 12 widgets
- Verify deploy script handles the new file without changes

---

## ✅ 3. Alert Conditions

**Status:** Done
**Implementation plan:** [docs/roadmap/03-alert-conditions.md](docs/roadmap/03-alert-conditions.md)

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
**Implementation plan:** [docs/roadmap/04-openai-wrapper.md](docs/roadmap/04-openai-wrapper.md)

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
**Implementation plan:** [docs/roadmap/05-cicd-integration.md](docs/roadmap/05-cicd-integration.md)

A GitHub Actions composite action (and matching GitLab CI job template) that reads session telemetry from the current branch, computes cost and efficiency deltas, and posts a structured comment on the pull request. Brings AI coding observability into code review.

**Scope:**
- `packages/nr-ai-cicd/` new package
- `nr-ai-report` CLI binary (reads NR NRQL, formats markdown)
- GitHub Actions composite action (`actions/report/action.yml`)
- GitLab CI job template (`.gitlab-ci-template.yml`)
- PR comment format: cost delta, efficiency score, top anti-patterns, model breakdown
- Threshold-based pass/fail status check (configurable)

---

## 6. Cost Budgets and Forecasting

**Status:** Planned
**Implementation plan:** [docs/roadmap/06-cost-budgets.md](docs/roadmap/06-cost-budgets.md)

Config-level budget caps (`dailyBudgetUsd`, `sessionBudgetUsd`, `weeklyBudgetUsd`) that emit warnings when thresholds are approached. A new `nr_observe_get_cost_forecast` MCP tool that extrapolates spend from the current session and weekly trend. Budget state surfaces in the efficiency score and anti-pattern reports.

**Scope:**
- Budget fields in `McpServerConfig`
- `BudgetTracker` class in `src/metrics/`
- `nr_observe_get_budget_status` and `nr_observe_get_cost_forecast` MCP tools
- Warning events emitted to NR when budget thresholds crossed (50%, 80%, 100%)
- Budget state included in session stats and weekly summary

---

## 7. Additional Platform Adapters

**Status:** Planned
**Implementation plan:** [docs/roadmap/07-platform-adapters.md](docs/roadmap/07-platform-adapters.md)

Add adapters for Zed, Continue.dev, and Amazon Q Developer to match the existing Claude Code / Cursor / Windsurf / Copilot coverage. Each adapter normalizes platform-specific hook or event formats into the shared `ToolCallRecord` shape.

**Scope:**
- `packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts`
- `packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts`
- `packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts`
- Platform detection heuristics for each (env vars, config file presence)
- Tests for each adapter
- Platform registry updates

---

## 8. New Metric Trackers

**Status:** Planned
**Implementation plan:** [docs/roadmap/08-new-metric-trackers.md](docs/roadmap/08-new-metric-trackers.md)

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

## 9. Team and Org Analytics

**Status:** Planned
**Implementation plan:** [docs/roadmap/09-team-org-analytics.md](docs/roadmap/09-team-org-analytics.md)

Lift the single-developer model to support team-level aggregation. Telemetry is tagged with a `teamId` and `projectId` derived from git remote URL and config. A separate read-only "manager dashboard" shows cost allocation by developer, project, and sprint without exposing tool-call content.

**Scope:**
- `teamId` and `projectId` dimensions added to all NR events/metrics
- Git remote URL → project slug extraction utility
- Manager dashboard JSON (cost + efficiency only, no content)
- Developer dashboard retains full detail
- `nr_observe_get_team_summary` MCP tool (aggregates across developers' NR data via NRQL)
- Config fields: `teamId`, `projectId`, `orgId`

---

## 10. Developer Experience Improvements

**Status:** Planned
**Implementation plan:** [docs/roadmap/10-developer-experience.md](docs/roadmap/10-developer-experience.md)

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

## 11. Additional SDK Wrappers

**Status:** Planned
**Implementation plan:** [docs/roadmap/11-additional-sdk-wrappers.md](docs/roadmap/11-additional-sdk-wrappers.md)

Extend `nr-ai-agent` with wrappers for AWS Bedrock (native SDK), Mistral, and Cohere to cover the remaining major enterprise AI providers.

**Scope:**
- `packages/nr-ai-agent/src/wrappers/bedrock.ts` — `@aws-sdk/client-bedrock-runtime` `InvokeModelCommand` + `InvokeModelWithResponseStreamCommand`
- `packages/nr-ai-agent/src/wrappers/mistral.ts` — `@mistralai/mistralai` `chat.complete` / `chat.stream`
- `packages/nr-ai-agent/src/wrappers/cohere.ts` — `cohere-ai` `chat` / `chatStream`
- Pricing data for all three providers
- Tests for each wrapper
- Peer dependencies added to `nr-ai-agent/package.json`

---

## 12. Developer Identity as Explicit Config

**Status:** Planned
**Implementation plan:** [docs/roadmap/12-developer-identity.md](docs/roadmap/12-developer-identity.md)

Make `developer` a first-class configured identity rather than a value inferred from `$USER` or git config. The setup wizard confirms or sets it once; every subsequent NR event, metric, and log carries that value reliably. This is the prerequisite for items 13–15 — without an explicit, stable identity, per-developer dashboards and alerts split silently when a user switches machines, renames their OS user, or works in a containerized environment.

**Scope:**
- Add `developer` as an explicit field in `McpServerConfig` (config file + env var `NEW_RELIC_AI_DEVELOPER`)
- Fall back to `$USER` / `git config user.name` / `hostname` in that priority order when not set
- Normalise the value at config load time: lowercase, strip non-alphanumeric except `-` and `_`, max 64 chars
- Surface the resolved identity in `nr_observe_get_session_stats` so the developer can confirm it at runtime
- Update setup wizard (`setup-wizard.ts`) to prompt for and persist the developer name
- Add a `developer` field to the weekly summary JSON so cross-session tools carry the same identity
- Tests covering env var override, git config fallback, and normalisation edge cases

---

## 13. Personal Developer Dashboard

**Status:** Planned
**Implementation plan:** [docs/roadmap/13-personal-dashboard.md](docs/roadmap/13-personal-dashboard.md)

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

## 14. Developer-Scoped Alert Deployments

**Status:** Planned
**Implementation plan:** [docs/roadmap/14-developer-alerts.md](docs/roadmap/14-developer-alerts.md)

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

## 15. Personal Coaching MCP Tool

**Status:** Planned
**Implementation plan:** [docs/roadmap/15-personal-coaching.md](docs/roadmap/15-personal-coaching.md)

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

## 16. GitHub App Integration

**Status:** Planned
**Implementation plan:** [docs/roadmap/16-github-app.md](docs/roadmap/16-github-app.md)

A GitHub App that posts AI coding cost and efficiency reports directly on pull requests, without requiring GitHub Actions. Useful when Actions are disabled on an Enterprise account. The app runs as a small webhook server (deployable anywhere — Vercel, Railway, any Node host) that listens for `pull_request` events, fetches metrics from New Relic using the existing `nr-ai-cicd` library, and posts the formatted report as a PR comment via the GitHub API.

**Scope:**
- `packages/nr-ai-github-app/` new package with `nr-ai-github-app` binary
- Webhook server using `@octokit/app` (handles signature verification and installation auth automatically)
- Reuses `fetchCurrentMetrics`, `fetchBaselineMetrics`, `formatReport` from `nr-ai-cicd` unchanged
- Config via env vars: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`
- Optional `NR_AI_REPORT_HOURS` (default `24`) and `NR_AI_REPORT_FAIL_BELOW` quality gate (sets commit status)
- GitHub App manifest and setup instructions in `packages/nr-ai-github-app/README.md`

---

## Implementation Notes

All implementation plans are structured so a capable coding agent (e.g., Claude Haiku) can execute them autonomously. Each plan includes:
- Exact file paths to create or modify
- Interface definitions to implement
- Test cases to write
- Build/lint/test commands to verify completion
- Acceptance criteria

New packages follow the monorepo conventions in `CLAUDE.md`. All new code must pass `npm run build && npm test && npm run lint` before merging.

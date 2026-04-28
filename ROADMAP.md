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

## Implementation Notes

All implementation plans are structured so a capable coding agent (e.g., Claude Haiku) can execute them autonomously. Each plan includes:
- Exact file paths to create or modify
- Interface definitions to implement
- Test cases to write
- Build/lint/test commands to verify completion
- Acceptance criteria

New packages follow the monorepo conventions in `CLAUDE.md`. All new code must pass `npm run build && npm test && npm run lint` before merging.

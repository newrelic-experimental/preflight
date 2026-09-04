---
name: observability
description: Use when the user asks about AI coding session cost, token
  usage, efficiency score, anti-patterns (thrashing, re-reading, stuck
  loops), task completion, budget status, prompt cache health, git workflow
  efficiency, or wants to query New Relic Preflight's observability data for
  this coding session, past sessions, or their team. Also use for
  weekly/team summaries, personal coaching insights, and
  platform-comparison requests.
---

# Preflight Observability (nr_observe_*)

This power's MCP server exposes read-only query tools over Preflight's
session, cost, and efficiency telemetry. If these tools return no data or
errors, run the `setup` skill first — it covers connecting the MCP server
and wiring the hooks that populate this data in the first place.

## Available tools

### Session

- `nr_observe_health` — server health, connection status, hook-install state
- `nr_observe_install_hooks` — install/repair hook wiring for the detected platform
- `nr_observe_get_config` — current config with secrets masked
- `nr_observe_get_session_stats` — tool call counts, success rate, files touched
- `nr_observe_get_session_timeline` — ordered list of recent tool calls

### Cost

- `nr_observe_report_tokens` — self-report token usage for cost tracking
- `nr_observe_get_cost_breakdown` — cost by model/task, cost per line/file
- `nr_observe_get_budget_status` — spend vs. session/daily/weekly caps
- `nr_observe_get_prompt_cache_health` — cache hit rate and savings
- `nr_observe_get_cost_forecast` — burn-rate-based spend projection

### Workflow

- `nr_observe_get_workflow_trace` — full tool trace + anti-patterns for a task
- `nr_observe_get_anti_patterns` — thrashing / re-reading / stuck-loop / etc.
- `nr_observe_get_efficiency_score` — composite efficiency score
- `nr_observe_report_feedback` — record quality feedback for a task
- `nr_observe_mark_task_boundary` — explicitly close the active task

### Cross-Session

- `nr_observe_get_session_history`
- `nr_observe_get_weekly_summary`
- `nr_observe_get_trends`
- `nr_observe_get_collaboration_profile`
- `nr_observe_get_claudemd_impact`
- `nr_observe_get_cost_per_outcome`
- `nr_observe_get_recommendations`
- `nr_observe_get_personal_insights`
- `nr_observe_get_platform_comparison`

### Analytics / Extended Analytics

- `nr_observe_get_context_efficiency`
- `nr_observe_get_latency_percentiles`
- `nr_observe_get_task_completion_rate`
- `nr_observe_get_model_usage`
- `nr_observe_get_context_tracking`
- `nr_observe_get_cost_per_tool`
- `nr_observe_get_turn_analysis`
- `nr_observe_get_git_efficiency`
- `nr_observe_get_retry_alerts`
- `nr_observe_get_context_composition`
- `nr_observe_get_latency_decomposition`
- `nr_observe_get_decision_tree`
- `nr_observe_get_instruction_drift`
- `nr_observe_get_tool_selection_score`
- `nr_observe_get_quality_proxy`
- `nr_observe_get_api_failures`

### Team / Digest

- `nr_observe_get_team_summary`
- `nr_observe_subscribe_digest`
- `nr_observe_unsubscribe_digest`
- `nr_observe_send_digest`

Full parameter/return-shape reference for every tool lives in this repo's
`docs/COMMANDS_TABLE.md` — that file is the source of truth; keep this
list's tool names in sync with it rather than restating field-level detail
here. Tools are conditionally registered, so not every tool above is
guaranteed to be available in every configuration.

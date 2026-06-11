# NR AI Coding Observability — Metrics Reference

Every metric and event that this project sends to New Relic, organized by delivery API and source package.

---

## Delivery Mechanism

All telemetry flows through the `HarvestScheduler` and `LogIngestManager`:

| Channel | Target API    | Flush Interval | Retry Buffer  |
| ------- | ------------- | -------------- | ------------- |
| Events  | NR Events API | 5 seconds      | 1,000 events  |
| Metrics | NR Metric API | 60 seconds     | 500 metrics   |
| Logs    | NR Logs API   | 5 seconds      | 1,000 entries |

Failed batches are re-queued with bounded buffers. Oldest entries are dropped on overflow.

### Transport Routing

The `transport` config field controls where the `HarvestScheduler` sends telemetry:

| Mode                      | Events                           | Metrics                          |
| ------------------------- | -------------------------------- | -------------------------------- |
| `nr-events-api` (default) | NR Events API                    | NR Metric API                    |
| `otlp`                    | OTLP/HTTP (as log records)       | OTLP/HTTP (as gauge data points) |
| `both`                    | Both simultaneously (concurrent) | Both simultaneously (concurrent) |

OTLP targets any OpenTelemetry-compatible backend. New Relic OTLP: US `https://otlp.nr-data.net`, EU `https://otlp.eu01.nr-data.net`.

Source: `src/shared/harvest/harvest-scheduler.ts`, `src/transport/log-ingest.ts`

---

## Events API

### MCP Server Events

These events are emitted by the MCP server (`nr-ai-mcp-server`) when Claude Code or another IDE uses a tool.

#### `AiToolCall`

Emitted for every tool call captured by the hook collector.

| Field               | Type    | Description                                                                                                                                                                |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`         | string  | Always `"AiToolCall"`                                                                                                                                                      |
| `timestamp`         | number  | Unix epoch milliseconds                                                                                                                                                    |
| `tool`              | string  | Tool name (e.g., `Read`, `Edit`, `Bash`, `Grep`)                                                                                                                           |
| `tool_use_id`       | string  | Unique tool use identifier from the AI assistant                                                                                                                           |
| `success`           | boolean | Whether the tool call succeeded                                                                                                                                            |
| `developer`         | string  | Developer identifier                                                                                                                                                       |
| `app_name`          | string  | Application name (default: `nr-ai-mcp-server`)                                                                                                                             |
| `session_id`        | string  | Session identifier (if available)                                                                                                                                          |
| `team_id`           | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not configured.                                              |
| `project_id`        | string  | Project identifier (derived from git remote or configured)                                                                                                                 |
| `org_id`            | string  | Organization identifier (if configured)                                                                                                                                    |
| `platform`          | string  | Platform attribution (default: `claude-code`)                                                                                                                              |
| `duration_ms`       | number  | Tool call duration in milliseconds (if available)                                                                                                                          |
| `error_type`        | string  | Error classification (if failed)                                                                                                                                           |
| `error`             | string  | Error message (if failed)                                                                                                                                                  |
| `input_size_bytes`  | number  | Size of tool input (if available)                                                                                                                                          |
| `output_size_bytes` | number  | Size of tool output (if available)                                                                                                                                         |
| `input_hash`        | string  | Hash of tool input for deduplication (if available)                                                                                                                        |
| `*`                 | varies  | Tool-specific fields from input/output parsers (e.g., `filePath`, `command`, `exitCode`, `isTestCommand`, `bashCategory`, `bashLeading`, `bashDestructive`, `bashNetwork`) |

Source: `src/transport/nr-ingest.ts` — `toolCallToNrEvent()`

Bash tool calls additionally carry four classifier fields:

- `bashCategory` — one of `git`, `package-manager`, `test-runner`, `build`, `container`, `network`, `fs-op`, `search`, `custom-script`, `shell-other`
- `bashLeading` — the resolved leading argv0 (after sudo / env-var stripping)
- `bashDestructive` — `true` for recursive rm, force-push, dd, mkfs, drop/truncate, chmod 777, pipe-to-shell, etc. (`--force-with-lease` and `--force-if-includes` are NOT flagged)
- `bashNetwork` — `true` when the leading command is a network client (curl/wget/ssh/...)

Source: `src/hooks/bash-classifier.ts` — `classifyBash()`

#### `AiMcpToolCall`

Emitted for proxied tool calls (when the server forwards to upstream MCP servers).

| Field                 | Type    | Description                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiMcpToolCall"`                                                                                               |
| `timestamp`           | number  | Unix epoch milliseconds                                                                                                |
| `server`              | string  | Upstream server name                                                                                                   |
| `tool`                | string  | Tool name                                                                                                              |
| `duration_ms`         | number  | Total duration including proxy overhead                                                                                |
| `upstream_latency_ms` | number  | Upstream server response time                                                                                          |
| `success`             | boolean | Whether the call succeeded                                                                                             |
| `developer`           | string  | Developer identifier                                                                                                   |
| `app_name`            | string  | Application name                                                                                                       |
| `session_id`          | string  | Session identifier (if available)                                                                                      |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                             |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Time spent in proxy layer (if available)                                                                               |
| `error_type`          | string  | Error classification (if failed)                                                                                       |
| `request_size_bytes`  | number  | Request payload size (if available)                                                                                    |
| `response_size_bytes` | number  | Response payload size (if available)                                                                                   |

Source: `src/transport/nr-ingest.ts` — `proxyToolCallToNrEvent()`

#### `AiProxyRequest`

Emitted for non-tool proxy requests (discovery methods like `tools/list`, `resources/list`).

| Field                 | Type    | Description                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiProxyRequest"`                                                                                              |
| `timestamp`           | number  | Unix epoch milliseconds                                                                                                |
| `server`              | string  | Upstream server name                                                                                                   |
| `method`              | string  | MCP method name (e.g., `tools/list`)                                                                                   |
| `duration_ms`         | number  | Total duration                                                                                                         |
| `upstream_latency_ms` | number  | Upstream response time                                                                                                 |
| `success`             | boolean | Whether the request succeeded                                                                                          |
| `developer`           | string  | Developer identifier                                                                                                   |
| `app_name`            | string  | Application name                                                                                                       |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                             |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Proxy layer overhead (if available)                                                                                    |
| `response_size_bytes` | number  | Response size (if available)                                                                                           |

Source: `src/transport/nr-ingest.ts` — `proxyRequestToNrEvent()`

#### `AiAuditEvent`

Emitted for every tool call as a security audit record.

| Field                  | Type    | Description                                                                                                            |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`            | string  | Always `"AiAuditEvent"`                                                                                                |
| `timestamp`            | number  | Unix epoch seconds                                                                                                     |
| `action`               | string  | Audit action: `FileRead`, `FileWrite`, `FileEdit`, `BashCommand`, `McpToolCall`, `AgentSpawn`, `Search`, or `Other`    |
| `tool`                 | string  | Tool name                                                                                                              |
| `detail`               | string  | Human-readable description of the action                                                                               |
| `developer`            | string  | Developer identifier                                                                                                   |
| `session_id`           | string  | Session identifier (if available)                                                                                      |
| `team_id`              | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`           | string  | Project identifier (derived from git remote or configured)                                                             |
| `org_id`               | string  | Organization identifier (if configured)                                                                                |
| `file_path`            | string  | File path involved (if applicable)                                                                                     |
| `command`              | string  | Command executed (if applicable)                                                                                       |
| `audit.security_alert` | boolean | Whether a security alert was triggered                                                                                 |
| `audit.severity`       | string  | Alert severity: `critical`, `high`, or `medium` (if alert)                                                             |
| `audit.alert_type`     | string  | Alert type: `destructive_command`, `sensitive_file`, or `external_network` (if alert)                                  |

Source: `src/security/audit-trail.ts` — `auditRecordToNrEvent()`

#### `SecurityAlert`

Emitted only when a security alert is triggered (subset of audit events).

| Field         | Type   | Description                                                                                                            |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`   | string | Always `"SecurityAlert"`                                                                                               |
| `timestamp`   | number | Unix epoch seconds                                                                                                     |
| `severity`    | string | `critical`, `high`, or `medium`                                                                                        |
| `alert_type`  | string | `destructive_command`, `sensitive_file`, or `external_network`                                                         |
| `description` | string | Human-readable alert description                                                                                       |
| `tool`        | string | Tool that triggered the alert                                                                                          |
| `developer`   | string | Developer identifier                                                                                                   |
| `session_id`  | string | Session identifier (if available)                                                                                      |
| `team_id`     | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`  | string | Project identifier (derived from git remote or configured)                                                             |
| `org_id`      | string | Organization identifier (if configured)                                                                                |
| `file_path`   | string | File path (if sensitive file alert)                                                                                    |
| `command`     | string | Command (if destructive command alert)                                                                                 |

Security alert triggers:

- **`destructive_command`** (critical): `rm -rf` (any recursive flag combo), `git push --force` (but NOT `--force-with-lease` / `--force-if-includes`), `DROP TABLE`, pipe-to-shell, etc. Detection is the OR of the bash classifier (`record.bashDestructive`) and the regex pattern list — defense in depth, neither layer alone is authoritative.
- **`sensitive_file`** (high): `.env`, `.pem`, `.key`, `credentials`, `secret`, `.ssh`, `.npmrc`, `.pypirc`, `password`, `token` (path-boundary anchored)
- **`external_network`** (medium): `curl`, `wget`, `nc`, `ssh` commands. Detection is the OR of the bash classifier (`record.bashNetwork`) and the regex pattern list.

Source: `src/security/audit-trail.ts` — `securityAlertToNrEvent()`

#### `AiCodingTask`

Emitted when a task boundary is detected (a logical unit of work from task start to completion).

| Field                  | Type    | Description                                                                                                            |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`            | string  | Always `"AiCodingTask"`                                                                                                |
| `timestamp`            | number  | Unix epoch milliseconds (task end time)                                                                                |
| `task_id`              | string  | Unique task identifier                                                                                                 |
| `developer`            | string  | Developer identifier                                                                                                   |
| `app_name`             | string  | Application name                                                                                                       |
| `platform`             | string  | Platform attribution (default: `claude-code`)                                                                          |
| `session_id`           | string  | Session identifier (if available)                                                                                      |
| `team_id`              | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`           | string  | Project identifier (derived from git remote or configured)                                                             |
| `org_id`               | string  | Organization identifier (if configured)                                                                                |
| `start_time`           | number  | Task start time (Unix epoch milliseconds)                                                                              |
| `end_time`             | number  | Task end time (Unix epoch milliseconds)                                                                                |
| `duration_ms`          | number  | Task duration in milliseconds                                                                                          |
| `tool_call_count`      | number  | Total tool calls in the task                                                                                           |
| `files_read`           | number  | Number of unique files read                                                                                            |
| `files_modified`       | number  | Number of unique files modified                                                                                        |
| `lines_added`          | number  | Lines added across all edits                                                                                           |
| `lines_removed`        | number  | Lines removed across all edits                                                                                         |
| `bash_commands_run`    | number  | Number of Bash tool calls                                                                                              |
| `tests_run`            | number  | Number of test runs detected                                                                                           |
| `tests_passed`         | boolean | Whether the last test run passed                                                                                       |
| `build_run`            | boolean | Whether a build was run                                                                                                |
| `build_passed`         | boolean | Whether the last build passed                                                                                          |
| `estimated_cost_usd`   | number  | Estimated token cost for the task (`0` when cost was never computed)                                                   |
| `cost_estimated`       | boolean | `true` when `estimated_cost_usd` was actually computed; `false` when defaulted to `0`                                  |
| `tokens_used`          | number  | Total tokens consumed in the task                                                                                      |
| `asked_user_questions` | number  | Number of questions asked to the user                                                                                  |
| `sub_agents_spawned`   | number  | Number of sub-agent spawns                                                                                             |

Source: `src/transport/nr-ingest.ts` — `codingTaskToNrEvent()`

#### `AiAntiPattern`

Emitted for each anti-pattern detected within a completed task.

| Field          | Type   | Description                                                                                                            |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`    | string | Always `"AiAntiPattern"`                                                                                               |
| `timestamp`    | number | Unix epoch milliseconds (detection time)                                                                               |
| `type`         | string | Pattern type: `thrashing`, `re_reading`, `stuck_loop`, `blind_editing`, or `over_delegation`                           |
| `task_id`      | string | Task identifier where the pattern was detected                                                                         |
| `developer`    | string | Developer identifier                                                                                                   |
| `app_name`     | string | Application name                                                                                                       |
| `platform`     | string | Platform attribution                                                                                                   |
| `session_id`   | string | Session identifier (if available)                                                                                      |
| `team_id`      | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`   | string | Project identifier (if configured)                                                                                     |
| `org_id`       | string | Organization identifier (if configured)                                                                                |
| `suggestion`   | string | Human-readable remediation suggestion                                                                                  |
| `file`         | string | File involved (if applicable)                                                                                          |
| `command`      | string | Command involved (if applicable)                                                                                       |
| `iterations`   | number | Number of thrash/repeat iterations (if applicable)                                                                     |
| `read_count`   | number | Number of redundant reads (re_reading only)                                                                            |
| `repeat_count` | number | Number of identical command repeats (stuck_loop only)                                                                  |
| `edit_count`   | number | Number of unverified edits (blind_editing only)                                                                        |
| `agent_count`  | number | Number of agent spawns (over_delegation only)                                                                          |

Source: `src/transport/nr-ingest.ts` — `antiPatternToNrEvent()`

#### `AiBudgetWarning`

Emitted when a configured budget threshold is crossed (50%, 80%, 100%).

| Field           | Type   | Description                                                                                                            |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"AiBudgetWarning"`                                                                                             |
| `timestamp`     | number | Unix epoch milliseconds                                                                                                |
| `budget_period` | string | Budget period: `session`, `daily`, or `weekly`                                                                         |
| `threshold_pct` | number | Threshold percentage: `50`, `80`, or `100`                                                                             |
| `spent_usd`     | number | Amount spent in this period (USD)                                                                                      |
| `budget_usd`    | number | Configured budget limit (USD)                                                                                          |
| `remaining_usd` | number | Remaining budget (`max(0, budget_usd - spent_usd)`)                                                                    |
| `developer`     | string | Developer identifier                                                                                                   |
| `appName`       | string | Application name (note: camelCase, unlike other MCP events)                                                            |
| `session_id`    | string | Session identifier (if available)                                                                                      |
| `team_id`       | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`    | string | Project identifier (if configured)                                                                                     |
| `org_id`        | string | Organization identifier (if configured)                                                                                |

**Firing rules:**

- `50%` — first time spend reaches 50% of budget
- `80%` — first time spend reaches 80% of budget
- `100%` — first time spend reaches or exceeds 100% of budget

Each threshold fires only once per period; subsequent additions to spend do not re-fire.

Source: `src/transport/nr-ingest.ts`, `src/metrics/budget-tracker.ts`

#### `AiContextSnapshot`

Emitted for each LLM turn when context-window tracking is enabled, capturing token breakdown by category.

| Field                   | Type   | Description                                                                                                            |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`             | string | Always `"AiContextSnapshot"`                                                                                           |
| `timestamp`             | number | Unix epoch milliseconds                                                                                                |
| `developer`             | string | Developer identifier                                                                                                   |
| `appName`               | string | Application name (camelCase, same as `AiBudgetWarning`)                                                                |
| `session_id`            | string | Session identifier (if available)                                                                                      |
| `team_id`               | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`            | string | Project identifier (if configured)                                                                                     |
| `org_id`                | string | Organization identifier (if configured)                                                                                |
| `turn_number`           | number | Sequential turn number within the session                                                                              |
| `total_context_tokens`  | number | Total input tokens for this turn                                                                                       |
| `output_tokens`         | number | Output tokens for this turn                                                                                            |
| `cache_read_tokens`     | number | Prompt cache read tokens                                                                                               |
| `cache_creation_tokens` | number | Prompt cache creation tokens                                                                                           |
| `fill_percent`          | number | Context window fill percentage (0–100)                                                                                 |
| `system_tokens`         | number | Tokens consumed by system prompt                                                                                       |
| `tool_tokens`           | number | Tokens consumed by tool definitions and results                                                                        |
| `user_tokens`           | number | Tokens consumed by user messages                                                                                       |
| `assistant_tokens`      | number | Tokens consumed by assistant messages                                                                                  |
| `top_tool`              | string | Tool name with largest context contribution (if any)                                                                   |
| `top_tool_bytes`        | number | Byte size of top tool's contribution (if any)                                                                          |
| `top_tool_tokens`       | number | Estimated token count of top tool's contribution (if any)                                                              |

Source: `src/transport/nr-ingest.ts` — `ingestContextSnapshot()`

---

## Metric API

### MCP Server — Per-Call Metrics

Recorded for each tool call as it happens.

| Metric Name                        | Value      | Attributes                                                | How Computed                                                                                                                   |
| ---------------------------------- | ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ai.tool.call_count`               | `1`        | `{tool, session_id?, team_id?, project_id?, org_id?}`     | Incremented once per tool call                                                                                                 |
| `ai.tool.duration_ms`              | duration   | `{tool, session_id?, team_id?, project_id?, org_id?}`     | From `ToolCallRecord.durationMs`                                                                                               |
| `ai.tool.success`                  | `0` or `1` | `{tool, session_id?, team_id?, project_id?, org_id?}`     | `record.success ? 1 : 0`                                                                                                       |
| `ai.bash.call_count`               | count      | `{category, session_id?, team_id?, project_id?, org_id?}` | Per-`bashCategory` call count for Bash tool calls (e.g. `git`, `test-runner`, `build`). Source: `SessionTracker.emitMetrics()` |
| `ai.mcp.proxy_request_count`       | `1`        | `{server, method}`                                        | Incremented per proxy discovery request                                                                                        |
| `ai.mcp.proxy_request_duration_ms` | duration   | `{server}`                                                | From `ProxyRequestRecord.durationMs`                                                                                           |

Source: `src/transport/nr-ingest.ts` — `ingestToolCall()`, `ingestProxyRequest()`

### MCP Server — Session Gauges

Emitted every 60 seconds (on the metric harvest cadence) with current session state.

| Metric Name                       | Value    | Attributes                                      | How Computed                                             |
| --------------------------------- | -------- | ----------------------------------------------- | -------------------------------------------------------- |
| `ai.session.duration_ms`          | duration | `{session_id?, team_id?, project_id?, org_id?}` | `SessionTracker.getMetrics().sessionDurationMs`          |
| `ai.session.unique_files_read`    | count    | `{session_id?, team_id?, project_id?, org_id?}` | Size of internal Set of file paths from Read calls       |
| `ai.session.unique_files_written` | count    | `{session_id?, team_id?, project_id?, org_id?}` | Size of internal Set of file paths from Write/Edit calls |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`

### MCP Server — Proxy Gauges

Emitted every 60 seconds alongside session gauges (only when proxy mode is active).

| Metric Name                | Value       | Attributes                                       | How Computed                                                    |
| -------------------------- | ----------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `ai.mcp.server_call_count` | count       | `{server, team_id?, project_id?, org_id?}`       | Per-server total call count from `ProxyMetricsTracker`          |
| `ai.mcp.server_latency_ms` | average ms  | `{server, team_id?, project_id?, org_id?}`       | `sum(latencies) / count` per server (only emitted if count > 0) |
| `ai.mcp.server_error_rate` | ratio (0-1) | `{server, team_id?, project_id?, org_id?}`       | `failedCount / totalCount` per server (only emitted if > 0)     |
| `ai.mcp.proxy_overhead_ms` | average ms  | `{team_id?, project_id?, org_id?}`               | `sum(overheadValues) / count` across all servers (only if > 0)  |
| `ai.mcp.tool_popularity`   | count       | `{tool, server, team_id?, project_id?, org_id?}` | Per-tool per-server call count (capped at 100 combinations)     |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`, `src/metrics/proxy-metrics.ts`

### MCP Server — Cost Metrics

Emitted every 60 seconds alongside session gauges (only when a `CostTracker` is wired in). All metrics include `{developer, session_id?, team_id?, project_id?, org_id?}` attributes plus `{model?}` when a current model is known.

| Metric Name                      | Value | How Computed                                             |
| -------------------------------- | ----- | -------------------------------------------------------- |
| `ai.cost.session_total_usd`      | USD   | Cumulative session cost across all token reports         |
| `ai.cost.tokens_input`           | count | Cumulative input tokens                                  |
| `ai.cost.tokens_output`          | count | Cumulative output tokens                                 |
| `ai.cost.tokens_thinking`        | count | Cumulative extended thinking tokens                      |
| `ai.cost.tokens_cache_read`      | count | Cumulative prompt cache read tokens                      |
| `ai.cost.cost_per_line_of_code`  | USD   | `session_total_usd / total_lines_changed` (only if > 0)  |
| `ai.cost.cost_per_file_modified` | USD   | `session_total_usd / unique_files_written` (only if > 0) |
| `ai.cost.report_count`           | count | Number of token reports received                         |
| `ai.cost.estimation_count`       | count | Number of cost estimation calls                          |

Source: `src/metrics/cost-tracker.ts` — `emitMetrics()`

### MCP Server — Efficiency Metrics

Emitted every 60 seconds alongside session gauges (only when an `EfficiencyScorer` is wired in and has scored at least one task). Attributes: `{developer, session_id?, team_id?, project_id?, org_id?}`.

| Metric Name                           | Value       | How Computed                        |
| ------------------------------------- | ----------- | ----------------------------------- |
| `ai.efficiency.score`                 | score (0–1) | Composite efficiency score          |
| `ai.efficiency.speed`                 | score (0–1) | Speed component of efficiency       |
| `ai.efficiency.correctness`           | score (0–1) | Correctness component of efficiency |
| `ai.efficiency.autonomy`              | score (0–1) | Autonomy component of efficiency    |
| `ai.efficiency.first_attempt_quality` | score (0–1) | First-attempt quality component     |

Source: `src/metrics/efficiency-score.ts` — `emitMetrics()`

### Metric Aggregation

All metrics pass through the `MetricAggregator` before being sent. For each unique (name + attributes) combination, the aggregator emits a single `summary` metric with:

| Field      | Type   | How Computed                 |
| ---------- | ------ | ---------------------------- |
| `count`    | number | Number of `record()` calls   |
| `sum`      | number | Sum of all values            |
| `min`      | number | Minimum value                |
| `max`      | number | Maximum value                |
| `interval` | number | Harvest window duration (ms) |

The metric `type` is `summary` (not gauge). All four aggregated values are packed into a single NR Metric API record per (name + attributes) per harvest interval.

Source: `src/shared/harvest/metric-aggregator.ts`

---

## Logs API

### Audit Log Entries

Every tool call produces a structured log entry sent to the NR Logs API.

| Field                  | Location   | Type    | Description                            |
| ---------------------- | ---------- | ------- | -------------------------------------- |
| `timestamp`            | top-level  | number  | Epoch milliseconds                     |
| `message`              | top-level  | string  | Human-readable audit detail            |
| `tool`                 | attributes | string  | Tool name                              |
| `developer`            | attributes | string  | Developer identifier                   |
| `app_name`             | attributes | string  | Application name                       |
| `session_id`           | attributes | string  | Session identifier (if available)      |
| `audit.action`         | attributes | string  | Action classification                  |
| `audit.security_alert` | attributes | boolean | Whether a security alert was triggered |
| `audit.file_path`      | attributes | string  | File path (if applicable)              |
| `audit.command`        | attributes | string  | Command (if applicable)                |
| `audit.severity`       | attributes | string  | Alert severity (if alert)              |
| `audit.alert_type`     | attributes | string  | Alert type (if alert)                  |

Source: `src/transport/log-ingest.ts` — `auditRecordToLogEntry()`

# NR AI Coding Observability — Metrics Reference

Every metric and event that this project sends to New Relic, organized by delivery API and source package.

---

## Delivery Mechanism

All telemetry flows through the `HarvestScheduler` and `LogIngestManager`:

| Channel | Target API | Flush Interval | Retry Buffer |
|---------|-----------|----------------|--------------|
| Events | NR Events API | 5 seconds | 1,000 events |
| Metrics | NR Metric API | 60 seconds | 500 metrics |
| Logs | NR Logs API | 5 seconds | 1,000 entries |

Failed batches are re-queued with bounded buffers. Oldest entries are dropped on overflow.

### Transport Routing

The `transport` config field controls where the `HarvestScheduler` sends telemetry:

| Mode | Events | Metrics |
|------|--------|---------|
| `nr-events-api` (default) | NR Events API | NR Metric API |
| `otlp` | OTLP/HTTP (as log records) | OTLP/HTTP (as gauge data points) |
| `both` | Both simultaneously (concurrent) | Both simultaneously (concurrent) |

OTLP targets any OpenTelemetry-compatible backend. New Relic OTLP: US `https://otlp.nr-data.net`, EU `https://otlp.eu01.nr-data.net`.

Source: `src/shared/harvest/harvest-scheduler.ts`, `src/transport/log-ingest.ts`

---

## Events API

### MCP Server Events

These events are emitted by the MCP server (`nr-ai-mcp-server`) when Claude Code or another IDE uses a tool.

#### `AiToolCall`

Emitted for every tool call captured by the hook collector.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiToolCall"` |
| `timestamp` | number | Unix epoch seconds |
| `tool` | string | Tool name (e.g., `Read`, `Edit`, `Bash`, `Grep`) |
| `tool_use_id` | string | Unique tool use identifier from the AI assistant |
| `success` | boolean | Whether the tool call succeeded |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name (default: `nr-ai-mcp-server`) |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `platform` | string | Platform attribution (default: `claude-code`) |
| `duration_ms` | number | Tool call duration in milliseconds (if available) |
| `error_type` | string | Error classification (if failed) |
| `error` | string | Error message (if failed) |
| `input_size_bytes` | number | Size of tool input (if available) |
| `output_size_bytes` | number | Size of tool output (if available) |
| `input_hash` | string | Hash of tool input for deduplication (if available) |
| `*` | varies | Tool-specific fields from input/output parsers (e.g., `filePath`, `command`, `exitCode`, `isTestCommand`) |

Source: `src/transport/nr-ingest.ts` — `toolCallToNrEvent()`

#### `AiMcpToolCall`

Emitted for proxied tool calls (when the server forwards to upstream MCP servers).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiMcpToolCall"` |
| `timestamp` | number | Unix epoch seconds |
| `server` | string | Upstream server name |
| `tool` | string | Tool name |
| `duration_ms` | number | Total duration including proxy overhead |
| `upstream_latency_ms` | number | Upstream server response time |
| `success` | boolean | Whether the call succeeded |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `proxy_overhead_ms` | number | Time spent in proxy layer (if available) |
| `error_type` | string | Error classification (if failed) |
| `request_size_bytes` | number | Request payload size (if available) |
| `response_size_bytes` | number | Response payload size (if available) |

Source: `src/transport/nr-ingest.ts` — `proxyToolCallToNrEvent()`

#### `AiProxyRequest`

Emitted for non-tool proxy requests (discovery methods like `tools/list`, `resources/list`).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiProxyRequest"` |
| `timestamp` | number | Unix epoch seconds |
| `server` | string | Upstream server name |
| `method` | string | MCP method name (e.g., `tools/list`) |
| `duration_ms` | number | Total duration |
| `upstream_latency_ms` | number | Upstream response time |
| `success` | boolean | Whether the request succeeded |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `proxy_overhead_ms` | number | Proxy layer overhead (if available) |
| `response_size_bytes` | number | Response size (if available) |

Source: `src/transport/nr-ingest.ts` — `proxyRequestToNrEvent()`

#### `AiAuditEvent`

Emitted for every tool call as a security audit record.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiAuditEvent"` |
| `timestamp` | number | Unix epoch seconds |
| `action` | string | Audit action classification (e.g., `file_read`, `file_write`, `command_execute`) |
| `tool` | string | Tool name |
| `detail` | string | Human-readable description of the action |
| `developer` | string | Developer identifier |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `file_path` | string | File path involved (if applicable) |
| `command` | string | Command executed (if applicable) |
| `audit.security_alert` | boolean | Whether a security alert was triggered |
| `audit.severity` | string | Alert severity: `critical`, `high`, or `medium` (if alert) |
| `audit.alert_type` | string | Alert type: `destructive_command`, `sensitive_file`, or `external_network` (if alert) |

Source: `src/security/audit-trail.ts` — `auditRecordToNrEvent()`

#### `SecurityAlert`

Emitted only when a security alert is triggered (subset of audit events).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"SecurityAlert"` |
| `timestamp` | number | Unix epoch seconds |
| `severity` | string | `critical`, `high`, or `medium` |
| `alert_type` | string | `destructive_command`, `sensitive_file`, or `external_network` |
| `description` | string | Human-readable alert description |
| `tool` | string | Tool that triggered the alert |
| `developer` | string | Developer identifier |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `file_path` | string | File path (if sensitive file alert) |
| `command` | string | Command (if destructive command alert) |

Security alert triggers:
- **`destructive_command`** (critical): `rm -rf`, `git push --force`, `DROP TABLE`, pipe-to-shell patterns
- **`sensitive_file`** (high): `.env`, `.pem`, `.key`, `credentials`, `secret`, `.ssh`, `.npmrc`, `.pypirc`, `password`, `token` (path-boundary anchored)
- **`external_network`** (medium): `curl`, `wget`, `nc`, `ssh` commands

Source: `src/security/audit-trail.ts` — `securityAlertToNrEvent()`

#### `AiCodingTask`

Emitted when a task boundary is detected (a logical unit of work from task start to completion).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiCodingTask"` |
| `timestamp` | number | Unix epoch seconds (task end time) |
| `task_id` | string | Unique task identifier |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name |
| `platform` | string | Platform attribution (default: `claude-code`) |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (derived from git remote or configured) |
| `org_id` | string | Organization identifier (if configured) |
| `start_time` | number | Task start time (Unix epoch seconds) |
| `end_time` | number | Task end time (Unix epoch seconds) |
| `duration_ms` | number | Task duration in milliseconds |
| `tool_call_count` | number | Total tool calls in the task |
| `files_read` | number | Number of unique files read |
| `files_modified` | number | Number of unique files modified |
| `lines_added` | number | Lines added across all edits |
| `lines_removed` | number | Lines removed across all edits |
| `bash_commands_run` | number | Number of Bash tool calls |
| `tests_run` | number | Number of test runs detected |
| `tests_passed` | boolean | Whether the last test run passed |
| `build_run` | boolean | Whether a build was run |
| `build_passed` | boolean | Whether the last build passed |
| `estimated_cost_usd` | number | Estimated token cost for the task |
| `tokens_used` | number | Total tokens consumed in the task |
| `asked_user_questions` | number | Number of questions asked to the user |
| `sub_agents_spawned` | number | Number of sub-agent spawns |

Source: `src/transport/nr-ingest.ts` — `codingTaskToNrEvent()`

#### `AiAntiPattern`

Emitted for each anti-pattern detected within a completed task.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiAntiPattern"` |
| `timestamp` | number | Unix epoch seconds (detection time) |
| `type` | string | Pattern type: `thrashing`, `re_reading`, `stuck_loop`, `blind_editing`, or `over_delegation` |
| `task_id` | string | Task identifier where the pattern was detected |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name |
| `platform` | string | Platform attribution |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |
| `project_id` | string | Project identifier (if configured) |
| `org_id` | string | Organization identifier (if configured) |
| `suggestion` | string | Human-readable remediation suggestion |
| `file` | string | File involved (if applicable) |
| `command` | string | Command involved (if applicable) |
| `iterations` | number | Number of thrash/repeat iterations (if applicable) |
| `read_count` | number | Number of redundant reads (re_reading only) |
| `repeat_count` | number | Number of identical command repeats (stuck_loop only) |
| `edit_count` | number | Number of unverified edits (blind_editing only) |
| `agent_count` | number | Number of agent spawns (over_delegation only) |

Source: `src/transport/nr-ingest.ts` — `antiPatternToNrEvent()`

#### `AiBudgetWarning`

Emitted when a configured budget threshold is crossed (50%, 80%, 100%).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiBudgetWarning"` |
| `timestamp` | number | Unix epoch seconds |
| `period` | string | Budget period: `session`, `daily`, or `weekly` |
| `threshold_pct` | number | Threshold percentage: `50`, `80`, or `100` |
| `spent_usd` | number | Amount spent in this period (USD) |
| `budget_usd` | number | Configured budget limit (USD) |
| `developer` | string | Developer identifier |
| `app_name` | string | Application name |
| `session_id` | string | Session identifier (if available) |
| `team_id` | string | Team identifier (if configured) |

**Firing rules:**
- `50%` — first time spend reaches 50% of budget
- `80%` — first time spend reaches 80% of budget
- `100%` — first time spend reaches or exceeds 100% of budget

Each threshold fires only once per period; subsequent additions to spend do not re-fire.

Source: `src/transport/nr-ingest.ts`, `src/metrics/budget-tracker.ts`

---

### SDK Agent Events

These events are emitted by the SDK agent (`nr-ai-agent`, now in the `nr-ai-typescript-agent` repo) when application code uses wrapped Anthropic or Gemini clients.

#### `AiRequest`

Emitted for every AI model request.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiRequest"` |
| `id` | string | Unique request identifier |
| `timestamp` | number | Unix epoch seconds |
| `provider` | string | `anthropic`, `google`, `openai`, `bedrock`, `mistral`, or `cohere` |
| `model` | string | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `requestMethod` | string | SDK method: `messages.create`, `messages.stream`, `models.generateContent`, `models.generateContentStream`, or `models.embedContent` |
| `messageCount` | number | Number of messages in the request |
| `toolCount` | number | Number of tools provided |
| `thinkingEnabled` | boolean | Whether extended thinking is enabled |
| `streamingEnabled` | boolean | Whether streaming is used |
| `nr.appName` | string | Application name |
| `maxTokens` | number | Max tokens parameter (if set) |
| `temperature` | number | Temperature parameter (if set) |
| `topP` | number | Top-p parameter (if set) |
| `systemPromptLength` | number | Length of system prompt (if present) |
| `toolNames` | string | Comma-separated tool names (if tools provided) |
| `thinkingBudgetTokens` | number | Thinking budget (if set) |
| `nr.entityGuid` | string | Entity GUID (if set) |
| `custom.*` | varies | Custom attributes prefixed with `custom.` |
| `gen_ai.system` | string | OTel GenAI system name (e.g., `anthropic`, `google_genai`, `aws.bedrock`) |
| `gen_ai.request.model` | string | Model identifier (mirrors `model`) |
| `gen_ai.operation.name` | string | Operation name: `chat`, `generate_content`, or `embeddings` (omitted for unknown methods) |
| `gen_ai.request.max_tokens` | number | Max tokens parameter (omitted when null) |
| `gen_ai.request.temperature` | number | Temperature parameter (omitted when null) |
| `gen_ai.request.top_p` | number | Top-p parameter (omitted when null) |
| `gen_ai.request.stream` | boolean | Whether streaming is enabled (mirrors `streamingEnabled`) |

Source: `src/shared/events/serialize.ts` — `aiRequestToNrEvent()`

#### `AiResponse`

Emitted for every AI model response.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiResponse"` |
| `id` | string | Request identifier (matches the `AiRequest.id`) |
| `timestamp` | number | Unix epoch seconds |
| `provider` | string | `anthropic`, `google`, `openai`, `bedrock`, `mistral`, or `cohere` |
| `model` | string | Model identifier |
| `durationMs` | number | Request-to-response duration |
| `inputTokens` | number | Input/prompt token count |
| `outputTokens` | number | Output/completion token count |
| `thinkingTokens` | number | Extended thinking token count |
| `cacheReadTokens` | number | Prompt cache read tokens |
| `cacheCreationTokens` | number | Prompt cache creation tokens |
| `totalTokens` | number | `inputTokens + outputTokens + thinkingTokens` |
| `nr.appName` | string | Application name |
| `timeToFirstTokenMs` | number | Time to first token (streaming only, if available) |
| `tokensPerSecond` | number | `(outputTokens / durationMs) * 1000` (if both > 0) |
| `stopReason` | string | Why generation stopped (e.g., `end_turn`, `max_tokens`) |
| `contentBlockTypes` | string | Comma-separated content block types |
| `cost.inputUsd` | number | Input token cost in USD |
| `cost.outputUsd` | number | Output token cost in USD |
| `cost.thinkingUsd` | number | Thinking token cost in USD |
| `cost.cacheReadUsd` | number | Cache read token cost in USD |
| `cost.cacheCreationUsd` | number | Cache creation token cost in USD |
| `cost.totalUsd` | number | Total cost in USD |
| `error.type` | string | Error type (if failed) |
| `error.message` | string | Error message (if failed) |
| `error.statusCode` | number | HTTP status code (if failed) |
| `custom.*` | varies | Custom attributes prefixed with `custom.` |
| `gen_ai.system` | string | OTel GenAI system name (e.g., `anthropic`, `google_genai`, `aws.bedrock`) |
| `gen_ai.response.model` | string | Model identifier (mirrors `model`) |
| `gen_ai.usage.input_tokens` | number | Input token count (mirrors `inputTokens`) |
| `gen_ai.usage.output_tokens` | number | Output token count (mirrors `outputTokens`) |
| `gen_ai.usage.reasoning.output_tokens` | number | Extended thinking token count (omitted when 0) |
| `gen_ai.usage.cache_read.input_tokens` | number | Prompt cache read tokens (omitted when 0) |
| `gen_ai.usage.cache_creation.input_tokens` | number | Prompt cache creation tokens (omitted when 0) |
| `gen_ai.response.finish_reason` | string | Stop reason (e.g., `end_turn`, `max_tokens`; omitted when null) |

Source: `src/shared/events/serialize.ts` — `aiResponseToNrEvent()`

#### `AiMessage`

Emitted for message content capture (when `recordContent` is enabled).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiMessage"` |
| `id` | string | Message identifier |
| `timestamp` | number | Unix epoch seconds |
| `role` | string | Message role (`user`, `assistant`, `system`) |
| `content` | string | Message content (may be truncated) |
| `contentLength` | number | Original content length |
| `sequence` | number | Message sequence number |
| `nr.appName` | string | Application name |
| `custom.*` | varies | Custom attributes prefixed with `custom.` |

Source: `src/shared/events/serialize.ts` — `aiMessageToNrEvent()`

#### `AiCostGrowthAlert`

Emitted when the 30-day cost growth rate exceeds a configured threshold.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiCostGrowthAlert"` |
| `timestamp` | number | Unix epoch milliseconds |
| `nr.appName` | string | Application name |
| `growthRatePercent` | number | Computed month-over-month growth rate (%) |
| `growthThresholdPercent` | number | Configured threshold that was exceeded (%) |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `CostForecaster` `onAlert` callback

#### `AiCostForecastAlert`

Emitted when the projected monthly cost exceeds the configured budget.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiCostForecastAlert"` |
| `timestamp` | number | Unix epoch milliseconds |
| `nr.appName` | string | Application name |
| `projectedMonthlyCostUsd` | number | Projected cost for the current month (USD) |
| `monthlyBudgetUsd` | number | Configured monthly budget limit (USD) |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `CostForecaster` `onAlert` callback

#### `AiExperimentSummary`

Emitted every 6 hours for each active A/B experiment.

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiExperimentSummary"` |
| `timestamp` | number | Unix epoch milliseconds |
| `nr.appName` | string | Application name |
| `experimentName` | string | Experiment identifier |
| `variantCount` | number | Number of variants |
| `metricCount` | number | Number of tracked metrics |
| `recommendedWinner` | string | Winning variant name, or empty string if undecided |
| `primaryMetric` | string | Name of the first defined metric (if any) |
| `variant.<name>.mean` | number | Mean value for variant (per primary metric) |
| `variant.<name>.p95` | number | p95 value for variant (per primary metric) |
| `variant.<name>.sampleCount` | number | Sample count for variant |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `emitExperimentEvents()`

#### `AiExperimentConclusion`

Emitted once when an experiment concludes (winner declared or end date reached).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiExperimentConclusion"` |
| `timestamp` | number | Unix epoch milliseconds |
| `nr.appName` | string | Application name |
| `experimentName` | string | Experiment identifier |
| `recommendedWinner` | string | Winning variant name, or empty string if no winner |
| `concluded` | number | Always `1` |
| `endDateReached` | number | `1` if conclusion triggered by end date, `0` if by significance |
| `pValue` | number | Statistical p-value of the winning comparison (only if winner declared) |
| `effectSize` | number | Relative difference between winner and loser (only if winner declared) |
| `winnerSampleCount` | number | Sample count for the winning variant (only if winner declared) |
| `loserSampleCount` | number | Sample count for the losing variant (only if winner declared) |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `emitExperimentEvents()`

#### `AiRecommendation`

Emitted every 5 minutes for each active recommendation (requires ≥20 requests per feature).

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Always `"AiRecommendation"` |
| `timestamp` | number | Unix epoch milliseconds |
| `nr.appName` | string | Application name |
| `type` | string | Recommendation type: `cache_optimization`, `model_switch`, `thinking_budget`, or `context_management` |
| `severity` | string | `high`, `medium`, or `low` |
| `title` | string | Short recommendation title |
| `description` | string | Detailed explanation |
| `estimatedImpact` | string | Human-readable impact description |
| `confidence` | number | Confidence score (0–1) |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `emitRecommendationEvents()`

---

## Metric API

### MCP Server — Per-Call Metrics

Recorded for each tool call as it happens.

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.tool.call_count` | `1` | `{tool, platform, team_id, project_id}` | Incremented once per tool call |
| `ai.tool.duration_ms` | duration | `{tool, platform, team_id, project_id}` | From `ToolCallRecord.durationMs` |
| `ai.tool.success` | `0` or `1` | `{tool, platform, team_id, project_id}` | `record.success ? 1 : 0` |
| `ai.mcp.proxy_request_count` | `1` | `{server, method}` | Incremented per proxy discovery request |
| `ai.mcp.proxy_request_duration_ms` | duration | `{server}` | From `ProxyRequestRecord.durationMs` |

Source: `src/transport/nr-ingest.ts` — `ingestToolCall()`, `ingestProxyRequest()`

### MCP Server — Session Gauges

Emitted every 60 seconds (on the metric harvest cadence) with current session state.

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.session.duration_ms` | duration | — | `SessionTracker.getMetrics().sessionDurationMs` |
| `ai.session.unique_files_read` | count | — | Size of internal Set of file paths from Read calls |
| `ai.session.unique_files_written` | count | — | Size of internal Set of file paths from Write/Edit calls |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`

### MCP Server — Proxy Gauges

Emitted every 60 seconds alongside session gauges (only when proxy mode is active).

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.mcp.server_call_count` | count | `{server}` | Per-server total call count from `ProxyMetricsTracker` |
| `ai.mcp.server_latency_ms` | average ms | `{server}` | `sum(latencies) / count` per server |
| `ai.mcp.server_error_rate` | ratio (0-1) | `{server}` | `failedCount / totalCount` per server |
| `ai.mcp.proxy_overhead_ms` | average ms | — | `sum(overheadValues) / count` across all servers |
| `ai.mcp.tool_popularity` | count | `{tool, server}` | Per-tool per-server call count |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`, `src/metrics/proxy-metrics.ts`

### SDK Agent — Request Metrics *(nr-ai-agent now in `nr-ai-typescript-agent` repo)*

Recorded by `nr-ai-agent` for each wrapped SDK call.

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.request.duration` | duration ms | `{provider, model}` | From `AiRequestRecord.durationMs` |
| `ai.tokens.total` | token count | `{provider, model}` | From `AiRequestRecord.totalTokens` (only if > 0) |
| `ai.error` | `1` | `{provider, model, errorType}` | Incremented when request has an error |
| `ai.embedding.duration` | duration ms | `{provider, model}` | From `AiEmbeddingRecord.durationMs` (embeddings only) |

Source: `nr-ai-typescript-agent repo: src/agent.ts` — `ingestRequestRecord()`, `ingestEmbeddingRecord()`

### SDK Agent — Intelligence Metrics (Phase 4)

Recorded by the Phase 4 intelligence modules.

**Semantic Drift (Phase 4.1)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.drift.score` | cosine similarity (0–1) | `{feature}` | Similarity of current response embedding to baseline centroid |
| `ai.drift.centroid_distance` | distance | `{feature}` | Euclidean distance from centroid |
| `ai.drift.detected` | `0` or `1` | `{feature}` | `1` when similarity falls below `similarityThreshold` |

Source: `nr-ai-typescript-agent repo: src/intelligence/semantic-drift.ts`, `nr-ai-typescript-agent repo: src/agent.ts`

**Anomaly Detection (Phase 4.2)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.quality.anomaly_score` | composite score (0–1) | `{feature}` | Weighted z-score across structural (30%), application (50%), semantic (20%) signals |

Source: `nr-ai-typescript-agent repo: src/intelligence/anomaly-detection.ts`, `nr-ai-typescript-agent repo: src/agent.ts`

**Cost Forecasting (Phase 4.3)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.forecast.projected_monthly_cost_usd` | USD | — | 30-day linear regression projection |
| `ai.forecast.growth_rate_percent` | % | — | Month-over-month cost growth rate |
| `ai.forecast.confidence_interval_low` | USD | — | Lower bound of 95% confidence interval |
| `ai.forecast.confidence_interval_high` | USD | — | Upper bound of 95% confidence interval |
| `ai.forecast.projected_daily_cost_usd` | USD | — | Projected cost for the next day |
| `ai.forecast.budget_exceed_date` | epoch ms | — | Estimated date when monthly budget will be exceeded (only if budget configured) |

Source: `nr-ai-typescript-agent repo: src/intelligence/cost-forecasting.ts`, `nr-ai-typescript-agent repo: src/agent.ts`

**Cache Intelligence (Phase 4.4)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.cache.hit_rate` | ratio (0–1) | `{feature}` | Rolling average cache hit rate per feature (min 20 requests) |
| `ai.cache.cumulative_savings_usd` | USD | `{feature}` | Cumulative cost saved by cache hits |
| `ai.cache.roi` | ratio | `{feature}` | `cumulativeSavings / cacheCreationCost` |
| `ai.cache.efficiency_score` | score (0–1) | `{feature}` | Composite cache efficiency |

Source: `nr-ai-typescript-agent repo: src/intelligence/recommendations.ts`, `nr-ai-typescript-agent repo: src/agent.ts`

**Context Management (Phase 4)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.context.compression_ratio` | ratio | `{conversationId}` | Tokens kept / tokens before compression |
| `ai.context.tokens_removed` | count | `{conversationId}` | Tokens removed by context compression |

Source: `nr-ai-typescript-agent repo: src/agent.ts`

**Custom Instrumentation (Phase 4.7)**

| Metric Name | Value | Attributes | How Computed |
|-------------|-------|------------|--------------|
| `ai.custom.span.duration_ms` | duration ms | `{spanName}` | Duration of user-defined custom spans |

Source: `nr-ai-typescript-agent repo: src/api/custom-metrics.ts`

### Metric Aggregation

All metrics pass through the `MetricAggregator` before being sent. For each unique (name + attributes) combination, the aggregator computes:

| Derived Metric | NR Name | Type | How Computed |
|----------------|---------|------|--------------|
| Count | `{name}.count` | count | Number of `record()` calls |
| Sum | `{name}.sum` | count | Sum of all values |
| Min | `{name}.min` | gauge | Minimum value |
| Max | `{name}.max` | gauge | Maximum value |

Source: `src/shared/harvest/metric-aggregator.ts`

---

## Logs API

### Audit Log Entries

Every tool call produces a structured log entry sent to the NR Logs API.

| Field | Location | Type | Description |
|-------|----------|------|-------------|
| `timestamp` | top-level | number | Epoch milliseconds |
| `message` | top-level | string | Human-readable audit detail |
| `tool` | attributes | string | Tool name |
| `developer` | attributes | string | Developer identifier |
| `app_name` | attributes | string | Application name |
| `session_id` | attributes | string | Session identifier (if available) |
| `audit.action` | attributes | string | Action classification |
| `audit.security_alert` | attributes | boolean | Whether a security alert was triggered |
| `audit.file_path` | attributes | string | File path (if applicable) |
| `audit.command` | attributes | string | Command (if applicable) |
| `audit.severity` | attributes | string | Alert severity (if alert) |
| `audit.alert_type` | attributes | string | Alert type (if alert) |

Source: `src/transport/log-ingest.ts` — `auditRecordToLogEntry()`

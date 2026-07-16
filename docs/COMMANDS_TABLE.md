# NR AI Coding Observability: Preflight — MCP Commands Reference

Every MCP tool exposed by the `preflight`, what it returns, how it computes each finding, and which trackers it queries.

Tools are conditionally registered — each tool only appears when its required tracker dependencies are provided to `registerTools()`.

---

## Session Tools

### `nr_observe_health`

Check server health and connection status.

**Parameters:** None

**Returns:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "developer": "alice",
  "session_id": "uuid-string",
  "connected_at": "2026-06-03T10:00:00.000Z",
  "uptime_seconds": 3600,
  "hooks_installed": true,
  "setup_required": false
}
```

**Data source:** Server startup metadata

**How it works:** Returns the current server version, the resolved developer name, how long the server has been running (`uptime_seconds`), the current session ID, and the ISO timestamp of when the MCP connection was established. Use this to confirm the MCP server is responsive and to verify the expected developer identity is being used. When a hook-detection function is available (e.g. in a Claude Code environment), also reports `hooks_installed` and `setup_required` so the caller can detect an incomplete setup — for example, right after a Smithery-driven install that only wired up the MCP server — and prompt to call `nr_observe_install_hooks`. Both fields are omitted when hook detection isn't wired up for the current server mode.

**Requires:** Always available

Source: `src/tools/session-stats.ts`

---

### `nr_observe_install_hooks`

Install `PreToolUse` and `PostToolUse` monitoring hooks into `~/.claude/settings.json`, headlessly (no TTY required).

**Parameters:** None

**Returns:**

```json
{
  "status": "installed",
  "message": "Monitoring hooks installed at /Users/alice/.claude/settings.json. Restart Claude Code to activate tool monitoring.",
  "settings_path": "/Users/alice/.claude/settings.json"
}
```

**Data source:** Reads and writes `~/.claude/settings.json` directly

**How it works:** Call this when `nr_observe_health` reports `setup_required: true` — most commonly after installing Preflight via the Smithery MCP registry, which wires up the MCP server but has no mechanism to write Claude Code hooks. Returns `status: "already_installed"` if hooks are already present (no changes made), or `status: "error"` with a `message` if the settings file couldn't be written. Only touches hook configuration in `~/.claude/settings.json` — never modifies `~/.mcp.json`. A Claude Code restart is required after installation for monitoring to activate.

**Requires:** A headless installer wired into `ToolRegistrationOptions.headlessInstaller` (available in the standard MCP server startup path)

Source: `src/tools/session-stats.ts`

---

### `nr_observe_get_config`

Show the current server configuration with sensitive fields masked.

**Parameters:** None

**Returns:**

```json
{
  "mode": "cloud",
  "developer": "alice",
  "accountId": "12345",
  "licenseKeyMasked": "aabbccdd...NRAL",
  "nrApiKeyMasked": "NRAK-****",
  "region": "US",
  "storagePath": "/Users/alice/.newrelic-preflight",
  "dashboardUrl": "https://one.newrelic.com/dashboards/...",
  "configFilePath": "/Users/alice/.newrelic-preflight/config.json"
}
```

**Data source:** Server config at startup

**How it works:** Returns a sanitized snapshot of the active configuration. `licenseKeyMasked` shows the first 8 characters and last 4 characters only. `nrApiKeyMasked` shows the prefix only. Use this to diagnose misconfiguration (wrong region, unset developer name, unexpected mode) without exposing credentials.

**Requires:** Always available

Source: `src/tools/session-stats.ts`

---

### `nr_observe_get_session_stats`

Current session metrics snapshot.

**Parameters:** None

**Returns:**

```json
{
  "identity": {
    "developer": "alice",
    "teamId": "backend-team",
    "projectId": "my-app"
  },
  "session_trace_id": "uuid-string-or-null",
  "session_id": "string",
  "session_name": "my-project",
  "session_duration_ms": 0,
  "tool_calls": 0,
  "tool_calls_by_type": { "Read": 5, "Edit": 3 },
  "success_rate": 0.95,
  "failed_calls": 1,
  "unique_files_read": 12,
  "unique_files_modified": 4,
  "bash_commands_run": 7,
  "search_queries": 3,
  "avg_tool_duration_ms": 45
}
```

**Data source:** `SessionTracker`

**How each field is determined:**

- `identity.developer` — resolved developer name from config (normalised by `normalizeDeveloperName()`). Defaults to `"unknown"` when not configured. Use this to confirm at runtime which identity is being attached to NR events.
- `identity.teamId` / `identity.projectId` — team and project identifiers from config. `null` when not configured. `projectId` is auto-derived from the git remote URL when unset.
- `session_trace_id` — UUID generated at server startup via `randomUUID()`; threaded through every NR event, metric, and log entry emitted in this session. Use `WHERE session_id = '<value>'` in NRQL to query all telemetry for a single session. `null` if the server was started without trace ID support.
- `session_name` — display name derived from the working directory path at session start (e.g. the repo folder name). `null` if not available.
- `tool_calls` — running count incremented on each `recordToolCall()`
- `tool_calls_by_type` — per-tool-name counter map
- `success_rate` — `successCount / totalCount`
- `failed_calls` — count of records where `success === false`
- `unique_files_read` — size of Set collecting file paths from Read/Grep/Glob tools
- `unique_files_modified` — size of Set collecting file paths from Write/Edit tools
- `bash_commands_run` — count of Bash tool calls
- `search_queries` — count of Grep/Glob tool calls
- `avg_tool_duration_ms` — `sum(allDurations) / count(allDurations)` across all tools

**Requires:** `SessionTracker`

Source: `src/tools/session-stats.ts`

---

### `nr_observe_get_session_timeline`

Ordered list of recent tool calls.

**Parameters:**

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `last_n`  | number | 20      | Number of most recent tool calls to return |

**Returns:**

```json
{
  "timeline": [
    { "timestamp": "2026-04-21T10:30:00.000Z", "tool": "Read", "duration_ms": 30, "success": true }
  ]
}
```

**Data source:** `SessionTracker`

**How it works:** Returns the last N entries from `SessionTracker.getMetrics().toolCallTimeline`, converting timestamps to ISO format. The timeline is a FIFO array of all tool calls recorded in the session.

**Requires:** `SessionTracker`

Source: `src/tools/session-stats.ts`

---

## Cost Tools

### `nr_observe_report_tokens`

Self-report token usage for cost tracking. Called by Claude Code to report its own token consumption.

**Parameters:**

| Parameter               | Type   | Required | Description                                         |
| ----------------------- | ------ | -------- | --------------------------------------------------- |
| `input_tokens`          | number | Yes      | Input/prompt token count                            |
| `output_tokens`         | number | Yes      | Output/completion token count                       |
| `model`                 | string | Yes      | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `thinking_tokens`       | number | No       | Extended thinking token count                       |
| `cache_read_tokens`     | number | No       | Prompt cache read token count                       |
| `cache_creation_tokens` | number | No       | Prompt cache creation token count                   |

**Returns:**

```json
{
  "recorded": true,
  "cost_this_report_usd": 0.0042,
  "session_total_cost_usd": 0.15,
  "model": "claude-sonnet-4-20250514"
}
```

**Data source:** `CostTracker`

**How it works:**

1. Constructs a `TokenUsage` object from the reported counts
2. Calls `CostTracker.recordTokenUsage(usage, model)` which looks up per-token prices from the pricing table (`src/shared/pricing-data.ts`)
3. Cost breakdown: `inputCost = inputTokens * inputPricePerToken`, similarly for output, thinking, cache read, and cache creation tokens
4. Accumulates into session total and per-model totals
5. Returns both the cost for this specific report and the running session total

**Requires:** `CostTracker`

Source: `src/tools/cost-tools.ts`

---

### `nr_observe_get_cost_breakdown`

Session cost breakdown by task, model, and efficiency.

**Parameters:** None

**Returns:**

```json
{
  "total_usd": 0.52,
  "by_model": { "claude-sonnet-4-20250514": 0.4, "claude-haiku-4-5-20251001": 0.12 },
  "by_task": [{ "task_id": "task-001", "cost_usd": 0.25, "tokens_used": 15000 }],
  "cost_per_line_of_code": 0.003,
  "cost_per_file_modified": 0.065,
  "cost_per_million_tokens": 7.43,
  "tokens": { "input": 50000, "output": 20000, "thinking": 10000 }
}
```

**Data source:** `CostTracker`, `TaskDetector` (optional)

**How each field is determined:**

- `total_usd` — sum of all token cost reports in the session
- `by_model` — per-model accumulator updated on each `reportTokens` call
- `by_task` — maps `TaskDetector.getCompletedTasks()` to their `estimatedCostUsd` and `tokensUsed`
- `cost_per_line_of_code` — `totalCost / totalLinesChanged` (null if no lines changed)
- `cost_per_file_modified` — `totalCost / uniqueFilesWritten` (null if no files modified)
- `cost_per_million_tokens` — blended session rate: `(totalCost / totalTokens) * 1_000_000`, summed across input, output, thinking, cache-read, and cache-creation tokens (null if no tokens reported). Also emitted as the `ai.cost.per_million_tokens` NR metric, faceted by `model`.
- `tokens` — running totals by token type from all reports

**Requires:** `CostTracker`; `TaskDetector` for per-task breakdown

Source: `src/tools/cost-tools.ts`

---

## Workflow Tools

### `nr_observe_get_workflow_trace`

Complete tool call trace for a task with anti-pattern and efficiency analysis.

**Parameters:**

| Parameter | Type   | Default     | Description             |
| --------- | ------ | ----------- | ----------------------- |
| `task_id` | string | most recent | ID of the task to trace |

**Returns:**

```json
{
  "task_id": "task-001",
  "duration_ms": 45000,
  "estimated_cost_usd": 0.25,
  "tool_calls": [
    { "seq": 1, "tool": "Read", "target": "/src/index.ts", "duration_ms": 30, "success": true },
    {
      "seq": 2,
      "tool": "Bash",
      "target": "npm test",
      "duration_ms": 5000,
      "success": true,
      "exit_code": 0
    }
  ],
  "anti_patterns": [
    { "type": "thrashing", "file": "/src/index.ts", "iterations": 4, "suggestion": "..." }
  ],
  "efficiency_score": 0.82
}
```

**Data source:** `TaskDetector`, `AntiPatternDetector` (optional), `EfficiencyScorer` (optional)

**How it works:**

1. Finds the task by ID from `TaskDetector.getCompletedTasks()`, or uses the most recent completed task
2. Maps each tool call in the task to a sequenced trace entry with `filePath` or `command` as the target
3. If `AntiPatternDetector` is available, analyzes the task's tool call sequence for anti-patterns
4. If `EfficiencyScorer` is available, computes the task's efficiency score

**Requires:** `TaskDetector`

Source: `src/tools/workflow-tools.ts`

---

### `nr_observe_get_anti_patterns`

Detected anti-patterns for the most recent task.

**Parameters:** None

**Returns:**

```json
[
  {
    "type": "thrashing",
    "file": "/src/index.ts",
    "iterations": 4,
    "suggestion": "Consider a different approach"
  },
  {
    "type": "re_reading",
    "file": "/src/config.ts",
    "read_count": 5,
    "suggestion": "Cache file contents"
  }
]
```

**Data source:** `TaskDetector`, `AntiPatternDetector`

**Detection algorithms (5 pattern types):**

| Pattern             | How Detected                                                                                                     | Default Threshold            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Thrashing**       | Tracks `Edit/Write → Bash(test:FAIL)` cycles on the same file. Counts consecutive failures. Resets on test pass. | 3 consecutive failures       |
| **Re-reading**      | Counts `Read` calls per file path. Flags files read more than the threshold.                                     | 3 reads of same file         |
| **Stuck loop**      | Detects repeated `Bash` commands with identical arguments.                                                       | 3 identical commands         |
| **Blind editing**   | Counts consecutive `Edit/Write` calls without an intervening `Read` or test run.                                 | 3 edits without verification |
| **Over-delegation** | Counts `Agent` tool spawns in a single task.                                                                     | 3 agent spawns               |

Each detected pattern includes a `suggestion` field with a human-readable recommendation.

**Requires:** `TaskDetector`, `AntiPatternDetector`

Source: `src/tools/workflow-tools.ts`, `src/metrics/anti-patterns.ts`

---

### `nr_observe_get_efficiency_score`

Composite efficiency score for the most recent task and session average.

**Parameters:** None

**Returns:**

```json
{
  "latest": {
    "score": 0.82,
    "components": { "speed": 0.7, "correctness": 1.0, "autonomy": 0.9, "firstAttemptQuality": 0.6 },
    "task_id": "task-001",
    "timestamp": 1713700000000
  },
  "session_average": {
    "score": 0.78,
    "components": {
      "speed": 0.65,
      "correctness": 0.95,
      "autonomy": 0.85,
      "firstAttemptQuality": 0.7
    },
    "tasks_scored": 5
  }
}
```

**Data source:** `EfficiencyScorer`, `TaskDetector` (optional), `AntiPatternDetector` (optional)

**Scoring algorithm (4 equally-weighted components, each 0–1):**

| Component                 | Formula                                                          | Baseline                     |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| **Speed**                 | `linesChanged / (durationMs / 1000)` normalized against baseline | 1 line/second = 1.0          |
| **Correctness**           | `testsPassed / testsRun`                                         | 0.5 if no tests were run     |
| **Autonomy**              | `1 - (askedUserQuestions / toolCallCount)`                       | 1.0 if no questions asked    |
| **First-attempt quality** | `1 - (thrashIterations / 3)`, floored at 0                       | 1.0 if no thrashing detected |

Final score = weighted average of all four components, clamped to [0, 1].

**On-demand scoring:** When called, the handler scores any unscored completed tasks and always rescores the active task (since it grows over time). Session average is the mean score across all scored tasks.

**Requires:** `EfficiencyScorer`

Source: `src/tools/workflow-tools.ts`, `src/metrics/efficiency-score.ts`

---

### `nr_observe_report_feedback`

Record user quality feedback for a task.

**Parameters:**

| Parameter | Type   | Required | Description                                          |
| --------- | ------ | -------- | ---------------------------------------------------- |
| `quality` | string | Yes      | `"good"`, `"bad"`, or `"neutral"`                    |
| `notes`   | string | No       | Free-text notes about the task quality               |
| `task_id` | string | No       | Task ID to attach feedback to (default: most recent) |

**Returns:**

```json
{
  "recorded": true,
  "quality": "good",
  "task_id": "task-001",
  "timestamp": 1713700000000
}
```

**Data source:** `FeedbackCollector`

**How it works:** Records the feedback with a timestamp. The `FeedbackCollector` stores all feedback records in memory and can emit `ai.feedback.count` metrics (keyed by quality) via the `MetricAggregator`. Used to correlate efficiency metrics with perceived quality.

**Requires:** `FeedbackCollector`

Source: `src/tools/workflow-tools.ts`

---

## Cross-Session Tools

These tools query persisted session data from disk (`~/.newrelic-preflight/sessions/`). They are only registered when `SessionStore` and related analyzers are available.

### `nr_observe_get_session_history`

Paginated list of past sessions with summary metrics.

**Parameters:**

| Parameter   | Type   | Default | Description                                    |
| ----------- | ------ | ------- | ---------------------------------------------- |
| `since`     | string | —       | ISO date to filter from (e.g., `"2026-04-01"`) |
| `developer` | string | —       | Filter by developer name                       |
| `limit`     | number | 20      | Maximum sessions to return                     |

**Returns:**

```json
{
  "sessions": [
    {
      "session_id": "sess-abc",
      "developer": "alice",
      "start_time": "2026-04-21T10:00:00.000Z",
      "duration_ms": 300000,
      "tool_calls": 45,
      "efficiency_score": 0.82,
      "estimated_cost_usd": 0.35,
      "task_count": 3,
      "outcome": "completed",
      "model": "claude-sonnet-4-20250514"
    }
  ],
  "count": 1
}
```

**Data source:** `SessionStore`

**How it works:** Loads all session summary JSON files from `~/.newrelic-preflight/sessions/`, applies optional date and developer filters, returns the last N sessions ordered by start time.

**Requires:** `SessionStore`

Source: `src/tools/cross-session-tools.ts`

---

### `nr_observe_get_weekly_summary`

Weekly aggregate report with per-developer breakdown.

**Parameters:**

| Parameter | Type   | Default      | Description                                 |
| --------- | ------ | ------------ | ------------------------------------------- |
| `week`    | string | current week | ISO week (e.g., `"2026-W16"`) or `"latest"` |

**Returns:** JSON object with weekly aggregates including per-developer metrics, total cost, average efficiency, test pass rates, tool call counts, and anti-pattern tallies by type.

**Data source:** `WeeklySummaryGenerator`

**How it works:**

1. Resolves the target week (current ISO week if not specified or `"latest"`)
2. Loads or generates the weekly summary by aggregating all sessions in that week
3. Groups metrics by developer
4. Computes: average efficiency, total cost, test pass rates, tool call counts, anti-pattern counts

**Requires:** `WeeklySummaryGenerator`

Source: `src/tools/cross-session-tools.ts`

---

### `nr_observe_get_trends`

Metric trends over time, aggregated by ISO week.

**Parameters:**

| Parameter   | Type   | Default        | Description                                                   |
| ----------- | ------ | -------------- | ------------------------------------------------------------- |
| `metric`    | string | `"efficiency"` | `"efficiency"`, `"cost"`, `"task_success"`, or `"tool_calls"` |
| `developer` | string | —              | Filter by developer name                                      |
| `weeks`     | number | 8              | Number of weeks to include                                    |

**Returns:**

```json
{
  "metric": "efficiency",
  "weeks": 8,
  "data_points": [
    { "week": "2026-W14", "value": 0.72 },
    { "week": "2026-W15", "value": 0.78 }
  ]
}
```

**Data source:** `TrendAnalyzer`

**How each metric is aggregated per week:**

| Metric         | Aggregation                                           |
| -------------- | ----------------------------------------------------- |
| `efficiency`   | Mean of `efficiencyScore` across sessions in the week |
| `cost`         | Sum of `estimatedCostUsd` across sessions in the week |
| `task_success` | Mean of `taskSuccessRate` across sessions in the week |
| `tool_calls`   | Mean of `toolCallCount` across sessions in the week   |

**Requires:** `TrendAnalyzer`

Source: `src/tools/cross-session-tools.ts`

---

### `nr_observe_get_collaboration_profile`

Developer collaboration style profile with team comparison.

**Parameters:**

| Parameter   | Type   | Default     | Description    |
| ----------- | ------ | ----------- | -------------- |
| `developer` | string | `"unknown"` | Developer name |

**Returns:**

```json
{
  "developer": "alice",
  "classification": "Power User",
  "dimensions": {
    "specificity": 0.8,
    "autonomy": 0.9,
    "correctionRate": 0.1,
    "taskComplexity": 0.6
  },
  "session_count": 25,
  "team_comparison": { "specificity": 0.15, "autonomy": 0.1 }
}
```

**Data source:** `CollaborationProfiler`

**Dimension calculations:**

| Dimension           | How Computed                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| **Specificity**     | Estimated from tool call patterns and file modification specificity            |
| **Autonomy**        | `1 - (userCorrections / taskCount)` — how often the developer redirects the AI |
| **Correction rate** | `corrections / sessionCount` — frequency of course corrections                 |
| **Task complexity** | `(toolCallsPerTask * filesModifiedPerTask) / baseline`                         |

**Classification rules:**

| Classification | Rule                                       |
| -------------- | ------------------------------------------ |
| Power User     | specificity > 0.7 AND autonomy > 0.7       |
| Delegator      | specificity < 0.3 AND autonomy > 0.7       |
| Learning       | specificity < 0.3 AND correctionRate > 0.5 |
| Collaborative  | All others                                 |

Team comparison shows the delta between this developer's dimensions and the team average.

**Requires:** `CollaborationProfiler`

Source: `src/tools/cross-session-tools.ts`, `src/metrics/collaboration-profile.ts`

---

### `nr_observe_get_claudemd_impact`

Before/after impact analysis of the most recent CLAUDE.md change.

**Parameters:** None

**Returns:**

```json
{
  "change": { "file": "CLAUDE.md", "type": "modified", "timestamp": "2026-04-21T10:00:00.000Z" },
  "before": { "avgEfficiencyScore": 0.72, "avgCostUsd": 0.45, "sessionCount": 10 },
  "after": { "avgEfficiencyScore": 0.85, "avgCostUsd": 0.38, "sessionCount": 8 },
  "deltas": { "efficiencyScore": { "value": 0.13, "percentChange": 18.1 } },
  "context_tokens": 1250,
  "verdict": "Positive impact"
}
```

**Data source:** `ClaudeMdTracker`

**How it works:**

1. Detects CLAUDE.md changes by monitoring Write/Edit tool calls targeting `CLAUDE.md` or `.claude/` files
2. Partitions sessions into before/after windows around the change timestamp
3. Computes aggregate metrics for each window (average efficiency, cost, correction rate, tool calls per task, task success rate)
4. Calculates deltas with percent change
5. Estimates context token cost: `charCount * 0.25` (tokens-per-char heuristic)
6. Generates verdict: compares the top changed metrics — "Positive impact" if 2+ improved, "Negative impact" if 2+ degraded, "Mixed impact" otherwise

**Requires:** `ClaudeMdTracker`

Source: `src/tools/cross-session-tools.ts`, `src/metrics/claudemd-tracker.ts`

---

### `nr_observe_get_cost_per_outcome`

Cost attribution by outcome type with waste ratio and ROI estimate.

**Parameters:**

| Parameter | Type   | Default | Description                   |
| --------- | ------ | ------- | ----------------------------- |
| `since`   | string | —       | ISO date to filter tasks from |

**Returns:**

```json
{
  "outcome_distribution": {
    "bug_fix": { "count": 3, "totalCost": 0.45, "avgCost": 0.15 },
    "feature": { "count": 2, "totalCost": 0.8, "avgCost": 0.4 },
    "failed_attempt": { "count": 1, "totalCost": 0.2, "avgCost": 0.2 }
  },
  "waste_ratio": 0.12,
  "total_cost": 1.65,
  "total_tasks": 8,
  "roi_estimate": {
    "totalAiCost": 1.65,
    "estimatedHoursSaved": 12.5,
    "estimatedValueUsd": 937.5,
    "roi": 56718
  }
}
```

**Data source:** `CostPerOutcomeAnalyzer`, `TaskDetector`

**Outcome classification (priority order — first match wins):**

| Outcome          | Detection Rule                                                       |
| ---------------- | -------------------------------------------------------------------- |
| `failed_attempt` | Tests failed and never recovered within the task                     |
| `bug_fix`        | Sequence: test FAIL → Edit → test PASS                               |
| `feature`        | New files created (Write tool calls)                                 |
| `configuration`  | Only config files modified (`.json`, `.yaml`, `.yml`, `.toml`, etc.) |
| `documentation`  | Only `.md` files modified                                            |
| `investigation`  | Mostly Read/Grep/Glob calls with few or no modifications             |
| `refactor`       | Default — existing files modified, tests pass                        |

**ROI estimation:**

- Hours saved per outcome type: bug_fix=2h, feature=4h, refactor=1.5h, investigation=0.5h, configuration=0.5h, documentation=1h, failed_attempt=0h
- `estimatedValueUsd = hoursSaved * hourlyRate` (default: $75/hr)
- `roi = (estimatedValueUsd - totalAiCost) / totalAiCost * 100`
- `wasteRatio = failedAttemptCost / totalCost`

**Requires:** `CostPerOutcomeAnalyzer`, `TaskDetector`

Source: `src/tools/cross-session-tools.ts`, `src/metrics/cost-per-outcome.ts`

---

### `nr_observe_get_recommendations`

Personalized optimization recommendations from multiple analyzers.

**Parameters:**

| Parameter   | Type   | Default     | Description                       |
| ----------- | ------ | ----------- | --------------------------------- |
| `developer` | string | `"unknown"` | Developer name                    |
| `topN`      | number | —           | Maximum recommendations to return |

**Returns:**

```json
{
  "recommendations": [
    {
      "id": "abc123",
      "category": "cost",
      "priority": "high",
      "title": "Reduce failed attempts",
      "detail": "12% of your spend is on tasks that ultimately failed.",
      "evidence": "3 failed tasks totaling $0.20",
      "estimatedSavings": "$0.15/week"
    }
  ],
  "count": 5
}
```

**Data source:** `RecommendationEngine` (aggregates from multiple sub-analyzers)

**Recommendation categories and sources:**

| Category           | Source Analyzer          | Example                                |
| ------------------ | ------------------------ | -------------------------------------- |
| Cost optimization  | `CostPerOutcomeAnalyzer` | "Reduce failed attempts"               |
| Efficiency         | `TrendAnalyzer`          | "Speed is declining week-over-week"    |
| Prompt engineering | `PromptFeedbackEngine`   | "Multi-step tasks improve efficiency"  |
| CLAUDE.md          | `ClaudeMdTracker`        | "Update CLAUDE.md with task patterns"  |
| Model selection    | `TrendAnalyzer`          | "Consider switching to a faster model" |

Recommendations are deduplicated by ID (hash of title + category), sorted by priority (high > medium > low), and optionally limited to `topN`.

**Requires:** `RecommendationEngine`

Source: `src/tools/cross-session-tools.ts`, `src/metrics/recommendation-engine.ts`

---

### `nr_observe_get_personal_insights`

Narrative coaching report comparing this week's personal AI coding metrics against the developer's historical baseline. Generates highlights, regressions, streaks, and a top recommendation as plain English strings — no LLM call is made; narrative is built from template expressions over computed deltas.

**Parameters:** None

**Returns (when ≥ 2 weeks of history exist):**

```json
{
  "status": "ok",
  "developer": "alice",
  "generatedAt": 1747526400000,
  "weeksAnalyzed": 4,
  "highlights": ["Your efficiency score this week (78) is 8 points above your historical average."],
  "regressions": ["Cost per session this week ($0.62) is 35% above your average ($0.46)."],
  "streaks": ["Efficiency score has improved for 3 consecutive weeks. Keep it up."],
  "topRecommendation": "Review your longest sessions this week and identify which tasks could be broken into smaller, more focused sessions.",
  "thisWeek": {
    "weekId": "2026-W20",
    "totalCostUsd": 6.2,
    "avgCostPerSession": 0.62,
    "avgEfficiencyScore": 78,
    "antiPatternCount": 4,
    "antiPatternRate": 0.02,
    "sessionsCount": 10,
    "avgToolCallsPerSession": 20,
    "topAntiPattern": "stuck_loop"
  },
  "lastWeek": { "weekId": "2026-W19", "...": "same shape as thisWeek" },
  "baseline": { "weekId": "baseline", "...": "mean across all loaded weeks" }
}
```

**Returns (when fewer than 2 weeks exist):**

```json
{
  "status": "insufficient_data",
  "developer": "alice",
  "weeksAvailable": 1,
  "weeksRequired": 2,
  "message": "Need at least 2 weeks of session history to generate personal insights. Currently have 1. Keep using the AI coding assistant and check back next week."
}
```

**Data source:** `WeeklySummaryGenerator.loadRecentWeeks(8)` — pulls up to 8 weeks of `WeeklySummary` from disk, filters to the configured `developer`, and ignores weeks with zero sessions for that developer.

**How each section is determined:**

| Section             | Trigger                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `highlights`        | Efficiency ≥ 5 points above baseline; cost-per-session ≥ 15% below baseline; anti-pattern rate ≥ 20% below last week                                                                                                 |
| `regressions`       | Efficiency ≥ 5 points below baseline; cost-per-session ≥ 25% above baseline; anti-pattern rate ≥ 25% above baseline (with the dominant pattern named)                                                                |
| `streaks`           | ≥ 2 consecutive weeks of efficiency improvement, or ≥ 2 consecutive weeks of cost-per-session reduction (only when 3+ weeks of data exist)                                                                           |
| `topRecommendation` | First non-empty match against: anti-pattern spike → cost spike → efficiency drop → first regression. If no regressions: positive reinforcement when efficiency ≥ 70, otherwise a generic "maintain patterns" message |

`baseline` is the mean of each metric across all loaded weeks (up to 8). `topAntiPattern` in the baseline is the pattern that appears most frequently as the per-week top anti-pattern.

**Requires:** `WeeklySummaryGenerator` and a configured `developer` identity (registered conditionally — the tool is omitted when either is missing).

Source: `src/tools/cross-session-tools.ts`, `src/metrics/personal-coach.ts`

---

### `nr_observe_get_platform_comparison`

Side-by-side comparison of AI coding platforms on a given metric.

**Parameters:**

| Parameter | Type   | Default        | Description                                                                   |
| --------- | ------ | -------------- | ----------------------------------------------------------------------------- |
| `metric`  | string | `"efficiency"` | `"efficiency"`, `"cost"`, `"task_success"`, `"tool_calls"`, or `"error_rate"` |
| `weeks`   | number | 4              | Number of weeks to include                                                    |

**Returns:**

```json
{
  "metric": "efficiency",
  "weeks": 4,
  "platforms": {
    "claude-code": { "session_count": 20, "average": 0.78 },
    "cursor": { "session_count": 5, "average": 0.65 }
  }
}
```

**Data source:** `SessionStore`

**How each metric is computed per platform:**

| Metric         | Aggregation                                          |
| -------------- | ---------------------------------------------------- |
| `efficiency`   | Mean of `efficiencyScore` across platform's sessions |
| `cost`         | Mean of `estimatedCostUsd`                           |
| `task_success` | Mean of `taskSuccessRate`                            |
| `tool_calls`   | Mean of `toolCallCount`                              |
| `error_rate`   | Mean of `(1 - taskSuccessRate)`                      |

Sessions are grouped by platform (defaults to `"claude-code"` if not set). Only sessions within the lookback window are included.

**Requires:** `SessionStore`

Source: `src/tools/cross-session-tools.ts`

---

## Cost and Budget Tools

### `nr_observe_get_budget_status`

Current spend against configured session/daily/weekly budget caps.

**Parameters:** None

**Returns:**

```json
{
  "session": {
    "budgetUsd": 5.0,
    "spentUsd": 2.15,
    "remainingUsd": 2.85,
    "pctUsed": 43,
    "exceeded": false
  },
  "daily": {
    "budgetUsd": 10.0,
    "spentUsd": 4.32,
    "remainingUsd": 5.68,
    "pctUsed": 43,
    "exceeded": false
  },
  "weekly": {
    "budgetUsd": 50.0,
    "spentUsd": 18.9,
    "remainingUsd": 31.1,
    "pctUsed": 38,
    "exceeded": false
  }
}
```

**Data source:** `BudgetTracker`

**How it works:**

- Tracks cumulative spend per period (session, day, week)
- Compares against thresholds from config: `sessionBudgetUsd`, `dailyBudgetUsd`, `weeklyBudgetUsd`
- Returns `null` for any budget not configured
- Returns `exceeded: true` when spend >= budget

**Requires:** `BudgetTracker`

**Config fields:**

- `NEW_RELIC_AI_SESSION_BUDGET_USD` — session spend limit in USD
- `NEW_RELIC_AI_DAILY_BUDGET_USD` — daily spend limit in USD
- `NEW_RELIC_AI_WEEKLY_BUDGET_USD` — weekly spend limit in USD

Source: `src/tools/cost-tools.ts`

---

### `nr_observe_get_prompt_cache_health`

Cache hit rate, savings, and a concrete recommendation for improving cache efficiency. A high hit rate means more context is served cheaply from cache rather than priced as fresh input.

**Parameters:** None

**Returns:**

```json
{
  "status": "can_improve",
  "cache_hit_rate_pct": 42,
  "total_cache_read_tokens": 145000,
  "total_cache_creation_tokens": 12000,
  "total_savings_usd": 1.83,
  "recommendation": "Cache hit rate is 42%. To improve: place stable content (CLAUDE.md rules, recurring file reads) before variable content (user messages, dynamic tool results) in your prompts.",
  "data_quality": "self_reported"
}
```

**Data source:** `CostTracker`

**How each field is determined:**

- `status` — `no_cache_activity` when no cache tokens have been reported yet; otherwise `excellent` (hit rate ≥ 60%), `can_improve` (≥ 30%), or `needs_attention` (< 30%)
- `cache_hit_rate_pct` — `round(cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens) * 100)`; `null` when no cache tokens have been seen
- `total_cache_read_tokens` / `total_cache_creation_tokens` — running totals accumulated from every token report
- `total_savings_usd` — sum of `savingsFromCacheUsd` (cache-read discount vs. full input price) across all reports
- `recommendation` — status-specific guidance string that includes the actual hit-rate percentage
- `data_quality` — `self_reported` when at least one `reportTokens` call has been made this session, otherwise `estimated`

**Requires:** `CostTracker`

Source: `src/tools/cost-tools.ts`

---

### `nr_observe_get_cost_forecast`

Projects future spend based on current session burn rate.

**Parameters:** None

**Returns:**

```json
{
  "current_session": {
    "startTime": "2026-04-21T10:00:00.000Z",
    "elapsedMs": 3600000,
    "currentCostUsd": 0.45,
    "burnRateUsd_per_hour": 0.45
  },
  "projections": {
    "end_of_session": {
      "estimatedCostUsd": 0.9,
      "confidence": "medium",
      "basis": "Assumes 2-hour session"
    },
    "end_of_day": {
      "estimatedCostUsd": 2.7,
      "confidence": "low",
      "basis": "Assumes 6 more hours of coding today"
    },
    "end_of_week": {
      "estimatedCostUsd": 15.75,
      "confidence": "low",
      "basis": "Assumes 5 more days at current rate"
    }
  }
}
```

**Data source:** `CostTracker`, `BudgetTracker`, session start time

**How it works:**

1. Computes `burnRateUsd_per_hour = currentCostUsd / elapsedHours`
2. **End-of-session** projection: assumes typical 2-hour session, medium confidence
3. **End-of-day** projection: assumes remaining hours until midnight at current burn rate, low confidence
4. **End-of-week** projection: extrapolates 5 more days at current rate, low confidence
5. Confidence decreases with longer horizons due to variability in work patterns

**Requires:** `BudgetTracker`, `CostTracker`

Source: `src/tools/cost-tools.ts`

---

## Analytics Tools

### `nr_observe_get_context_efficiency`

Context window efficiency: unique vs. repeated file reads.

**Parameters:** None

**Returns:**

```json
{
  "uniqueFilesRead": 12,
  "totalReadOperations": 28,
  "repeatedReadCount": 16,
  "repeatedReadRatio": 0.57,
  "topRepeatedFiles": [
    { "file": "src/app.ts", "readCount": 5 },
    { "file": "src/utils.ts", "readCount": 3 }
  ],
  "estimatedWasteRatio": 0.57
}
```

**Data source:** `ContextWindowTracker`

**How it works:**

- Tracks every Read tool call and the file path accessed
- Counts how many times each file was read
- `repeatedReadCount` = sum of `(readCount - 1)` for files read > 1 time
- `repeatedReadRatio` = `repeatedReadCount / totalReadOperations`
- High ratio suggests the model is losing context and re-reading instead of retaining

**Requires:** `ContextWindowTracker`

Source: `src/tools/analytics-tools.ts`, `src/metrics/context-window-tracker.ts`

---

### `nr_observe_get_latency_percentiles`

Tool call latency: p50, p95, p99 per tool type.

**Parameters:** None

**Returns:**

```json
{
  "global": { "p50": 45, "p95": 280, "p99": 1200 },
  "by_tool": {
    "Read": { "p50": 25, "p95": 120, "p99": 450, "sample_count": 15 },
    "Edit": { "p50": 60, "p95": 320, "p99": 2100, "sample_count": 8 },
    "Bash": { "p50": 150, "p95": 800, "p99": 5000, "sample_count": 3 }
  }
}
```

**Data source:** `LatencyTracker`

**How it works:**

- Collects `durationMs` from every tool call
- Computes percentiles globally and per tool type
- Percentiles indicate typical (p50), slow (p95), and very slow (p99) performance
- Helps identify bottleneck tools

**Requires:** `LatencyTracker`

Source: `src/tools/analytics-tools.ts`, `src/metrics/latency-tracker.ts`

---

### `nr_observe_get_task_completion_rate`

Task lifecycle tracking: completed vs. in-progress vs. abandoned.

**Parameters:** None

**Returns:**

```json
{
  "detected_tasks": 8,
  "completed": 6,
  "in_progress": 1,
  "abandoned": 1,
  "completion_rate": 0.75,
  "avg_duration_ms": 480000,
  "avg_tool_calls_per_task": 12
}
```

**Data source:** `TaskCompletionTracker`

**How it works:**

- Uses `TaskDetector` output to identify task boundaries
- Tracks state transitions: new → in-progress → completed (or abandoned if work stops)
- `completion_rate` = `completed / (completed + abandoned)`
- Helps identify whether tasks are finishing successfully

**Requires:** `TaskCompletionTracker`, `TaskDetector`

Source: `src/tools/analytics-tools.ts`, `src/metrics/task-completion-tracker.ts`

---

### `nr_observe_get_model_usage`

Which AI model was used per request and cost-efficiency per model.

**Parameters:** None

**Returns:**

```json
{
  "model_distribution": {
    "claude-sonnet-4-6": {
      "request_count": 25,
      "total_cost": 0.42,
      "avg_cost": 0.017,
      "efficiency_score": 0.82
    },
    "claude-opus-4-7": {
      "request_count": 3,
      "total_cost": 0.18,
      "avg_cost": 0.06,
      "efficiency_score": 0.88
    }
  },
  "total_requests": 28,
  "total_cost": 0.6,
  "cost_per_request": 0.021
}
```

**Data source:** `ModelUsageTracker`

**How it works:**

- Tracks `model` field from each request (e.g., "claude-sonnet-4-6")
- Aggregates cost per model
- Computes `efficiency_score` for each model: `(completedTasks / failedAttempts) / (costPerRequest / averageCostPerRequest)`
- Helps identify cost-effectiveness of model choices

**Requires:** `ModelUsageTracker`

Source: `src/tools/analytics-tools.ts`, `src/metrics/model-usage-tracker.ts`

---

### `nr_observe_get_context_tracking`

Per-turn context window tracking: token growth, category breakdown (system/tools/user/assistant), fill percentage, and per-tool output contribution.

**Parameters:** None

**Returns:**

```json
{
  "turnCount": 6,
  "growth": {
    "startTokens": 4200,
    "currentTokens": 18500,
    "deltaTokens": 14300
  },
  "currentBreakdown": {
    "system": 3800,
    "tools": 11200,
    "user": 900,
    "assistant": 2600
  },
  "fillPercent": 9.25,
  "contextWindow": 200000,
  "toolContributions": [
    { "tool": "Read", "totalBytes": 48200, "estimatedTokens": 12050, "percentOfToolOutput": 61.4 }
  ]
}
```

**Data source:** `ContextTrackerRegistry`

**How it works:**

- Tracks token growth per turn (`recordTurn`) and per-tool output bytes (`recordToolCall`)
- Splits current context usage into system/tools/user/assistant categories via a byte/token-based estimate, not hardcoded proportions
- `fillPercent` is `currentInputTokens / contextWindow`, where `contextWindow` is resolved per-model
- With no `sessionId` argument, falls back to the most recently active tracker (single-active-session stdio server)

**Requires:** `ContextTrackerRegistry`

Source: `src/tools/analytics-tools.ts`, `src/metrics/context-tracker.ts`

---

### `nr_observe_get_cost_per_tool`

Cost attribution per tool type — approximate, based on turn-level token correlation.

**Parameters:** None

**Returns:**

```json
{
  "turns": [
    {
      "turnId": "turn-001",
      "startTime": 1713700000000,
      "endTime": 1713700005000,
      "toolCalls": ["Read", "Edit"],
      "inputTokens": 2000,
      "outputTokens": 500,
      "cacheReadTokens": 800,
      "model": "claude-sonnet-4-6",
      "estimatedCostUsd": 0.003,
      "costPerToolCall": 0.0015
    }
  ],
  "costByToolType": {
    "Read": { "totalCost": 0.012, "callCount": 15, "avgCost": 0.0008 },
    "Edit": { "totalCost": 0.025, "callCount": 8, "avgCost": 0.003 }
  },
  "totalAttributedCost": 0.042,
  "attributionRate": 0.85
}
```

**Data source:** `TurnCostAttributor`

**How it works:** Attributes token costs reported via `nr_observe_report_tokens` to the tool calls that occurred within the same conversation turn. Each turn's cost is split evenly across its tool calls, then aggregated by tool type. `attributionRate` is the fraction of total session cost that could be attributed (turns with no token report are excluded). Results are approximate — cost is correlated at the turn level, not the individual call level.

**Requires:** `TurnCostAttributor`

Source: `src/tools/session-stats.ts`, `src/metrics/turn-cost-attributor.ts`

---

### `nr_observe_get_turn_analysis`

Conversation turn analysis: groups tool calls by AI response, shows parallelism and turn patterns.

**Parameters:** None

**Returns:**

```json
{
  "totalTurns": 12,
  "avgToolsPerTurn": 2.4,
  "maxToolsPerTurn": 5,
  "avgTurnDurationMs": 1850,
  "avgParallelism": 1.8,
  "recentTurns": [
    {
      "turnId": "turn-012",
      "turnNumber": 12,
      "startTime": 1713700060000,
      "endTime": 1713700061850,
      "durationMs": 1850,
      "toolCalls": [
        {
          "toolName": "Read",
          "toolUseId": "toolu_001",
          "success": true,
          "durationMs": 30,
          "timestamp": 1713700060100
        }
      ],
      "toolCount": 3,
      "parallelism": 2,
      "uniqueTools": ["Read", "Bash"]
    }
  ],
  "turnsByToolCount": { "1": 4, "2": 3, "3": 3, "5": 2 }
}
```

**Data source:** `TurnTracker`

**How it works:** Groups tool calls into conversation turns — a turn is all tool calls issued between two consecutive AI responses. `parallelism` is the maximum number of tool calls running concurrently within the turn (detected from overlapping timestamps). `avgParallelism` > 1 indicates the AI is making parallel tool calls efficiently. `turnsByToolCount` shows the distribution of tools-per-turn across the session.

**Requires:** `TurnTracker`

Source: `src/tools/session-stats.ts`, `src/metrics/turn-tracker.ts`

---

### `nr_observe_get_git_efficiency`

Git workflow efficiency metrics: merge conflicts, aborted operations, force pushes, stale branch detection, and actionable suggestions.

**Parameters:** None

**Returns:**

```json
{
  "totalGitCommands": 24,
  "mergeConflicts": 1,
  "rebaseConflicts": 0,
  "abortedOperations": 0,
  "forcePushes": 0,
  "resetHards": 1,
  "discardedChanges": 0,
  "pullCount": 5,
  "pushCount": 3,
  "commitCount": 8,
  "branchOperations": 4,
  "conflictResolutionRate": 1.0,
  "avgConflictResolutionMs": 45000,
  "staleBranchPulls": 0,
  "gitCommandTimeline": [],
  "conflictHistory": [],
  "suggestions": [
    {
      "type": "merge_conflict_rate",
      "message": "Consider rebasing more frequently to reduce merge conflicts.",
      "severity": "medium"
    }
  ]
}
```

**Data source:** `GitEfficiencyTracker`

**How it works:** Classifies Bash tool calls that invoke `git` commands by inspecting the command string and output. Detects merge/rebase conflicts from command output patterns, flags force pushes and hard resets as risky operations, and identifies stale branch pulls (pulls that bring in a large number of incoming commits). `conflictResolutionRate` is the fraction of detected conflicts that were resolved rather than aborted. `suggestions` surfaces actionable recommendations when patterns exceed configured thresholds.

**Requires:** `GitEfficiencyTracker`

Source: `src/tools/session-stats.ts`, `src/metrics/git-efficiency-tracker.ts`

---

## Extended Analytics Tools

These tools expose deeper session-level analysis. They are always registered when the trackers are available (no cross-session store dependency).

### `nr_observe_get_retry_alerts`

Thrashing and retry detection alerts within a sliding window.

**Parameters:** None

**Returns:**

```json
{
  "alerts": [
    { "type": "repeated_failure", "input": "npm test", "occurrences": 4, "windowSize": 5 }
  ],
  "totalTokensWasted": 2400,
  "totalAlertsEmitted": 1
}
```

**Data source:** `RetryDetector`

**How it works:** Tracks repeated tool calls with identical or highly similar inputs (Levenshtein similarity ≥ 0.8) within a rolling window (default: 5 calls). Fires an alert when the same input appears 3+ times consecutively. `totalTokensWasted` estimates tokens consumed on redundant calls (`inputSize / 4`).

**Requires:** `RetryDetector`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/retry-detector.ts`

---

### `nr_observe_get_context_composition`

Per-turn token breakdown by category with context fill percentage and dominance alerts.

**Parameters:** None

**Returns:**

```json
{
  "currentFillPercent": 62.5,
  "currentBreakdown": {
    "systemPrompt": 8000,
    "conversationHistory": 45000,
    "toolResults": 12000,
    "injectedFiles": 10000
  },
  "turnCount": 12,
  "thresholdAlerts": [{ "fillPercent": 62.5, "threshold": 50, "turnIndex": 11 }],
  "dominanceAlerts": [],
  "history": []
}
```

**Data source:** `ContextCompositionTracker`

**How it works:** Receives per-turn token reports categorized as `systemPrompt`, `conversationHistory`, `toolResults`, or `injectedFiles`. Tracks fill percentage against the model's context window size. Fires threshold alerts when fill crosses 50%/75%/90% (configurable). Fires dominance alerts when a single category exceeds a configured fraction of total tokens.

**Requires:** `ContextCompositionTracker`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/context-composition-tracker.ts`

---

### `nr_observe_get_latency_decomposition`

Time split between LLM API calls, tool execution, and overhead — with p50/p95 percentiles for each component.

**Status: not currently functional.** Neither Claude Code hook events nor proxy mode observe the model-API-level timing this tool needs. It is not registered in `tools/list`; calling it directly by name returns an explanatory error.

**Parameters:** None

**Data source:** `LatencyDecompositionTracker` (implemented, correctly, but never fed — see `src/index.ts` for why)

---

### `nr_observe_get_decision_tree`

Decision branch analysis with reasoning extraction and failure chain post-mortem.

**Parameters:**

| Parameter     | Type    | Default | Description                                |
| ------------- | ------- | ------- | ------------------------------------------ |
| `post_mortem` | boolean | `false` | If true, return only failure-zone branches |

**Returns (full):**

```json
{
  "totalBranches": 24,
  "successRate": 0.79,
  "failurePoints": [
    { "index": 3, "reasoning": "Expected test to pass...", "action": "Bash", "outcome": "failure" }
  ],
  "longestFailureStreak": 3,
  "firstFailureIndex": 3
}
```

**Returns (post_mortem: true):**

```json
{
  "postMortem": [{ "index": 3, "reasoning": "...", "action": "Bash", "outcome": "failure" }]
}
```

**Data source:** `DecisionTracker`

**How it works:** Records a branch for each tool call with extracted reasoning (from assistant message preceding the call, up to 500 chars), the action taken, and the outcome (success/failure). Computes `successRate`, identifies the longest consecutive failure streak, and can filter to only failure branches for post-mortem debugging.

**Requires:** `DecisionTracker`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/decision-tracker.ts`

---

### `nr_observe_get_instruction_drift`

CLAUDE.md and system prompt change correlations with session outcomes.

**Parameters:** None

**Returns:**

```json
{
  "currentPromptHash": "a1b2c3d4",
  "uniquePromptVariants": 3,
  "variantStats": [
    { "hash": "a1b2c3d4", "sessionCount": 5, "avgSuccessRate": 0.82, "avgTokensPerSession": 45000 }
  ],
  "recentCorrelations": [
    { "fromHash": "old123", "toHash": "a1b2c3d4", "deltaSuccessRate": 0.08, "deltaTokens": -3000 }
  ],
  "currentVariantSessionCount": 5
}
```

**Data source:** `InstructionDriftTracker`

**How it works:** Hashes the system prompt / CLAUDE.md content at each session start. Groups sessions by prompt hash and computes per-variant averages (success rate, token usage, thrashing). When the prompt changes, emits a correlation record showing how outcomes shifted. Requires ≥3 sessions per variant before comparisons are surfaced.

**Requires:** `InstructionDriftTracker`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/instruction-drift-tracker.ts`

---

### `nr_observe_get_tool_selection_score`

Tool selection quality score with penalty breakdown for redundant reads, repeated failures, and unused large outputs.

**Parameters:** None

**Returns:**

```json
{
  "score": 0.87,
  "totalCalls": 42,
  "penalizedCalls": 5,
  "penalties": [
    { "tool": "Read", "file": "src/app.ts", "reason": "redundant_read", "penaltyWeight": 0.1 }
  ],
  "worstOffenders": [],
  "redundantReadCount": 3,
  "repeatedFailureCount": 2,
  "unusedOutputCount": 0
}
```

**Data source:** `ToolSelectionScorer`

**How it works:** Scores the full session tool call sequence. Penalizes: redundant reads (same file read again without intervening modification), repeated failures (same Bash command failed twice), and unused large outputs (tool returned a large response that was never referenced). Score 0–1 where 1 is perfect selection. `worstOffenders` lists the highest-penalty calls. See [Improving Your Tool Selection Score](ADVANCED.md#improving-your-tool-selection-score) for prompt-writing tips to reduce penalties.

**Requires:** `ToolSelectionScorer`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/tool-selection-scorer.ts`

---

### `nr_observe_get_quality_proxy`

Quality signal tracking: diff apply rate, test pass rate, self-correction count, and degradation detection.

**Parameters:** None

**Returns:**

```json
{
  "totalSignals": 18,
  "diffApplyRate": 0.92,
  "testPassRate": 0.75,
  "backtrackCount": 2,
  "selfCorrectionCount": 3,
  "qualityByTurnBucket": [],
  "degradationDetected": false,
  "events": []
}
```

**Data source:** `QualityProxyTracker`

**How it works:** Aggregates quality signals from tool call outcomes: Edit/Write success rate (diff apply), test pass/fail outcomes from Bash calls, backtrack detection (reverting to a previous file state), and self-corrections (re-editing a file shortly after a prior edit). Detects degradation when the trailing-window quality drops below a configured threshold.

**Requires:** `QualityProxyTracker`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/quality-proxy-tracker.ts`

---

### `nr_observe_get_api_failures`

API failure tracking: per-model reliability scorecards, tokens lost, throttle alerts, and mean time to recovery. **Limitation:** model-API-level failure data is not observable in Preflight's current architecture (neither Claude Code hook events nor proxy mode see raw model-API traffic) — this tool currently always returns empty/zero metrics, with `dataAvailable: false` and a `note` field explaining why.

**Parameters:** None

**Returns:**

```json
{
  "totalFailures": 3,
  "byErrorType": { "rate_limit": 2, "server_error": 1 },
  "byModel": {
    "claude-sonnet-4-6": {
      "totalRequests": 40,
      "failureCount": 2,
      "reliabilityScore": 0.95,
      "tokensLost": 8000,
      "estimatedCostLostUsd": 0.024,
      "meanTimeToRecoveryMs": 4200
    }
  },
  "bySessionPhase": { "early": 1, "mid": 2, "late": 0 },
  "totalTokensLost": 8000,
  "totalEstimatedCostLostUsd": 0.024,
  "meanTimeToRecoveryMs": 4200,
  "throttleAlerts": [],
  "recentFailures": []
}
```

**Data source:** `ApiFailureTracker`

**How it works:** Records every failed AI API call with its error type, model, token count, and timestamp. Computes per-model reliability scorecards (`failureCount / totalRequests`). Fires throttle alerts when rate-limit errors exceed a threshold (default: 3 within 10 minutes). Estimates tokens and cost lost on failed requests. MTTR is the average time from failure to next success per model.

**Requires:** `ApiFailureTracker`

Source: `src/tools/extended-analytics-tools.ts`, `src/metrics/api-failure-tracker.ts`

---

## Cross-Session and Team Tools

### `nr_observe_get_team_summary`

Aggregated AI coding cost and efficiency metrics for all developers in the configured team, queried via New Relic NRQL.

**Parameters:**

| Parameter | Type   | Default        | Description                                      |
| --------- | ------ | -------------- | ------------------------------------------------ |
| `since`   | string | `"7 days ago"` | Time window (e.g. `"7 days ago"`, `"1 day ago"`) |

**Returns:**

```json
{
  "teamId": "backend-team",
  "since": "7 days ago",
  "developers": [
    { "developer": "alice", "costUsd": 4.2, "efficiencyScore": 0.78, "antiPatterns": 3 },
    { "developer": "bob", "costUsd": 2.15, "efficiencyScore": 0.65, "antiPatterns": 7 }
  ],
  "totals": {
    "costUsd": 6.35,
    "developerCount": 2
  }
}
```

**Data source:** New Relic NerdGraph (NRQL queries against `Metric` and `AiAntiPattern` event types)

**How it works:**

1. Runs three parallel NRQL queries against NR via NerdGraph: cost sum, avg efficiency score, and anti-pattern count — all faceted by `developer` and filtered by `team_id`
2. Merges results by developer name
3. Returns error message (not stack trace) when `teamId` or `nrApiKey` is not configured

**Requires:** `teamId` and `nrApiKey` (`NEW_RELIC_API_KEY`) both configured

**Config fields:**

- `NEW_RELIC_AI_TEAM_ID` — a label you choose (e.g. `"platform-eng"`) to group your team's NR events. **Not** your NR account ID — pick any alphanumeric slug that identifies your team.
- `NEW_RELIC_API_KEY` — User API key (NRAK-...) for NerdGraph queries

Source: `src/tools/cross-session-tools.ts`

---

## Digest and Subscription Tools

### `nr_observe_subscribe_digest`

Register a Slack webhook URL to receive weekly AI coding cost and efficiency summaries.

**Parameters:**

| Parameter    | Type   | Required | Description                                                             |
| ------------ | ------ | -------- | ----------------------------------------------------------------------- |
| `webhookUrl` | string | Yes      | Slack incoming webhook URL (must start with `https://hooks.slack.com/`) |

**Returns:**

```json
{
  "ok": true,
  "message": "Webhook registered. Delivery is manual — call nr_observe_send_digest to send this week's digest."
}
```

**Data source:** Config file (`~/.newrelic-preflight/config.json`)

**How it works:**

1. Validates the webhook URL starts with `https://hooks.slack.com/`
2. Reads the existing config file (or starts with an empty object)
3. Writes `digestWebhookUrl` to the config file with `0o600` permissions

**Config fields:**

- `NEW_RELIC_AI_DIGEST_WEBHOOK_URL` — Slack incoming webhook endpoint
- `NEW_RELIC_AI_DIGEST_SCHEDULE` — cron expression for digest delivery (default: `"0 9 * * 1"`)

**Note:** Digest delivery is manual-only today. `digestSchedule`/`NEW_RELIC_AI_DIGEST_SCHEDULE` is stored for future use but nothing currently reads it to trigger a send — call `nr_observe_send_digest` on-demand (e.g. from an external cron job or CI schedule) to actually deliver a digest.

**Requires:** `configFilePath`

Source: `src/tools/cross-session-tools.ts`

---

### `nr_observe_unsubscribe_digest`

Remove the registered Slack webhook for weekly digests.

**Parameters:** None

**Returns:**

```json
{
  "ok": true,
  "message": "Webhook removed."
}
```

**Data source:** Config file (`~/.newrelic-preflight/config.json`)

**How it works:**

- Reads the existing config file
- Deletes `digestWebhookUrl` from the config and writes it back

**Requires:** `configFilePath`

Source: `src/tools/cross-session-tools.ts`

---

### `nr_observe_send_digest`

Generate the current weekly AI coding summary and POST it to the configured Slack webhook immediately.

**Parameters:** None

**Returns:**

```json
{
  "ok": true,
  "week": "2026-W20",
  "message": "Digest sent successfully."
}
```

**Data source:** `WeeklySummaryGenerator` + config file webhook URL

**How it works:**

1. Reads `digestWebhookUrl` from the config file at call time
2. Generates the current week's summary via `WeeklySummaryGenerator`
3. Formats a Slack Block Kit payload via `formatSlackDigest()`
4. POSTs the payload to the webhook URL

**Requires:** `configFilePath` + `WeeklySummaryGenerator`

Source: `src/tools/cross-session-tools.ts`

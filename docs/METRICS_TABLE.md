---
title: Metrics Reference
description: Every metric and event Preflight sends to New Relic, organized by delivery API and source package.
---

# NR AI Coding Observability: Preflight — Metrics Reference

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

## Schema Versioning

Every NR event type carries an `event_version` field (currently `1`). Within a version, changes are additive only: new attributes may appear, existing ones keep name and meaning. A rename, removal, or semantic change bumps the version. Consumers should tolerate unknown attributes and may branch on `event_version` in NRQL.

---

## Events API

### MCP Server Events

These events are emitted by the MCP server (`preflight`) when Claude Code or another IDE uses a tool.

#### `AiToolCall`

**What it is:** One record for each action your AI assistant takes, such as reading a file, running a command or editing code, with how long it took and whether it succeeded. It is the raw activity log behind most other Preflight data. Use it to see which tools the assistant leans on, find slow or failing calls, and drill into what happened in a specific session.

Emitted for every tool call captured by the hook collector.

| Field                 | Type    | Description                                                                                                                                                                                                                |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiToolCall"`                                                                                                                                                                                                      |
| `event_version`       | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                                                                                                                |
| `timestamp`           | number  | Unix epoch milliseconds                                                                                                                                                                                                    |
| `tool`                | string  | Tool name (e.g., `Read`, `Edit`, `Bash`, `Grep`)                                                                                                                                                                           |
| `tool_use_id`         | string  | Unique tool use identifier from the AI assistant                                                                                                                                                                           |
| `success`             | boolean | Whether the tool call succeeded                                                                                                                                                                                            |
| `developer`           | string  | Developer identifier                                                                                                                                                                                                       |
| `app_name`            | string  | Application name (default: `preflight`)                                                                                                                                                                                    |
| `session_id`          | string  | Session identifier (if available)                                                                                                                                                                                          |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not configured.                                                                                              |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                                                                                                                                 |
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                                       |
| `org_id`              | string  | Organization identifier (if configured)                                                                                                                                                                                    |
| `platform`            | string  | Platform attribution (default: `claude-code`)                                                                                                                                                                              |
| `duration_ms`         | number  | Tool call duration in milliseconds (if available)                                                                                                                                                                          |
| `error_type`          | string  | Error classes (if failed): `timeout` (no completion in 60s; Bash 11 min, Agent and Task 30 min), `rejected` (user rejected the permission prompt), `denied` (auto mode denied by policy), `interrupted` (user interrupted) |
| `error`               | string  | Error message (if failed)                                                                                                                                                                                                  |
| `input_size_bytes`    | number  | Size of tool input (if available)                                                                                                                                                                                          |
| `output_size_bytes`   | number  | Size of tool output (if available)                                                                                                                                                                                         |
| `input_hash`          | string  | Hash of tool input for deduplication (if available)                                                                                                                                                                        |
| `skill_name`          | string  | Skill whose run this call happened inside. A run opens on a named `Skill` call (which carries it too) or a `/<skill>` prompt and closes on the next prompt or the next skill. Redacted like other user-derived strings     |
| `skill_source`        | string  | How the run was opened: `tool` (Skill tool) or `slash` (prompt slash command)                                                                                                                                              |
| `skill_run_id`        | string  | One id per skill run; `uniqueCount(skill_run_id)` counts runs                                                                                                                                                              |
| `skill_parent_run_id` | string  | Only on a run opened while another was open (a skill invoked by a skill, a subagent skill inside the main run, or a skill run right after another in the same turn): that run's `skill_run_id`. One hop only               |
| `skillArgsLength`     | number  | Length of skill arguments (if available)                                                                                                                                                                                   |
| `*`                   | varies  | Tool-specific fields from input/output parsers (e.g., `filePath`, `command`, `exitCode`, `isTestCommand`, `bashCategory`, `bashLeading`, `bashDestructive`, `bashNetwork`)                                                 |

Source: `src/transport/nr-ingest.ts` — `toolCallToNrEvent()`

Bash tool calls additionally carry four classifier fields:

- `bashCategory` — one of `git`, `package-manager`, `test-runner`, `build`, `container`, `network`, `fs-op`, `search`, `custom-script`, `shell-other`
- `bashLeading` — the resolved leading argv0 (after sudo / env-var stripping)
- `bashDestructive` — `true` for recursive rm, force-push, dd, mkfs, drop/truncate, chmod 777, pipe-to-shell, etc. (`--force-with-lease` and `--force-if-includes` are NOT flagged)
- `bashNetwork` — `true` when the leading command is a network client (curl/wget/ssh/...)

Source: `src/hooks/bash-classifier.ts` — `classifyBash()`

#### `AiMcpToolCall`

**What it is:** A record of each tool call that Preflight's proxy forwarded to an upstream MCP server, with the upstream server's latency separated from the proxy's own overhead. Use it to see which MCP servers and tools your assistant relies on, find slow or unreliable servers, and confirm that proxying adds no noticeable delay.

Emitted for proxied tool calls (when the server forwards to upstream MCP servers).

| Field                 | Type    | Description                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiMcpToolCall"`                                                                                               |
| `event_version`       | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
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
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Time spent in proxy layer (if available)                                                                               |
| `error_type`          | string  | Error classification (if failed)                                                                                       |
| `request_size_bytes`  | number  | Request payload size (if available)                                                                                    |
| `response_size_bytes` | number  | Response payload size (if available)                                                                                   |

Source: `src/transport/nr-ingest.ts` — `proxyToolCallToNrEvent()`

#### `AiProxyRequest`

**What it is:** A record of each non-tool request the proxy handled, such as asking an upstream MCP server to list its tools or resources. Use it to see how often assistants discover capabilities and whether discovery is slow.

Emitted for non-tool proxy requests (discovery methods like `tools/list`, `resources/list`, `resources/read`).

| Field                 | Type    | Description                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiProxyRequest"`                                                                                              |
| `event_version`       | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
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
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Proxy layer overhead (if available)                                                                                    |
| `response_size_bytes` | number  | Response size (if available)                                                                                           |

Source: `src/transport/nr-ingest.ts` — `proxyRequestToNrEvent()`

#### `AiAuditEvent`

**What it is:** A security-focused record of what your assistant did, one per tool call, with the file path or command involved. Each record is labelled with the kind of action and flagged when it matches a risk rule, such as sensitive file access, destructive commands, external network requests or file deletion. Use it as an audit trail for compliance reviews and to work out what happened after an incident.

Emitted for every tool call as a security audit record.

| Field                  | Type    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`            | string  | Always `"AiAuditEvent"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `event_version`        | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `timestamp`            | number  | Unix epoch seconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `action`               | string  | Audit action: `FileRead`, `FileWrite`, `FileEdit`, `BashCommand`, `McpToolCall`, `AgentSpawn`, `Search`, `HookInstall`, or `Other`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tool`                 | string  | Tool name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `detail`               | string  | Human-readable description of the action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `developer`            | string  | Developer identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session_id`           | string  | Session identifier (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `agent_id`             | string  | Claude Code subagent id, from the hook payload's `agent_id`, which Claude Code documents as present only on calls made inside a subagent. Some installs have been observed never sending it, so when it is absent `ToolCallRecord.agentId` is backfilled by finding the call's `toolUseId` in the subagent transcripts, whose newest lines are read as the call's record arrives (see `SubagentAttributionIndex.attributeAtIntake()`). Absent for parent-session calls, and for a subagent call Claude Code had not yet written to the transcript when Preflight processed it.                                                                                                                                                                                                                              |
| `agent_type`           | string  | Agent type, from the hook payload's `agent_type`: the subagent's type (e.g. `"Explore"`) on a call made inside a subagent, or the session's own agent name (e.g. `"claude"`) on a parent-session call when Claude Code runs with `--agent` or the `agent` setting. Recent Claude Code sends it; when the payload omits it (some installs never send it) or sends one over 128 characters or with control characters, `ToolCallRecord.agentType` is backfilled once `agent_id` is known (see `agent-partition.ts`), from the subagent transcript's `agent-<id>.meta.json` sidecar (written at spawn) or, failing that, the parent's `Agent` tool call. Best-effort, with the same timing window as `agent_id`. A populated value does not mean the call came from a subagent; filter on `agent_id` for that. |
| `team_id`              | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `project_id`           | string  | Project identifier (derived from git remote or configured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `repo_url`             | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `org_id`               | string  | Organization identifier (if configured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `file_path`            | string  | File path involved (if applicable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `command`              | string  | Command executed (if applicable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `audit.security_alert` | boolean | Whether a security alert was triggered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `audit.severity`       | string  | Alert severity: `critical`, `high`, or `medium` (if alert)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `audit.alert_type`     | string  | Alert type: `destructive_command`, `sensitive_file`, `external_network`, or `file_deletion` (if alert)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Source: `src/security/audit-trail.ts` — `auditRecordToNrEvent()`

#### `SecurityAlert`

**What it is:** A flag raised when an audit record looks risky, with a severity and a plain-language description. Use it to alert on risky assistant behavior without querying every audit record.

Emitted only when a security alert is triggered (subset of audit events).

| Field           | Type   | Description                                                                                                            |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"SecurityAlert"`                                                                                               |
| `event_version` | number | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
| `timestamp`     | number | Unix epoch seconds                                                                                                     |
| `severity`      | string | `critical`, `high`, or `medium`                                                                                        |
| `alert_type`    | string | `destructive_command`, `sensitive_file`, `external_network`, or `file_deletion`                                        |
| `description`   | string | Human-readable alert description                                                                                       |
| `tool`          | string | Tool that triggered the alert                                                                                          |
| `developer`     | string | Developer identifier                                                                                                   |
| `session_id`    | string | Session identifier (if available)                                                                                      |
| `agent_id`      | string | Same as `AiAuditEvent.agent_id`.                                                                                       |
| `agent_type`    | string | Same as `AiAuditEvent.agent_type`, so a populated value does not by itself mean a subagent raised the alert.           |
| `team_id`       | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`    | string | Project identifier (derived from git remote or configured)                                                             |
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`        | string | Organization identifier (if configured)                                                                                |
| `file_path`     | string | File path (if sensitive file alert)                                                                                    |
| `command`       | string | Command (if destructive command alert)                                                                                 |

Security alert triggers:

- **`destructive_command`** (critical): `rm -rf` (any recursive flag combo), `git push --force` (but NOT `--force-with-lease` / `--force-if-includes`), `git clean -f` (any force form), `find -delete`, `DROP TABLE`, pipe-to-shell, etc. Detection is the OR of the bash classifier (`record.bashDestructive`) and the regex pattern list — defense in depth, neither layer alone is authoritative.
- **`sensitive_file`** (high): `.env`, `.pem`, `.key`, `credentials`, `secret`, `.ssh`, `.npmrc`, `.pypirc`, `password`, `token` (path-boundary anchored)
- **`external_network`** (medium): `curl`, `wget`, `nc`, `ssh` commands. Detection is the OR of the bash classifier (`record.bashNetwork`) and the regex pattern list.
- **`file_deletion`** (medium): `rm` or `unlink` in command position (start of line, after `;`, `&`, `|`, or `(`, optionally with `sudo`), OR-ed with the bash classifier's leading token (`record.bashLeading`), which also strips env-var prefixes. Anchoring keeps `git rm`, `npm rm`, `docker rm`, and quoted text like `echo "rm foo"` out of scope. Recursive forms match too but lose to `destructive_command` by severity.

Source: `src/security/audit-trail.ts` — `securityAlertToNrEvent()`

#### `AiCodingTask`

**What it is:** A summary of one logical piece of work, from the moment your assistant starts on a request to the moment it finishes, such as fixing a bug or adding a feature. Each record rolls up the files touched, lines changed, tests and builds run, tokens used and estimated cost, and classifies the outcome. Use it to see what the assistant accomplished and what it cost per task, and to compare effort across bug fixes, features and refactors.

Emitted when a task boundary is detected (a logical unit of work from task start to completion).

| Field                  | Type    | Description                                                                                                                   |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `eventType`            | string  | Always `"AiCodingTask"`                                                                                                       |
| `event_version`        | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                   |
| `timestamp`            | number  | Unix epoch milliseconds (task end time)                                                                                       |
| `task_id`              | string  | Unique task identifier                                                                                                        |
| `developer`            | string  | Developer identifier                                                                                                          |
| `app_name`             | string  | Application name                                                                                                              |
| `platform`             | string  | Platform attribution (default: `claude-code`)                                                                                 |
| `session_id`           | string  | Session identifier (if available)                                                                                             |
| `team_id`              | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set.        |
| `project_id`           | string  | Project identifier (derived from git remote or configured)                                                                    |
| `repo_url`             | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                          |
| `org_id`               | string  | Organization identifier (if configured)                                                                                       |
| `start_time`           | number  | Task start time (Unix epoch milliseconds)                                                                                     |
| `end_time`             | number  | Task end time (Unix epoch milliseconds)                                                                                       |
| `duration_ms`          | number  | Task duration in milliseconds                                                                                                 |
| `tool_call_count`      | number  | Total tool calls in the task                                                                                                  |
| `files_read`           | number  | Number of unique files read                                                                                                   |
| `files_modified`       | number  | Number of unique files modified                                                                                               |
| `lines_added`          | number  | Lines added across all edits                                                                                                  |
| `lines_removed`        | number  | Lines removed across all edits                                                                                                |
| `bash_commands_run`    | number  | Number of Bash tool calls                                                                                                     |
| `tests_run`            | number  | Number of test runs detected                                                                                                  |
| `tests_passed`         | boolean | Whether the last test run passed                                                                                              |
| `build_run`            | boolean | Whether a build was run                                                                                                       |
| `build_passed`         | boolean | Whether the last build passed                                                                                                 |
| `estimated_cost_usd`   | number  | Estimated token cost for the task (`0` when cost was never computed)                                                          |
| `cost_estimated`       | boolean | `true` when `estimated_cost_usd` was actually computed; `false` when defaulted to `0`                                         |
| `tokens_used`          | number  | Total tokens consumed in the task                                                                                             |
| `asked_user_questions` | number  | Number of questions asked to the user                                                                                         |
| `sub_agents_spawned`   | number  | Number of sub-agent spawns                                                                                                    |
| `outcome_type`         | string  | Task classification: `bug_fix`, `feature`, `refactor`, `investigation`, `configuration`, `documentation`, or `failed_attempt` |
| `model`                | string  | Model active when the task completed (e.g. `claude-sonnet-5`). Omitted when no token usage was ever reported.                 |

Source: `src/transport/nr-ingest.ts` — `codingTaskToNrEvent()`

#### `AiAntiPattern`

**What it is:** A wasteful working pattern found in a completed task, such as re-reading the same file or repeatedly editing a file while its tests keep failing, with a suggestion for avoiding it. Use it to find habits that waste tokens and time, and to see which patterns recur across developers or teams.

Emitted for each anti-pattern detected within a completed task.

| Field           | Type   | Description                                                                                                            |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"AiAntiPattern"`                                                                                               |
| `event_version` | number | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
| `timestamp`     | number | Unix epoch milliseconds (detection time)                                                                               |
| `type`          | string | Pattern type: `thrashing`, `re_reading`, `stuck_loop`, `blind_editing`, or `over_delegation`                           |
| `task_id`       | string | Task identifier where the pattern was detected                                                                         |
| `developer`     | string | Developer identifier                                                                                                   |
| `app_name`      | string | Application name                                                                                                       |
| `platform`      | string | Platform attribution                                                                                                   |
| `session_id`    | string | Session identifier (if available)                                                                                      |
| `team_id`       | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`    | string | Project identifier (if configured)                                                                                     |
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`        | string | Organization identifier (if configured)                                                                                |
| `suggestion`    | string | Human-readable remediation suggestion                                                                                  |
| `file`          | string | File involved (if applicable)                                                                                          |
| `command`       | string | Command involved (if applicable)                                                                                       |
| `iterations`    | number | Number of thrash/repeat iterations (if applicable)                                                                     |
| `read_count`    | number | Number of redundant reads (re_reading only)                                                                            |
| `repeat_count`  | number | Number of identical command repeats (stuck_loop only)                                                                  |
| `edit_count`    | number | Number of unverified edits (blind_editing only)                                                                        |
| `agent_count`   | number | Number of agent spawns (over_delegation only)                                                                          |

Source: `src/transport/nr-ingest.ts` — `antiPatternToNrEvent()`

#### `AiBudgetWarning`

**What it is:** A record written when spend crosses 50%, 80% or 100% of a budget you configured. Use it to alert before you overspend, and to see which periods or teams run hot.

Emitted when a configured budget threshold is crossed (50%, 80%, 100%).

| Field           | Type   | Description                                                                                                            |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"AiBudgetWarning"`                                                                                             |
| `event_version` | number | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
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
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`        | string | Organization identifier (if configured)                                                                                |

**Firing rules:**

- `50%` — first time spend reaches 50% of budget
- `80%` — first time spend reaches 80% of budget
- `100%` — first time spend reaches or exceeds 100% of budget

Each threshold fires only once per period; subsequent additions to spend do not re-fire.

Source: `src/transport/nr-ingest.ts`, `src/metrics/budget-tracker.ts`

#### `AiContextSnapshot`

**What it is:** A per-turn picture of how full the model's context window is, with an estimated split into system, tool, user and assistant content and the single largest tool contributor. Use it to find sessions nearing the limit and to spot the tool that adds the most to the context.

Emitted for each LLM turn when context-window tracking is enabled, capturing token breakdown by category.

| Field                   | Type   | Description                                                                                                            |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `eventType`             | string | Always `"AiContextSnapshot"`                                                                                           |
| `event_version`         | number | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                            |
| `timestamp`             | number | Unix epoch milliseconds                                                                                                |
| `developer`             | string | Developer identifier                                                                                                   |
| `appName`               | string | Application name (camelCase, same as `AiBudgetWarning`)                                                                |
| `session_id`            | string | Session identifier (if available)                                                                                      |
| `team_id`               | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`            | string | Project identifier (if configured)                                                                                     |
| `repo_url`              | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
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

#### `AiSubagentTurn`

**What it is:** The token usage and cost of each turn taken by a subagent, a helper your assistant delegates work to. Use it to see what delegated work costs, which is easy to miss when you look only at the main session.

Emitted for each subagent (`Task` tool) assistant turn observed by the subagent-watcher pipeline.

| Field                   | Type   | Description                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`             | string | Always `"AiSubagentTurn"`                                                                                                                                                                                                                                                                                                       |
| `event_version`         | number | Always `1`                                                                                                                                                                                                                                                                                                                      |
| `timestamp`             | number | Unix epoch milliseconds                                                                                                                                                                                                                                                                                                         |
| `agent_id`              | string | Identifier of the spawned subagent                                                                                                                                                                                                                                                                                              |
| `agent_type`            | string | The subagent's type (e.g. `"Explore"`), from its transcript's `agent-<id>.meta.json` sidecar, the hook payload's `agent_type` on one of its own tool calls, or, failing those, the parent's `Agent` tool call. Only on events built by `subagentTurnToNrEvent()`; omitted when none of these has been seen for this `agent_id`. |
| `parent_session_id`     | string | Session ID of the parent Claude Code session that spawned the subagent                                                                                                                                                                                                                                                          |
| `message_id`            | string | Identifier of the assistant message this turn corresponds to                                                                                                                                                                                                                                                                    |
| `model`                 | string | Model used for this turn (e.g. `claude-sonnet-4-5`). Declarative metadata, not redacted — needed stable for grouping in NR.                                                                                                                                                                                                     |
| `input_tokens`          | number | Input tokens for this turn                                                                                                                                                                                                                                                                                                      |
| `output_tokens`         | number | Output tokens for this turn                                                                                                                                                                                                                                                                                                     |
| `cache_creation_tokens` | number | Prompt cache creation tokens for this turn                                                                                                                                                                                                                                                                                      |
| `cache_read_tokens`     | number | Prompt cache read tokens for this turn                                                                                                                                                                                                                                                                                          |
| `reasoning_tokens`      | number | Extended-thinking/reasoning tokens for this turn                                                                                                                                                                                                                                                                                |
| `developer`             | string | Developer identifier                                                                                                                                                                                                                                                                                                            |
| `app_name`              | string | Application name                                                                                                                                                                                                                                                                                                                |
| `workflow_run_id`       | string | Workflow run this turn belongs to (if any). `subagentTurnToNrEvent()` sends empty string when absent; `subagentTokenEventToNrEvent()` omits the field entirely when absent.                                                                                                                                                     |
| `usd`                   | number | Computed USD cost for this turn (if cost computation has run for this turn)                                                                                                                                                                                                                                                     |
| `stop_reason`           | string | Model stop reason (if known)                                                                                                                                                                                                                                                                                                    |
| `team_id`               | string | User-defined team label from config. Omitted when `teamId` is not configured.                                                                                                                                                                                                                                                   |
| `project_id`            | string | Project identifier (derived from git remote or configured)                                                                                                                                                                                                                                                                      |
| `org_id`                | string | Organization identifier (if configured)                                                                                                                                                                                                                                                                                         |

Two builders produce this event type. `subagentTurnToNrEvent()` runs after `CostTracker.recordTokenUsage()` has computed the per-turn USD, and additionally includes `turn_uuid` (unique per-turn ID), `timestamp_ms` (duplicate of `timestamp`), and `schema_fingerprint` (source-JSONL schema fingerprint, if computed). `subagentTokenEventToNrEvent()` serializes the lighter storage-layer `SubagentTokenEvent` record before cost computation — it omits `usd`, `stop_reason`, `turn_uuid`, and `schema_fingerprint`. Both share the token-count and identity fields above, including `parent_session_id`; neither builder sends a separate resolved `session_id`.

Source: `src/transport/nr-ingest.ts` — `subagentTurnToNrEvent()`, `subagentTokenEventToNrEvent()`

#### `AiWorkflowRun`

**What it is:** A summary of one subagent run (an `Agent` tool call) or one script-driven workflow run: its status, duration and how many agents it started. Script-driven runs also carry total tokens and cost; runs started through the Agent tool do not, so use `AiSubagentTurn` for their cost. Use it to compare workflows and to find ones that are slow or failing.

Emitted once per completed workflow run — either a Claude Code `Agent`-tool-spawned run (`run_source: "agent_tool"`) or a script-driven run tracked by the on-disk `wf_*.json` watcher (`run_source: "script"`).

| Field             | Type   | Description                                                                                                                                               |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`       | string | Always `"AiWorkflowRun"`                                                                                                                                  |
| `event_version`   | number | Always `1`                                                                                                                                                |
| `timestamp`       | number | Unix epoch milliseconds (`started_at + duration_ms`, or `+ 0` on a script run with no duration yet)                                                       |
| `run_source`      | string | `"agent_tool"` or `"script"` — discriminates the two field sets below                                                                                     |
| `workflow_run_id` | string | Unique run identifier (`toolu_*` for agent_tool runs, `wf_<hex>-<hex>` for script runs)                                                                   |
| `developer`       | string | Developer identifier                                                                                                                                      |
| `app_name`        | string | Application name                                                                                                                                          |
| `status`          | string | Run status                                                                                                                                                |
| `started_at`      | number | Run start time (Unix epoch milliseconds)                                                                                                                  |
| `duration_ms`     | number | Run duration in milliseconds. Always present on `agent_tool` runs; omitted entirely (not `0`) on a `script` run whose on-disk rollup has no duration yet. |
| `team_id`         | string | User-defined team label (if configured)                                                                                                                   |
| `project_id`      | string | Project identifier (if configured)                                                                                                                        |
| `org_id`          | string | Organization identifier (if configured)                                                                                                                   |

`run_source: "agent_tool"` adds:

| Field               | Type    | Description                                                                                                                                                                                             |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_type`     | string  | Subagent type requested (empty string if none)                                                                                                                                                          |
| `agent_name`        | string  | Agent name (empty string if none)                                                                                                                                                                       |
| `agent_model`       | string  | Model the agent ran on (empty string if unknown)                                                                                                                                                        |
| `agent_description` | string  | **Redacted free text.** The user-supplied `Agent` tool prompt/description, passed through the same credential-pattern redaction as `AiToolCall.command`. User-authored — not a fixed/declarative value. |
| `run_in_background` | boolean | Whether the agent ran in background mode                                                                                                                                                                |
| `tool_call_count`   | number  | Tool calls made during the run                                                                                                                                                                          |
| `child_agent_count` | number  | Nested agent spawns during the run                                                                                                                                                                      |
| `exit_error`        | string  | Redacted exit/failure message (if the run ended in error)                                                                                                                                               |
| `session_id`        | string  | Resolved Claude Code session ID (if available)                                                                                                                                                          |

`run_source: "script"` adds:

| Field                        | Type    | Description                                                                                                        |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `workflow_name`              | string  | Declarative workflow name from the script's `meta.name` (author-declared, not redacted)                            |
| `parent_session_id`          | string  | Session ID that launched the script                                                                                |
| `default_model`              | string  | Default model configured for the run                                                                               |
| `agent_count`                | number  | Number of agents the run declared                                                                                  |
| `total_tokens`               | number  | Total tokens across all subagents (reconciled from subagent JSONL; falls back to the on-disk rollup total)         |
| `observed_phases`            | number  | Number of phases actually observed                                                                                 |
| `declared_parallel_widths`   | string  | JSON-encoded array of declared parallel widths per phase, e.g. `[3,"dynamic",6]`                                   |
| `incomplete`                 | boolean | Whether the run ended before completion                                                                            |
| `backfilled`                 | boolean | Whether this record was backfilled from a stale on-disk file rather than observed live                             |
| `task_id`                    | string  | Associated task ID (if any)                                                                                        |
| `declared_phases`            | number  | Declared phase count (if known)                                                                                    |
| `total_usd`                  | number  | Total computed cost in USD (if computed)                                                                           |
| `token_reconciliation_delta` | number  | `(rollup total − Σ subagent tokens) / rollup total`, in `[-1, +∞)` (if any subagent token data has been collected) |

Source: `src/transport/nr-ingest.ts` — `workflowRunToNrEvent()`, `scriptWorkflowRunToNrEvent()`

#### `AiObservabilityHealth`

**What it is:** Preflight's report on its workflow and subagent log watchers: how many files it is watching, how much it has read, and any parse errors or format changes (schema drift) it hit. It does not measure your coding sessions. Use it to check that telemetry is complete when numbers look low, or after an assistant update changes its log format.

Emitted by the workflow/subagent watcher pipeline to report its own health — files watched, parse errors, schema drift. Not a measurement of the AI coding session itself.

| Field                       | Type   | Description                                            |
| --------------------------- | ------ | ------------------------------------------------------ |
| `eventType`                 | string | Always `"AiObservabilityHealth"`                       |
| `event_version`             | number | Always `1`                                             |
| `timestamp`                 | number | Unix epoch milliseconds                                |
| `watcher`                   | string | Which watcher reported: `"workflow"` or `"subagent"`   |
| `files_watched`             | number | Number of files currently being watched                |
| `lines_read`                | number | Cumulative lines read                                  |
| `bytes_read`                | number | Cumulative bytes read                                  |
| `parse_errors`              | number | Cumulative parse errors                                |
| `schema_drifts`             | number | Cumulative detected schema drifts                      |
| `developer`                 | string | Developer identifier                                   |
| `app_name`                  | string | Application name                                       |
| `last_error_code`           | string | Error code of the most recent error (if any)           |
| `last_error_class`          | string | Error class of the most recent error (if any)          |
| `event`                     | string | Free-form event label (if set)                         |
| `dimension`                 | string | Dimension label (if set)                               |
| `fingerprint`               | string | Schema fingerprint associated with the report (if set) |
| `workflow_run_id`           | string | Associated workflow run (if set)                       |
| `cost_self_check_delta_pct` | number | Percent delta from a cost self-check (if computed)     |
| `team_id`                   | string | User-defined team label (if configured)                |
| `project_id`                | string | Project identifier (if configured)                     |
| `org_id`                    | string | Organization identifier (if configured)                |

Source: `src/transport/nr-ingest.ts` — `observabilityHealthToNrEvent()`

#### `AiRetryAlert`

**What it is:** A warning that your assistant seems stuck, either repeating nearly identical calls to the same tool or failing repeatedly with it across its last few calls, with an estimate of the tokens wasted. Use it to catch thrashing loops early.

Emitted when `RetryDetector` flags a thrashing pattern — the same tool call repeating with high similarity in a short window.

| Field           | Type   | Description                                                                                                                                                                        |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"AiRetryAlert"`                                                                                                                                                            |
| `timestamp`     | number | Unix epoch milliseconds                                                                                                                                                            |
| `tool_name`     | string | The tool being called repeatedly                                                                                                                                                   |
| `occurrences`   | number | Number of similar calls observed in the window                                                                                                                                     |
| `window_size`   | number | Size of the sliding detection window                                                                                                                                               |
| `similarity`    | number | Similarity score (0–1) between the repeated calls                                                                                                                                  |
| `tokens_wasted` | number | Estimated tokens wasted by the repeated calls                                                                                                                                      |
| `developer`     | string | Developer identifier                                                                                                                                                               |
| `app_name`      | string | Application name                                                                                                                                                                   |
| `platform`      | string | Originating platform (defaults to `"claude-code"`)                                                                                                                                 |
| `session_id`    | string | Resolved Claude Code session ID (if available). Sourced from the ingesting process's own `sessionTraceId`, not the alert's in-process `sessionId` — see the builder's doc comment. |
| `team_id`       | string | User-defined team label (if configured)                                                                                                                                            |
| `project_id`    | string | Project identifier (if configured)                                                                                                                                                 |
| `org_id`        | string | Organization identifier (if configured)                                                                                                                                            |

Unlike every other event type in this document, `AiRetryAlert` does not carry `event_version` — `retryAlertToNrEvent()` predates the `event_version` stamping pass and was missed by it.

Source: `src/transport/nr-ingest.ts` — `retryAlertToNrEvent()`

#### `AiTurnCost`

**What it is:** The token cost of each assistant turn, attributed down to the individual tool call (an even share of the turn) and, when a skill is running, to that skill. Where `AiToolCall` shows what the assistant did, this event shows what it cost. Use it to find which tools or skills drive spend, and join it to `AiToolCall` on `tool_use_id` for per-call detail.

Emitted for each tool call in an attributed turn, carrying the turn's cost and tokens split evenly across the calls, and once for each token report no tool call claimed (a response row). `tool_use_id` cross-references the call's `AiToolCall` row. Every call inside a skill run carries `skill_name`, so `sum(cost_usd) FACET skill_name` is the full cost of the work each skill drove.

| Field                   | Type   | Description                                                                                                                                            |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventType`             | string | Always `"AiTurnCost"`                                                                                                                                  |
| `event_version`         | number | Always `1`                                                                                                                                             |
| `timestamp`             | number | Unix epoch milliseconds. On a tool row, when the turn's last tool call ended; on a response row, when the response was written                         |
| `turn_id`               | string | Unique identifier for the turn (fresh UUID minted at cost close); groups all rows from one turn                                                        |
| `tool_use_id`           | string | Joins to `AiToolCall.tool_use_id`. Absent on response rows                                                                                             |
| `tool`                  | string | Tool name (e.g., `"Read"`, `"Skill"`). Absent on response rows                                                                                         |
| `skill_name`            | string | Skill whose run this call happened inside (see `AiToolCall` below)                                                                                     |
| `skill_source`          | string | `tool` or `slash`, as on `AiToolCall`                                                                                                                  |
| `skill_run_id`          | string | One id per skill run, as on `AiToolCall`                                                                                                               |
| `skill_parent_run_id`   | string | As on `AiToolCall`                                                                                                                                     |
| `cost_usd`              | number | This call's share of the turn's cost (turn total ÷ call count); the whole response's cost on a response row                                            |
| `input_tokens`          | number | This call's share of the turn's input tokens (fractional)                                                                                              |
| `output_tokens`         | number | This call's share of the turn's output tokens (fractional)                                                                                             |
| `cache_read_tokens`     | number | This call's share of cache-read tokens (fractional)                                                                                                    |
| `cache_creation_tokens` | number | This call's share of cache-creation tokens (fractional)                                                                                                |
| `turn_cost_usd`         | number | The full turn's cost (identical on all rows from one turn)                                                                                             |
| `turn_tool_call_count`  | number | The number of calls in this turn (identical on all rows from one turn); `0` on a response row                                                          |
| `model`                 | string | Model used to generate the turn's response                                                                                                             |
| `developer`             | string | Developer identifier                                                                                                                                   |
| `app_name`              | string | Application name                                                                                                                                       |
| `platform`              | string | Originating platform (defaults to `"claude-code"`). On a response row, the token report's source platform, else the session's last stamped tool call's |
| `session_id`            | string | Resolved Claude Code session ID (if available). Precedence: `attribution.sessionId` > `sessionTraceId`; omitted when both are null                     |
| `team_id`               | string | User-defined team label (if configured)                                                                                                                |
| `project_id`            | string | Project identifier (if configured)                                                                                                                     |
| `org_id`                | string | Organization identifier (if configured)                                                                                                                |
| `cost_authority`        | string | `"external"` only when `companionMode` is true and `platform === 'claude-code'`; omitted otherwise                                                     |

Rows come in two shapes. A tool row has `tool` and `tool_use_id` and measures the usage of the model response that followed the turn, split evenly across the turn's calls, the same approximation `nr_observe_get_cost_per_tool` reports. A response row has `turn_tool_call_count: 0` and no `tool`, `tool_use_id`, or `skillName`. It is a token report no tool call claimed, such as the first response after a prompt (the one that asks for the tools) or a text-only reply, and carries that response's whole cost. `sum(cost_usd)` now covers every main-agent response, so per-tool queries need `WHERE tool IS NOT NULL`. Rows come from watcher-sourced token events only, never from `nr_observe_report_tokens` calls. Every row of a turn shares the turn's end `timestamp`, so a timeseries of this event spikes at turn boundaries rather than tracing per-call timing. Replayed token events are deduplicated by `(session_id, message_id)` before attribution, so a turn closes once and produces its rows once.

Source: `src/transport/nr-ingest.ts` — `turnCostToNrEvents()` and `ingestTurnCost()`

#### `AiSkillRun`

**What it is:** One record each time a skill run starts, whether the assistant loads a skill itself or you start one with a `/<skill>` prompt. It is the only record of a run that made no tool calls. Use it to count skill runs, adoption and users, including text-only runs that leave no `AiToolCall` rows.

Emitted once, when a skill run opens, for every run. A run opens on a named `Skill` call or on a `/<skill>` prompt. A `slash` run is any prompt Claude Code receives that starts with `/`, so it also covers built-in commands that send a prompt to the model, such as `/init`. Built-ins Claude Code handles locally (`/clear`, `/compact`, `/context`, `/cost`) and unknown commands never reach Preflight. A run whose replies made no tool calls has no `AiToolCall` or `AiTurnCost` rows, so this event is what counts it. Runs are counted across both event types with `FROM AiToolCall, AiSkillRun SELECT uniqueCount(skill_run_id)`. The event carries no tool, duration, or cost data. Those stay on `AiToolCall` and `AiTurnCost`, which carry the same `skill_run_id`.

| Field                 | Type   | Description                                                                                                        |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `eventType`           | string | Always `"AiSkillRun"`                                                                                              |
| `event_version`       | number | Always `1`                                                                                                         |
| `timestamp`           | number | Unix epoch milliseconds when the run opened (the `Skill` call's record time, or the prompt's time for a slash run) |
| `skill_name`          | string | Skill whose run this is (redacted, as on `AiToolCall`)                                                             |
| `skill_source`        | string | `tool` or `slash`                                                                                                  |
| `skill_run_id`        | string | One id per run; matches `skill_run_id` on the run's `AiToolCall` and `AiTurnCost` rows                             |
| `skill_parent_run_id` | string | The run that was open when this one started; absent when none was                                                  |
| `developer`           | string | Developer identifier                                                                                               |
| `app_name`            | string | Application name                                                                                                   |
| `platform`            | string | Originating platform of the `Skill` call; `"claude-code"` for a `/<skill>` prompt or a call with none              |
| `session_id`          | string | Session the run belongs to; falls back to the engine's session when the run has none                               |
| `team_id`             | string | User-defined team label (if configured)                                                                            |
| `project_id`          | string | Project identifier (if configured)                                                                                 |
| `org_id`              | string | Organization identifier (if configured)                                                                            |

Source: `src/transport/nr-ingest.ts` — `skillRunToNrEvent()` and `ingestSkillRun()`

### Setup Validation

#### `NrAiObserveSetupCheck`

**What it is:** A test event the setup wizard sends to New Relic each time it validates your license key, to confirm that the key works and data can reach New Relic. It carries only a `setupCheck` flag and measures nothing, so you can ignore it in dashboards.

A one-shot license-key validation ping, sent with a direct `fetch()` call to the NR Events API — it bypasses the `HarvestScheduler` entirely, so the flush-interval and retry-buffer behavior in [Delivery Mechanism](#delivery-mechanism) does not apply to it. Carries no session, developer, or file data.

| Field        | Type    | Description                      |
| ------------ | ------- | -------------------------------- |
| `eventType`  | string  | Always `"NrAiObserveSetupCheck"` |
| `setupCheck` | boolean | Always `true`                    |

Source: `src/install/key-validator.ts` — `validateLicenseKey()`

---

## Metric API

### MCP Server — Per-Call Metrics

Recorded for each tool call as it happens.

| Metric Name                        | Value      | Attributes                                                           | How Computed                                                                                                                                                                                                                                                                                                                                   | What it tells you                                                                                                                                                                 |
| ---------------------------------- | ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.tool.call_count`               | `1`        | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}`     | Incremented once per tool call                                                                                                                                                                                                                                                                                                                 | How many tool calls the assistant made. Chart it as a rate to see activity over time.                                                                                             |
| `ai.tool.duration_ms`              | duration   | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}`     | From `ToolCallRecord.durationMs`                                                                                                                                                                                                                                                                                                               | How long each tool call took, in milliseconds, when a duration was recorded. Use it to spot slow tools.                                                                           |
| `ai.tool.success`                  | `0` or `1` | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}`     | `record.success ? 1 : 0`                                                                                                                                                                                                                                                                                                                       | Whether each call succeeded (`1`) or failed (`0`). Average it for a success rate by tool.                                                                                         |
| `ai.bash.call_count`               | count      | `{category, session_id?, team_id?, project_id?, org_id?, repo_url?}` | Per-`bashCategory` call count for Bash tool calls (e.g. `git`, `test-runner`, `build`). **Local-only — not currently exported to New Relic**, despite this row's history: it is computed by `SessionTracker.emitMetrics()`, but the harvest loop never calls that method — see [Local-only Metrics](#local-only-metrics-defined-not-exported). | Local-only: how many shell commands ran, by kind (for example `git` or `test-runner`). Visible in the local dashboard and MCP tools, not in New Relic.                            |
| `ai.mcp.proxy_request_count`       | `1`        | `{server, method}`                                                   | Incremented per proxy discovery request                                                                                                                                                                                                                                                                                                        | How many discovery requests (tool and resource listing, resource reads) the Preflight proxy handled for upstream MCP servers. Tool calls are not counted here.                    |
| `ai.mcp.proxy_request_duration_ms` | duration   | `{server}`                                                           | From `ProxyRequestRecord.durationMs`                                                                                                                                                                                                                                                                                                           | How long each discovery request took, in milliseconds, including proxy overhead. Use it to find slow upstream MCP servers. For tool-call latency, see `ai.mcp.server_latency_ms`. |

Source: `src/transport/nr-ingest.ts` — `ingestToolCall()`, `ingestProxyRequest()`

### MCP Server — Session Gauges

Emitted every 60 seconds (on the metric harvest cadence) with current session state.

| Metric Name                       | Value    | Attributes                                                 | How Computed                                             | What it tells you                                                                                            |
| --------------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ai.session.duration_ms`          | duration | `{session_id?, team_id?, project_id?, org_id?, repo_url?}` | `SessionTracker.getMetrics().sessionDurationMs`          | How long the session has been running, in milliseconds.                                                      |
| `ai.session.unique_files_read`    | count    | `{session_id?, team_id?, project_id?, org_id?, repo_url?}` | Size of internal Set of file paths from Read calls       | How many different files the assistant has read this session. A rough measure of how much code it explored.  |
| `ai.session.unique_files_written` | count    | `{session_id?, team_id?, project_id?, org_id?, repo_url?}` | Size of internal Set of file paths from Write/Edit calls | How many different files the assistant has changed this session. A rough measure of the size of its changes. |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`

### MCP Server — Proxy Gauges

Emitted every 60 seconds alongside session gauges (only when proxy mode is active).

| Metric Name                | Value       | Attributes                                                  | How Computed                                                    | What it tells you                                                                                      |
| -------------------------- | ----------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ai.mcp.server_call_count` | count       | `{server, team_id?, project_id?, org_id?, repo_url?}`       | Per-server total call count from `ProxyMetricsTracker`          | How many calls each upstream MCP server has received. Shows which servers are used most.               |
| `ai.mcp.server_latency_ms` | average ms  | `{server, team_id?, project_id?, org_id?, repo_url?}`       | `sum(latencies) / count` per server (only emitted if count > 0) | Average response time of each upstream MCP server, in milliseconds. Use it to find slow servers.       |
| `ai.mcp.server_error_rate` | ratio (0-1) | `{server, team_id?, project_id?, org_id?, repo_url?}`       | `failedCount / totalCount` per server (only emitted if > 0)     | Share of each server's calls that failed, from 0 to 1. Use it to find unreliable servers.              |
| `ai.mcp.proxy_overhead_ms` | average ms  | `{team_id?, project_id?, org_id?, repo_url?}`               | `sum(overheadValues) / count` across all servers (only if > 0)  | Average time the Preflight proxy adds to a call, in milliseconds. Use it to confirm proxying is cheap. |
| `ai.mcp.tool_popularity`   | count       | `{tool, server, team_id?, project_id?, org_id?, repo_url?}` | Per-tool per-server call count (capped at 100 combinations)     | How many times each tool on each server has been called. Shows which tools matter most.                |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`, `src/metrics/proxy-metrics.ts`

### MCP Server — Cost Metrics

Emitted every 60 seconds alongside session gauges (only when a `CostTracker` is wired in, and not when `companionMode` is enabled). All metrics include `{developer, session_id?, team_id?, project_id?, org_id?, repo_url?}` attributes plus `{model?, provider?}` when a current model is known — `provider` (`anthropic`/`google`/`openai`/`mistral`/`cohere`/`bedrock`) is derived from `model` via `classifyProvider()`.

| Metric Name                      | Value | How Computed                                                                                     | What it tells you                                                                                                                                 |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.cost.session_total_usd`      | USD   | Cumulative session cost across all token reports                                                 | Total estimated spend for the session so far, in US dollars.                                                                                      |
| `ai.cost.tokens_input`           | count | Cumulative input tokens                                                                          | Input tokens sent to the model this session.                                                                                                      |
| `ai.cost.tokens_output`          | count | Cumulative output tokens                                                                         | Output tokens the model generated this session.                                                                                                   |
| `ai.cost.tokens_thinking`        | count | Cumulative extended thinking tokens                                                              | Extended-thinking tokens the model used this session.                                                                                             |
| `ai.cost.tokens_cache_read`      | count | Cumulative prompt cache read tokens                                                              | Tokens served from the prompt cache this session. Higher values mean cheaper, faster repeated context.                                            |
| `ai.cost.tokens_cache_creation`  | count | Cumulative prompt cache creation tokens                                                          | Tokens written into the prompt cache this session. Compare it with `ai.cost.tokens_cache_read` to judge whether caching is paying off.            |
| `ai.cost.cache_savings_usd`      | USD   | Cumulative savings from cache reads versus the full input price                                  | How much money the prompt cache has saved this session, in US dollars.                                                                            |
| `ai.cost.cost_per_line_of_code`  | USD   | `session_total_usd / total_lines_changed` (only if > 0)                                          | Session spend divided by lines changed. A rough cost-per-output figure, emitted once something has changed.                                       |
| `ai.cost.cost_per_file_modified` | USD   | `session_total_usd / unique_files_written` (only if > 0)                                         | Session spend divided by files changed. Emitted once a file has been written.                                                                     |
| `ai.cost.report_count`           | count | Number of token reports received                                                                 | How many exact token-usage reports Preflight has received.                                                                                        |
| `ai.cost.estimation_count`       | count | Number of cost estimation calls                                                                  | How many times tokens were guessed from text size (about 4 characters per token) instead of reported. High values mean less precise cost figures. |
| `ai.cost.subagent_usd`           | USD   | Cumulative cost of token reports attributed to a subagent                                        | The part of session spend caused by subagents, the helpers your assistant delegates work to.                                                      |
| `ai.cost.parent_usd`             | USD   | Cumulative cost of token reports not attributed to a subagent                                    | The part of session spend caused by the main assistant. Add it to `ai.cost.subagent_usd` to get the session total.                                |
| `ai.cost.unpriced_calls`         | count | Per-model count of calls that used tokens but had no known price. Attributes: `{model}`          | Calls whose cost could not be priced, so they are missing from the spend totals. Use it to spot models Preflight has no price for.                |
| `ai.cost.estimated_calls`        | count | Per-model count of calls priced with another model's rates. Attributes: `{model, estimatedFrom}` | Calls priced with another model's rates (named in `estimatedFrom`) because the model's own price is unknown, so the spend is approximate.         |

Source: `src/metrics/cost-tracker.ts` — `emitMetrics()`

### MCP Server — Efficiency Metrics

Emitted every 60 seconds alongside session gauges (only when an `EfficiencyScorer` is wired in and has scored at least one task). Each scored task is recorded once, and again only if its score is later updated. Values are per task, not cumulative. Attributes: `{developer, session_id?, team_id?, project_id?, org_id?, repo_url?, model?, provider?}` — `model` is the model current on `costTracker` when the task was scored, and `provider` is derived from it via `classifyProvider()`.

| Metric Name                           | Value       | How Computed                        | What it tells you                                                                                                                                                            |
| ------------------------------------- | ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.efficiency.score`                 | score (0–1) | Composite efficiency score          | Overall efficiency of a scored task, from 0 to 1, as a weighted blend of the four scores below. Use it to track how well tasks go over time.                                 |
| `ai.efficiency.speed`                 | score (0–1) | Speed component of efficiency       | How fast the task changed code, from 0 to 1 (1 line per second or faster scores 1). A task that changed no lines records 0 here, but speed is left out of its overall score. |
| `ai.efficiency.correctness`           | score (0–1) | Correctness component of efficiency | Share of test runs that passed, from 0 to 1. Scores a neutral 0.5 when no tests ran.                                                                                         |
| `ai.efficiency.autonomy`              | score (0–1) | Autonomy component of efficiency    | How rarely the assistant had to ask you questions, from 0 to 1. One question is free; each further one lowers the score.                                                     |
| `ai.efficiency.first_attempt_quality` | score (0–1) | First-attempt quality component     | How free the task was of wasteful patterns, from 0 to 1. The more severe the worst anti-pattern found, the lower the score.                                                  |

Source: `src/metrics/efficiency-score.ts` — `emitMetrics()`

### MCP Server — API Failure Metrics

Emitted every 60 seconds alongside session gauges (only when an `ApiFailureTracker` is wired in). Attributes: `{developer, session_id?, team_id?, project_id?, org_id?, repo_url?}` plus `{error_type}` or `{model, provider?}` where noted.

| Metric Name                     | Value      | Attributes     | How Computed                                                                                                                  | What it tells you                                                                                                    |
| ------------------------------- | ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ai.api.failures_total`         | count      | —              | Total recorded `StopFailure` events                                                                                           | How many times the model API failed during the session. Use it to spot outages or rate limiting.                     |
| `ai.api.tokens_lost`            | count      | —              | Always 0 — `StopFailure` carries no token data (see tracker note)                                                             | Tokens wasted by failed requests. Currently always 0, because failure events carry no token data.                    |
| `ai.api.failure_by_type`        | count      | `{error_type}` | Per-`ApiErrorType` failure count, emitted only when count > 0                                                                 | Failure count broken down by error type, such as rate limits or server errors. Emitted only for types that occurred. |
| `ai.api.model_failure_rate`     | rate (0–1) | `{model}`      | `failureCount / totalRequests` per model — requires `recordRequest()` calls not currently made, so this stays unemitted today | Share of requests that failed, per model. Defined but not emitted today.                                             |
| `ai.api.model_mean_recovery_ms` | duration   | `{model}`      | Mean `recoveryMs` per model — always `null`/unemitted since `StopFailure` never reports a recovery time                       | Average time to recover from a failure, per model. Defined but not emitted today.                                    |

Source: `src/metrics/api-failure-tracker.ts` — `emitMetrics()`

### MCP Server — Git Metrics

Emitted every 60 seconds alongside session gauges (only when a `GitEfficiencyTracker` is wired in). Attributes: `{developer, session_id?, team_id?, project_id?, org_id?, repo_url?}`. Each count blends hook-observed git/gh-CLI activity with commits hydrated from `git log` at session start — the two sources are deduped upstream (see `GitEfficiencyTracker.hydrateGitLog()`), so there is no separate hook-observed-vs-hydrated breakdown.

| Metric Name               | Value | How Computed                                                                                                                                                                                                                                                                                                                                                                                             | What it tells you                                                                                                           |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ai.git.commit_count`     | count | `GitEfficiencyMetrics.commitCount`: commits that are not `--amend` and that `classifyGitSegments` marks succeeded. A chained command reports one exit status, so that mark is inferred from the error text and from bash's `&&`/`\|\|`/`\|` grouping, and a failed commit can still count when `&&` alone joins it to a later step and the text does not show its failure (a gpg signing error, for one) | How many commits you made today, across your sessions, including ones made outside the assistant.                           |
| `ai.git.push_count`       | count | `GitEfficiencyMetrics.pushCount`: plain and force pushes that `classifyGitSegments` records as succeeded, inferred as for `ai.git.commit_count`                                                                                                                                                                                                                                                          | How many pushes were made today, across your sessions.                                                                      |
| `ai.git.force_push_count` | count | `GitEfficiencyMetrics.forcePushes`: every force push run, including one that failed                                                                                                                                                                                                                                                                                                                      | How many force pushes were run, including `--force-with-lease` and failed ones. Use it to watch for risky history rewrites. |
| `ai.git.pr_created`       | count | `GitEfficiencyMetrics.prMetrics.created`                                                                                                                                                                                                                                                                                                                                                                 | How many pull requests were opened today, across your sessions.                                                             |
| `ai.git.pr_merged`        | count | `GitEfficiencyMetrics.prMetrics.merged`                                                                                                                                                                                                                                                                                                                                                                  | How many pull requests were merged today, across your sessions.                                                             |

Source: `src/metrics/git-efficiency-tracker.ts` — `emitMetrics()`

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

### Local-only Metrics (Defined, Not Exported)

Every tracker below defines an `emitMetrics(aggregator)` method (or, for `TrendAnalyzer`, `emitWeeklySummaryEvent()`) that calls `aggregator.record(...)` for the metric names in its table. None of these methods are ever called: `emitSessionGauges()` in `src/transport/nr-ingest.ts` only calls `emitMetrics()` on `costTracker`, `efficiencyScorer`, `feedbackCollector`, `apiFailureTracker`, and `gitEfficiencyTracker` (see the Cost, Efficiency, API Failure and Git Metrics sections above). **Local-only — not currently exported to New Relic** for every metric name in this section; each tracker still computes and holds this data locally (available to the local dashboard and MCP tools via its own `getMetrics()`), it just never reaches the harvest loop.

| Metric Name                                | Value       | Attributes                                         | Defined In                                                                               |
| ------------------------------------------ | ----------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ai.tool.success_rate`                     | rate (0–1)  | `{tool}`                                           | `src/metrics/session-tracker.ts` — `SessionTracker.emitMetrics()`                        |
| `ai.task.completed_count`                  | count       | `{}`                                               | `src/metrics/task-detector.ts` — `TaskDetector.emitMetrics()`                            |
| `ai.task.active`                           | `0` or `1`  | `{}`                                               | `src/metrics/task-detector.ts` — `TaskDetector.emitMetrics()`                            |
| `ai.task.duration_ms`                      | duration    | `{}`                                               | `src/metrics/task-detector.ts` — `TaskDetector.emitMetrics()`                            |
| `ai.task.tool_call_count`                  | count       | `{}`                                               | `src/metrics/task-detector.ts` — `TaskDetector.emitMetrics()`                            |
| `ai.task.cost_usd`                         | USD         | `{}`                                               | `src/metrics/task-detector.ts` — `TaskDetector.emitMetrics()`                            |
| `ai.retry.alerts_total`                    | count       | `{}`                                               | `src/metrics/retry-detector.ts` — `RetryDetector.emitMetrics()`                          |
| `ai.retry.tokens_wasted`                   | count       | `{}`                                               | `src/metrics/retry-detector.ts` — `RetryDetector.emitMetrics()`                          |
| `ai.context.fill_percent`                  | percent     | `{}`                                               | `src/metrics/context-composition-tracker.ts` — `ContextCompositionTracker.emitMetrics()` |
| `ai.context.total_tokens`                  | count       | `{}`                                               | `src/metrics/context-composition-tracker.ts` — `ContextCompositionTracker.emitMetrics()` |
| `ai.context.category_tokens`               | count       | `{category}`                                       | `src/metrics/context-composition-tracker.ts` — `ContextCompositionTracker.emitMetrics()` |
| `ai.claudemd.change`                       | `1`         | `{filePath, changeType, linesAdded, linesRemoved}` | `src/metrics/claudemd-tracker.ts` — `ClaudeMdTracker.emitMetrics()`                      |
| `ai.claudemd.post_change_efficiency_delta` | score delta | `{filePath, changeType}`                           | `src/metrics/claudemd-tracker.ts` — `ClaudeMdTracker.emitMetrics()`                      |
| `ai.claudemd.post_change_cost_delta`       | USD delta   | `{filePath, changeType}`                           | `src/metrics/claudemd-tracker.ts` — `ClaudeMdTracker.emitMetrics()`                      |
| `ai.quality.diff_apply_rate`               | rate (0–1)  | `{}`                                               | `src/metrics/quality-proxy-tracker.ts` — `QualityProxyTracker.emitMetrics()`             |
| `ai.quality.test_pass_rate`                | rate (0–1)  | `{}`                                               | `src/metrics/quality-proxy-tracker.ts` — `QualityProxyTracker.emitMetrics()`             |
| `ai.quality.backtrack_count`               | count       | `{}`                                               | `src/metrics/quality-proxy-tracker.ts` — `QualityProxyTracker.emitMetrics()`             |
| `ai.quality.self_correction_count`         | count       | `{}`                                               | `src/metrics/quality-proxy-tracker.ts` — `QualityProxyTracker.emitMetrics()`             |
| `ai.quality.degradation_detected`          | `1`         | `{}`                                               | `src/metrics/quality-proxy-tracker.ts` — `QualityProxyTracker.emitMetrics()`             |
| `ai.trend.efficiency_score_weekly`         | score (0–1) | `{developer, week}`                                | `src/metrics/trend-analyzer.ts` — `TrendAnalyzer.emitWeeklySummaryEvent()`               |
| `ai.trend.cost_weekly`                     | USD         | `{developer, week}`                                | `src/metrics/trend-analyzer.ts` — `TrendAnalyzer.emitWeeklySummaryEvent()`               |
| `ai.trend.task_success_rate_weekly`        | rate (0–1)  | `{developer, week}`                                | `src/metrics/trend-analyzer.ts` — `TrendAnalyzer.emitWeeklySummaryEvent()`               |
| `ai.task.outcome`                          | `1`         | `{developer, outcome, costUsd, toolCalls}`         | `src/metrics/cost-per-outcome.ts` — `CostPerOutcomeAnalyzer.emitMetrics()`               |
| `ai.cost_per_outcome`                      | avg USD     | `{developer, outcome, count, totalCost}`           | `src/metrics/cost-per-outcome.ts` — `CostPerOutcomeAnalyzer.emitMetrics()`               |
| `ai.latency.llm_api.p50`                   | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.latency.llm_api.p95`                   | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.latency.tool_execution.p50`            | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.latency.tool_execution.p95`            | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.latency.overhead.p50`                  | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.latency.overhead.p95`                  | duration    | `{}`                                               | `src/metrics/latency-decomposition.ts` — `LatencyDecompositionTracker.emitMetrics()`     |
| `ai.prompt_recommendation`                 | `1`         | `{developer, category, priority}`                  | `src/metrics/prompt-feedback.ts` — `PromptFeedbackEngine.emitMetrics()`                  |
| `ai.recommendation`                        | `1`         | `{developer, category, priority}`                  | `src/metrics/recommendation-engine.ts` — `RecommendationEngine.emitMetrics()`            |
| `ai.anti_pattern.count`                    | `1`         | `{type}`                                           | `src/metrics/anti-patterns.ts` — `AntiPatternDetector.emitMetrics()`                     |

`ai.collaboration.*` (below) deserves a specific note: PRIVACY.md documents the collaboration profile as "never transmitted to New Relic, in any mode" because today the only path that reads it is the on-demand `nr_observe_get_collaboration_profile` MCP tool. That statement is accurate for the tool as shipped, but `CollaborationProfiler.emitMetrics()` is real, unwired code that — if ever added to the harvest loop — would export these same per-developer behavioral scores as NR metrics. Anyone changing `emitSessionGauges()` should re-check PRIVACY.md's claim before wiring this one in.

| Metric Name                        | Value | Attributes    | Defined In                                                                     |
| ---------------------------------- | ----- | ------------- | ------------------------------------------------------------------------------ |
| `ai.collaboration.specificity`     | score | `{developer}` | `src/metrics/collaboration-profile.ts` — `CollaborationProfiler.emitMetrics()` |
| `ai.collaboration.autonomy`        | score | `{developer}` | `src/metrics/collaboration-profile.ts` — `CollaborationProfiler.emitMetrics()` |
| `ai.collaboration.correction_rate` | score | `{developer}` | `src/metrics/collaboration-profile.ts` — `CollaborationProfiler.emitMetrics()` |
| `ai.collaboration.task_complexity` | score | `{developer}` | `src/metrics/collaboration-profile.ts` — `CollaborationProfiler.emitMetrics()` |

---

## Logs API

### Audit Log Entries

Every tool call produces a structured log entry sent to the NR Logs API.

| Field                  | Location   | Type    | Description                                  |
| ---------------------- | ---------- | ------- | -------------------------------------------- |
| `timestamp`            | top-level  | number  | Epoch milliseconds                           |
| `message`              | top-level  | string  | Human-readable audit detail                  |
| `tool`                 | attributes | string  | Tool name                                    |
| `developer`            | attributes | string  | Developer identifier                         |
| `app_name`             | attributes | string  | Application name                             |
| `session_id`           | attributes | string  | Session identifier (if available)            |
| `agent_id`             | attributes | string  | Same as `AiAuditEvent.agent_id` (if known)   |
| `agent_type`           | attributes | string  | Same as `AiAuditEvent.agent_type` (if known) |
| `audit.action`         | attributes | string  | Action classification                        |
| `audit.security_alert` | attributes | boolean | Whether a security alert was triggered       |
| `audit.file_path`      | attributes | string  | File path (if applicable)                    |
| `audit.command`        | attributes | string  | Command (if applicable)                      |
| `audit.severity`       | attributes | string  | Alert severity (if alert)                    |
| `audit.alert_type`     | attributes | string  | Alert type (if alert)                        |

Source: `src/transport/log-ingest.ts` — `auditRecordToLogEntry()`

---
title: Metrics Reference
description: Every metric and event Preflight sends to New Relic, organized by delivery API and source package.
---

# NR AI Coding Observability: Preflight — Metrics Reference

Every metric and event that this project sends to New Relic, organized by delivery API and source package.

---

## Delivery Mechanism

`NrIngestManager` (`src/transport/nr-ingest.ts`) sends telemetry through a `HarvestScheduler` for events and metrics and a `LogIngestManager` for logs. The values below are defaults:

| Channel | Target API    | Flush Interval | Retry Buffer  |
| ------- | ------------- | -------------- | ------------- |
| Events  | NR Events API | 5 seconds      | 1,000 events  |
| Metrics | NR Metric API | 60 seconds     | 500 snapshots |
| Logs    | NR Logs API   | 5 seconds      | 1,000 entries |

Failed batches are re-queued with bounded buffers. Oldest entries are dropped on overflow, and events and metrics lost to buffer overflow are counted by the [Delivery Self-Monitoring Metrics](#delivery-self-monitoring-metrics). Log overflow, a batch the API rejects as invalid (a 4xx other than 408 or 429, which is dropped, not retried), and a failed local-tier write are only written to Preflight's own log. The event and metric flush intervals are configurable with `harvestEventsMs` and `harvestMetricsMs` (or `NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS` and `NEW_RELIC_AI_MCP_HARVEST_METRICS_MS`); the log interval is not. The log buffer is trimmed to 1,000 entries when a send fails, keeping the failed batch and dropping the oldest newer entries first.

Logs go to the New Relic Logs API whatever the transport setting, and only on the primary tier.

### What Is Sent at All

- `mode: 'local'` sends nothing to New Relic. The ingest manager is never created.
- With `companionMode` on (set explicitly, or detected when Claude Code's own OTel export points at New Relic), the `ai.cost.*` gauges are not sent, and cost-bearing events from `claude-code` carry `cost_authority: "external"` instead of being dropped.
- With a `tiers` array, events fan out to several New Relic accounts and local JSONL directories by `eventType`, and each New Relic tier has its own scheduler, retry buffer and backoff. Local tiers append each event to disk at once, with no flush interval or retry buffer. The first New Relic tier is the primary tier. Only it carries the aggregated metrics, logs, OTLP and the send-health counters. Every New Relic tier's scheduler still reports its own [Delivery Self-Monitoring Metrics](#delivery-self-monitoring-metrics) to its own account.

### Transport Routing

The `HarvestScheduler` library takes a `transport` option that controls where it sends telemetry:

| Mode                      | Events                           | Metrics                                                                                                                                                   |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nr-events-api` (default) | NR Events API                    | NR Metric API                                                                                                                                             |
| `otlp`                    | OTLP/HTTP (as log records)       | OTLP/HTTP (counts as sums, summaries as histograms, gauges as gauges; the aggregator produces only summaries, so aggregated metrics arrive as histograms) |
| `both`                    | Both simultaneously (concurrent) | Both simultaneously (concurrent)                                                                                                                          |

In the MCP server today, the config field `otlp.transport` (legacy flat `transport`, or `NEW_RELIC_AI_TRANSPORT`) is not passed to the `HarvestScheduler`. Events and metrics always go to the NR APIs. The setting's only effect is whether Preflight starts trace spans, and nothing exports them because the server registers no tracer provider. Secondary tiers always use `nr-events-api`.

OTLP targets any OpenTelemetry-compatible backend. New Relic OTLP: US `https://otlp.nr-data.net`, EU `https://otlp.eu01.nr-data.net`.

Source: `src/transport/nr-ingest.ts`, `src/shared/harvest/harvest-scheduler.ts`, `src/transport/log-ingest.ts`

---

## Schema Versioning

Every NR event type except `AiRetryAlert` and `NrAiObserveSetupCheck` carries an `event_version` field (currently `1`). Within a version, changes are additive only: new attributes may appear, existing ones keep name and meaning. A rename, removal, or semantic change bumps the version. Consumers should tolerate unknown attributes and may branch on `event_version` in NRQL.

`timestamp` is Unix epoch milliseconds on every event that has one, except `AiAuditEvent` and `SecurityAlert`, which use epoch seconds. Keep that in mind when joining them to `AiToolCall` by time.

---

## Events API

### MCP Server Events

These events are emitted by the MCP server (`preflight`) when Claude Code or another IDE uses a tool.

#### `AiToolCall`

**What it is:** One record for each action your AI assistant takes, such as reading a file, running a command or editing code, with how long it took and whether it succeeded. It is the raw activity log behind most other Preflight data. Use it to see which tools the assistant leans on, find slow or failing calls, and drill into what happened in a specific session.

Emitted for every tool call Preflight records: calls captured by the hook collector, calls forwarded by the proxy (which also produce an `AiMcpToolCall`), and the synthetic records for calls that never reported back (`error_type` `timeout`, `rejected` or `hook_blocked`) or were denied. A `timeout` or `rejected` row is not corrected if the call turns out to have finished late.

| Field                 | Type    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`           | string  | Always `"AiToolCall"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `event_version`       | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `timestamp`           | number  | Unix epoch milliseconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tool`                | string  | Tool name (e.g., `Read`, `Edit`, `Bash`, `Grep`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tool_use_id`         | string  | Unique tool use identifier from the AI assistant                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `success`             | boolean | Whether the tool call succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `developer`           | string  | Developer identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `app_name`            | string  | Application name (default: `preflight`)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session_id`          | string  | Session identifier (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not configured.                                                                                                                                                                                                                                                                                                                                                           |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `org_id`              | string  | Organization identifier (if configured)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `platform`            | string  | Platform attribution (default: `claude-code`)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `duration_ms`         | number  | Tool call duration in milliseconds (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `error_type`          | string  | Error classes (if failed): `timeout` (no completion in 60s; Bash 11 min, Agent and Task 30 min; a call still running when Preflight stops or its pending list overflows is also marked `timeout`), `rejected` (the call was waiting on a permission prompt when it was swept, evicted, or Preflight stopped), `hook_blocked` (a PreToolUse hook blocked the call, detected from the transcript), `denied` (Claude Code's PermissionDenied hook fired), `interrupted` (user interrupted) |
| `error`               | string  | Error message, redacted (if reported)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `input_size_bytes`    | number  | Size of tool input (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `output_size_bytes`   | number  | Size of tool output (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `input_hash`          | string  | Hash of tool input for deduplication (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `skill_name`          | string  | Skill whose run this call happened inside. A run opens on a successful named `Skill` call (which carries it too; a failed `Skill` call carries it only when no run is open) or a `/<skill>` prompt and closes on the next prompt or the next skill. Redacted like other user-derived strings                                                                                                                                                                                            |
| `skill_source`        | string  | How the run was opened: `tool` (Skill tool) or `slash` (prompt slash command)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `skill_run_id`        | string  | One id per skill run; `uniqueCount(skill_run_id)` counts runs                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `skill_parent_run_id` | string  | Only on a run opened while another was open (a skill invoked by a skill, a subagent skill inside the main run, or a skill run right after another in the same turn): that run's `skill_run_id`. One hop only                                                                                                                                                                                                                                                                            |
| `skillArgsLength`     | number  | Length of skill arguments (if available)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `agent_id`            | string  | Claude Code subagent id. Same value and backfill rules as `AiAuditEvent.agent_id`. Absent for parent-session calls                                                                                                                                                                                                                                                                                                                                                                      |
| `agent_type`          | string  | Agent type. Same value and backfill rules as `AiAuditEvent.agent_type`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `turn_id`             | string  | Id of the assistant turn the call belongs to, from the turn tracker. It is not the same id as `AiTurnCost.turn_id`, so join the two events on `tool_use_id`                                                                                                                                                                                                                                                                                                                             |
| `turn_number`         | number  | Position of that turn in the turn tracker's count. The count is per process, so under `--local` it runs across sessions                                                                                                                                                                                                                                                                                                                                                                 |
| `cwd`                 | string  | Working directory of the session, redacted                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `permissionMode`      | string  | Claude Code permission mode in effect for the call (if the hook payload carried it)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `transcriptPath`      | string  | Path to the session's transcript file on the developer's machine. Not redacted                                                                                                                                                                                                                                                                                                                                                                                                          |
| `permissionWaitMs`    | number  | Wall-clock time minus the tool's own reported duration: how long the call waited on a permission prompt or similar. Only present when Claude Code reported the tool's own duration, in which case `duration_ms` is that native duration                                                                                                                                                                                                                                                 |
| `*`                   | varies  | Tool-specific fields from input/output parsers (e.g., `filePath`, `command`, `exitCode`, `isTestCommand`, `bashCategory`, `bashLeading`, `bashDestructive`, `bashNetwork`; many more are set by the parsers in `src/hooks/tool-parsers.ts`)                                                                                                                                                                                                                                             |

Source: `src/transport/nr-ingest.ts` — `toolCallToNrEvent()`

Bash tool calls additionally carry four classifier fields:

- `bashCategory` — one of `git`, `package-manager`, `test-runner`, `build`, `container`, `network`, `fs-op`, `search`, `custom-script`, `shell-other`
- `bashLeading` — the resolved leading argv0 (after sudo / env-var stripping, reduced to its basename unless it is an explicit script path, so `/usr/bin/git` becomes `git`)
- `bashDestructive` — `true` for recursive rm, force-push, dd, mkfs, drop/truncate, chmod 777, pipe-to-shell, etc. (`--force-with-lease` and `--force-if-includes` are NOT flagged)
- `bashNetwork` — `true` when the leading command is a network client (curl/wget/ssh/...)

Source: `src/hooks/bash-classifier.ts` — `classifyBash()`, assigned onto the record by `parseBash()` in `src/hooks/tool-parsers.ts`

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
| `success`             | boolean | `true` when the upstream HTTP status is 2xx. A JSON-RPC error returned with HTTP 200 still counts as success           |
| `developer`           | string  | Developer identifier                                                                                                   |
| `app_name`            | string  | Application name                                                                                                       |
| `session_id`          | string  | Session identifier (if available)                                                                                      |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                             |
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Time spent in proxy layer: total duration minus upstream latency, never negative                                       |
| `error_type`          | string  | Declared by the event builder but not currently populated for proxied calls, so it is not present in practice          |
| `request_size_bytes`  | number  | Request payload size                                                                                                   |
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
| `success`             | boolean | `true` when the upstream HTTP status is 2xx                                                                            |
| `developer`           | string  | Developer identifier                                                                                                   |
| `app_name`            | string  | Application name                                                                                                       |
| `team_id`             | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set. |
| `project_id`          | string  | Project identifier (derived from git remote or configured)                                                             |
| `repo_url`            | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`              | string  | Organization identifier (if configured)                                                                                |
| `proxy_overhead_ms`   | number  | Proxy layer overhead: total duration minus upstream latency, never negative                                            |
| `response_size_bytes` | number  | Response size (if available)                                                                                           |

Source: `src/transport/nr-ingest.ts` — `proxyRequestToNrEvent()`

#### `AiAuditEvent`

**What it is:** A security-focused record of what your assistant did, one per tool call, with the file path or command involved. Each record is labelled with the kind of action and flagged when it matches a risk rule, such as sensitive file access, destructive commands, external network requests or file deletion. Use it as an audit trail for compliance reviews and to work out what happened after an incident.

Emitted for every tool call as a security audit record, including proxied calls and hook installs.

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
| `file_path`     | string | File path of the triggering call (if it had one)                                                                       |
| `command`       | string | Command of the triggering call (if it had one)                                                                         |

Security alert triggers. A tool call raises at most one alert, at the highest severity it matches:

- **`destructive_command`** (critical): `rm -rf` (any recursive flag combo), `git push --force` (but NOT `--force-with-lease` / `--force-if-includes`), `git clean -f` (any force form), `find -delete`, `DROP TABLE`, `DROP DATABASE`, `DELETE FROM`, `git reset --hard`, `chmod 777`, `dd if=`, `mkfs`, `shred`, pipe-to-shell, etc. Detection is the OR of the bash classifier (`record.bashDestructive`) and the regex pattern list — defense in depth, neither layer alone is authoritative.
- **`sensitive_file`** (high): `.env`, `.pem`, `.key`, `credentials`, `secret`, `.ssh/`, `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, `password`, `token` (see `DEFAULT_SENSITIVE_FILE_PATTERNS` in `src/security/audit-trail.ts` for the exact patterns). Only the call's file path is checked, not paths inside a Bash command, so a Bash command that reads `.env` does not raise this alert
- **`external_network`** (medium): `curl`, `wget`, `nc`, `ssh` commands, plus anything the classifier marks as a network client (`http`, `httpie`, `xh`, `ncat`, `scp`, `sftp`, `rsync`, `ftp`, `telnet`, `mosh`). Detection is the OR of the bash classifier (`record.bashNetwork`) and the regex pattern list.
- **`file_deletion`** (medium): `rm` or `unlink` in command position (start of line, after `;`, `&`, `|`, or `(`, optionally with `sudo`), OR-ed with the bash classifier's leading token (`record.bashLeading`), which also strips env-var prefixes. Anchoring keeps `git rm`, `npm rm`, `docker rm`, and quoted text like `echo "rm foo"` out of scope. Recursive forms match too but lose to `destructive_command` by severity.

Source: `src/security/audit-trail.ts` — `securityAlertToNrEvent()`

#### `AiCodingTask`

**What it is:** A summary of one logical piece of work, from the moment your assistant starts on a request to the moment it finishes, such as fixing a bug or adding a feature. Each record rolls up the files touched, lines changed, tests and builds run, tokens used and estimated cost, and classifies the outcome. Use it to see what the assistant accomplished and what it cost per task, and to compare effort across bug fixes, features and refactors.

Emitted for a closed task (a logical unit of work from task start to completion). A task with no tool calls is dropped without an event. Closed tasks are sent when the next tool call is processed, so the last task of a session may never be sent.

| Field                  | Type    | Description                                                                                                                                                                                                                                                                     |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`            | string  | Always `"AiCodingTask"`                                                                                                                                                                                                                                                         |
| `event_version`        | number  | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                                                                                                                                                                     |
| `timestamp`            | number  | Unix epoch milliseconds (task end time)                                                                                                                                                                                                                                         |
| `task_id`              | string  | Unique task identifier                                                                                                                                                                                                                                                          |
| `developer`            | string  | Developer identifier                                                                                                                                                                                                                                                            |
| `app_name`             | string  | Application name                                                                                                                                                                                                                                                                |
| `platform`             | string  | Platform attribution (default: `claude-code`)                                                                                                                                                                                                                                   |
| `session_id`           | string  | Session identifier (if available)                                                                                                                                                                                                                                               |
| `team_id`              | string  | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set.                                                                                                                                                          |
| `project_id`           | string  | Project identifier (derived from git remote or configured)                                                                                                                                                                                                                      |
| `repo_url`             | string  | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                                                                                            |
| `org_id`               | string  | Organization identifier (if configured)                                                                                                                                                                                                                                         |
| `start_time`           | number  | Task start time (Unix epoch milliseconds)                                                                                                                                                                                                                                       |
| `end_time`             | number  | Task end time (Unix epoch milliseconds)                                                                                                                                                                                                                                         |
| `duration_ms`          | number  | Task duration in milliseconds, capped at 4 hours                                                                                                                                                                                                                                |
| `tool_call_count`      | number  | Total tool calls in the task                                                                                                                                                                                                                                                    |
| `files_read`           | number  | Number of unique files read                                                                                                                                                                                                                                                     |
| `files_modified`       | number  | Number of unique files modified                                                                                                                                                                                                                                                 |
| `lines_added`          | number  | Lines added across all edits                                                                                                                                                                                                                                                    |
| `lines_removed`        | number  | Lines removed across all edits                                                                                                                                                                                                                                                  |
| `bash_commands_run`    | number  | Number of Bash tool calls                                                                                                                                                                                                                                                       |
| `tests_run`            | number  | Number of test runs detected                                                                                                                                                                                                                                                    |
| `tests_passed`         | number  | Number of test runs that succeeded                                                                                                                                                                                                                                              |
| `build_run`            | number  | Number of build commands detected                                                                                                                                                                                                                                               |
| `build_passed`         | number  | Number of build commands that succeeded                                                                                                                                                                                                                                         |
| `estimated_cost_usd`   | number  | Estimated token cost for the task (`0` when cost was never computed)                                                                                                                                                                                                            |
| `cost_estimated`       | boolean | `true` when `estimated_cost_usd` was actually computed; `false` when defaulted to `0`                                                                                                                                                                                           |
| `tokens_used`          | number  | Total tokens consumed in the task                                                                                                                                                                                                                                               |
| `asked_user_questions` | number  | Number of questions asked to the user                                                                                                                                                                                                                                           |
| `sub_agents_spawned`   | number  | Number of sub-agent spawns                                                                                                                                                                                                                                                      |
| `outcome_type`         | string  | Task classification: `bug_fix`, `feature`, `refactor`, `investigation`, `configuration`, `documentation`, or `failed_attempt`                                                                                                                                                   |
| `model`                | string  | Latest model on the cost tracker when the event was sent (e.g. `claude-sonnet-5`), not a per-task value. It can be the configured default model when only byte-size estimates have run. `unknown` when a token event named no model. Omitted when the tracker has no model yet. |
| `cost_authority`       | string  | `external` when `companionMode` is on and `platform` is `claude-code`: the cost fields are an estimate and Claude Code's own OTel export is the cost source of truth. Omitted otherwise                                                                                         |

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
| `project_id`    | string | Project identifier (derived from git remote or configured)                                                             |
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`        | string | Organization identifier (if configured)                                                                                |
| `suggestion`    | string | Human-readable remediation suggestion                                                                                  |
| `file`          | string | File involved, redacted (if applicable)                                                                                |
| `command`       | string | Command involved, redacted (if applicable)                                                                             |
| `iterations`    | number | Number of edit-and-fail iterations (thrashing only)                                                                    |
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
| `project_id`    | string | Project identifier (derived from git remote or configured)                                                             |
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                   |
| `org_id`        | string | Organization identifier (if configured)                                                                                |

**Firing rules:**

- `50%` — first time spend reaches 50% of budget
- `80%` — first time spend reaches 80% of budget
- `100%` — first time spend reaches or exceeds 100% of budget

Each threshold fires only once per period; subsequent additions to spend do not re-fire. A `daily` period's thresholds reset at UTC midnight, although the daily spend itself is summed by local calendar day, a `weekly` period is an ISO week, and a `session` period never rolls over by itself. One cost update that jumps past several thresholds fires all of them together. When a session resumes after a restart, the session thresholds it had already crossed do not fire again. A budget that is unset or `0` never fires.

Source: `src/transport/nr-ingest.ts`, `src/metrics/budget-tracker.ts`

#### `AiContextSnapshot`

**What it is:** A per-turn picture of how full the model's context window is, with an estimated split into system, tool, user and assistant content and the single largest tool contributor. Use it to find sessions nearing the limit and to spot the tool that adds the most to the context.

Emitted for each token event that carries a session id, capturing an estimated token breakdown by category. Subagent turns do not produce it, and a replayed duplicate is counted once. Tokens reported through `nr_observe_report_tokens` do not produce it.

| Field                   | Type   | Description                                                                                                                                                                                         |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`             | string | Always `"AiContextSnapshot"`                                                                                                                                                                        |
| `event_version`         | number | Schema version, currently `1`. See [Schema Versioning](#schema-versioning).                                                                                                                         |
| `timestamp`             | number | Unix epoch milliseconds                                                                                                                                                                             |
| `developer`             | string | Developer identifier                                                                                                                                                                                |
| `appName`               | string | Application name (camelCase, same as `AiBudgetWarning`)                                                                                                                                             |
| `session_id`            | string | The ingesting process's own session id, which can differ from the token event's session when a process drains other sessions' events                                                                |
| `team_id`               | string | User-defined team label from config (e.g. `"platform-eng"`). Not your NR account ID. Omitted when `teamId` is not set.                                                                              |
| `project_id`            | string | Project identifier (derived from git remote or configured)                                                                                                                                          |
| `repo_url`              | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                |
| `org_id`                | string | Organization identifier (if configured)                                                                                                                                                             |
| `turn_number`           | number | Sequential turn number within the session                                                                                                                                                           |
| `total_context_tokens`  | number | Context size for this turn: input tokens plus cache-read and cache-creation tokens                                                                                                                  |
| `output_tokens`         | number | Output tokens for this turn                                                                                                                                                                         |
| `cache_read_tokens`     | number | Prompt cache read tokens                                                                                                                                                                            |
| `cache_creation_tokens` | number | Prompt cache creation tokens                                                                                                                                                                        |
| `fill_percent`          | number | `total_context_tokens` as a percentage of the largest context window seen for any model in the session (200K until a model says otherwise), rounded to 2 decimals. Not capped, so it can exceed 100 |
| `system_tokens`         | number | Estimated system prompt size: the first turn's cache-creation tokens, `0` when the first turn hit a warm cache                                                                                      |
| `tool_tokens`           | number | Estimated tokens from tool results, derived from tool output bytes. Tool definitions are not counted                                                                                                |
| `user_tokens`           | number | Estimated user message tokens: whatever remains after the system, tool and assistant estimates                                                                                                      |
| `assistant_tokens`      | number | Estimated assistant tokens: cumulative output tokens of earlier turns in the session, capped at what remains of the context                                                                         |
| `top_tool`              | string | Tool with the largest cumulative output bytes in the session (if any)                                                                                                                               |
| `top_tool_bytes`        | number | Cumulative output bytes of that tool across the session (if any)                                                                                                                                    |
| `top_tool_tokens`       | number | Estimated token count of top tool's contribution (if any)                                                                                                                                           |

Source: `src/transport/nr-ingest.ts` — `ingestContextSnapshot()`

#### `AiSubagentTurn`

**What it is:** The token usage and cost of each turn taken by a subagent, a helper your assistant delegates work to. Use it to see what delegated work costs, which is easy to miss when you look only at the main session.

Emitted for each subagent (`Agent` tool) assistant turn observed by the subagent-watcher pipeline.

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
| `workflow_run_id`       | string | Workflow run this turn belongs to (if any); sent as an empty string when absent.                                                                                                                                                                                                                                                |
| `usd`                   | number | Computed USD cost for this turn. Omitted when the cost is zero or could not be priced                                                                                                                                                                                                                                           |
| `stop_reason`           | string | Model stop reason (if known)                                                                                                                                                                                                                                                                                                    |
| `team_id`               | string | User-defined team label from config. Omitted when `teamId` is not configured.                                                                                                                                                                                                                                                   |
| `project_id`            | string | Project identifier (derived from git remote or configured)                                                                                                                                                                                                                                                                      |
| `org_id`                | string | Organization identifier (if configured)                                                                                                                                                                                                                                                                                         |
| `repo_url`              | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                                                                                                                                                                            |
| `cost_authority`        | string | `external` when `companionMode` is on, marking the cost fields as an estimate next to Claude Code's own OTel export. Omitted otherwise                                                                                                                                                                                          |

`subagentTurnToNrEvent()` builds the event after `CostTracker.recordTokenUsage()` has computed the per-turn USD. Besides the fields above it sends `turn_uuid` (unique per-turn ID), `timestamp_ms` (duplicate of `timestamp`) and `schema_fingerprint` (source-JSONL schema fingerprint, if computed). It does not send a separate resolved `session_id`; use `parent_session_id`. A second builder, `subagentTokenEventToNrEvent()`, serializes the lighter storage-layer record without `usd`, `stop_reason`, `turn_uuid` or `schema_fingerprint`, but nothing calls it today, so no event is produced that way.

Source: `src/transport/nr-ingest.ts` — `subagentTurnToNrEvent()`

#### `AiWorkflowRun`

**What it is:** A summary of one subagent run (an `Agent` tool call) or one script-driven workflow run: its status, duration and how many agents it started. Script-driven runs also carry total tokens and cost; runs started through the Agent tool do not, so use `AiSubagentTurn` for their cost. Use it to compare workflows and to find ones that are slow or failing.

Emitted for each `Agent`-tool run (`run_source: "agent_tool"`) when the call ends. An `Agent` call that outlives its 30-minute timeout can produce an `errored` row and later a `completed` row with the same `workflow_run_id`. For a script-driven run tracked by the on-disk `wf_*.json` watcher (`run_source: "script"`) it is emitted every time that file changes, including while the run is still in progress. Either way one run can produce several rows, so use the latest row per `workflow_run_id`.

| Field             | Type   | Description                                                                                                                                               |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`       | string | Always `"AiWorkflowRun"`                                                                                                                                  |
| `event_version`   | number | Always `1`                                                                                                                                                |
| `timestamp`       | number | Unix epoch milliseconds (`started_at + duration_ms`, or `+ 0` on a script run with no duration yet)                                                       |
| `run_source`      | string | `"agent_tool"` or `"script"` — discriminates the two field sets below                                                                                     |
| `workflow_run_id` | string | Unique run identifier (`toolu_*` for agent_tool runs, `wf_<hex>-<hex>` for script runs)                                                                   |
| `developer`       | string | Developer identifier                                                                                                                                      |
| `app_name`        | string | Application name                                                                                                                                          |
| `status`          | string | Run status. `agent_tool` runs report `completed` or `errored`; script runs report the status recorded in the `wf_*.json` file, or `unknown`               |
| `started_at`      | number | Run start time (Unix epoch milliseconds)                                                                                                                  |
| `duration_ms`     | number | Run duration in milliseconds. Always present on `agent_tool` runs; omitted entirely (not `0`) on a `script` run whose on-disk rollup has no duration yet. |
| `team_id`         | string | User-defined team label (if configured)                                                                                                                   |
| `project_id`      | string | Project identifier (derived from git remote or configured)                                                                                                |
| `org_id`          | string | Organization identifier (if configured)                                                                                                                   |
| `repo_url`        | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                      |
| `cost_authority`  | string | `external` when `companionMode` is on, marking the cost fields as an estimate next to Claude Code's own OTel export. Omitted otherwise                    |

`run_source: "agent_tool"` adds:

| Field               | Type    | Description                                                                                                                                                                                                                                           |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_type`     | string  | Subagent type requested (empty string if none)                                                                                                                                                                                                        |
| `agent_name`        | string  | Agent name (empty string if none)                                                                                                                                                                                                                     |
| `agent_model`       | string  | Model the agent ran on (empty string if unknown)                                                                                                                                                                                                      |
| `agent_description` | string  | **Redacted free text.** The user-supplied `Agent` tool prompt/description, passed through the same credential-pattern redaction as `AiToolCall.command`. Truncated to 256 characters before redaction. User-authored — not a fixed/declarative value. |
| `run_in_background` | boolean | Whether the agent ran in background mode                                                                                                                                                                                                              |
| `tool_call_count`   | number  | Tool calls made during the run                                                                                                                                                                                                                        |
| `child_agent_count` | number  | Nested agent spawns during the run                                                                                                                                                                                                                    |
| `exit_error`        | string  | Redacted exit/failure message (if the run ended in error)                                                                                                                                                                                             |
| `session_id`        | string  | Resolved Claude Code session ID (if available)                                                                                                                                                                                                        |

`run_source: "script"` adds:

| Field                        | Type    | Description                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow_name`              | string  | Declarative workflow name from the script's `meta.name` (author-declared, not redacted), falling back to the name in the `wf_*.json` file, then `unknown`                                                                                                                                  |
| `parent_session_id`          | string  | Session ID that launched the script                                                                                                                                                                                                                                                        |
| `default_model`              | string  | Default model configured for the run                                                                                                                                                                                                                                                       |
| `agent_count`                | number  | Number of agents the run declared                                                                                                                                                                                                                                                          |
| `total_tokens`               | number  | Total tokens for the run, from the on-disk rollup total. A subagent-token reconciliation path exists but is not wired in today                                                                                                                                                             |
| `observed_phases`            | number  | Number of phases actually observed                                                                                                                                                                                                                                                         |
| `declared_parallel_widths`   | string  | JSON-encoded array of declared parallel widths per phase, e.g. `[3,"dynamic",6]`                                                                                                                                                                                                           |
| `incomplete`                 | boolean | Whether the run's status is anything other than `completed`, so a run still in progress is `true`                                                                                                                                                                                          |
| `backfilled`                 | boolean | Always `false` today; the watcher never marks a record as backfilled                                                                                                                                                                                                                       |
| `task_id`                    | string  | Associated task ID (if any)                                                                                                                                                                                                                                                                |
| `declared_phases`            | number  | Declared phase count (if known)                                                                                                                                                                                                                                                            |
| `total_usd`                  | number  | Total computed cost in USD (if computed)                                                                                                                                                                                                                                                   |
| `token_reconciliation_delta` | number  | `(rollup total − Σ subagent tokens) / rollup total`, so below `1` and negative when the subagents used more than the rollup reports. It needs subagent token data and a rollup total above zero, and the subagent-token source is not wired in today, so the field is currently never sent |

Source: `src/transport/nr-ingest.ts` — `workflowRunToNrEvent()`, `scriptWorkflowRunToNrEvent()`

#### `AiObservabilityHealth`

**What it is:** Preflight's report on its workflow and subagent log watchers: how many files it is watching, how much it has read, and any parse errors or format changes (schema drift) it hit. It does not measure your coding sessions. Use it to check that telemetry is complete when numbers look low, or after an assistant update changes its log format.

Emitted by the workflow/subagent watcher pipeline to report its own health — files watched, parse errors, schema drift. Not a measurement of the AI coding session itself.

| Field                       | Type   | Description                                                                                                                                    |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`                 | string | Always `"AiObservabilityHealth"`                                                                                                               |
| `event_version`             | number | Always `1`                                                                                                                                     |
| `timestamp`                 | number | Unix epoch milliseconds                                                                                                                        |
| `watcher`                   | string | Which watcher reported: `"workflow"` or `"subagent"`                                                                                           |
| `files_watched`             | number | Number of files currently being watched                                                                                                        |
| `lines_read`                | number | Cumulative lines read                                                                                                                          |
| `bytes_read`                | number | Cumulative bytes read                                                                                                                          |
| `parse_errors`              | number | Cumulative parse errors                                                                                                                        |
| `schema_drifts`             | number | Cumulative detected schema drifts                                                                                                              |
| `developer`                 | string | Developer identifier                                                                                                                           |
| `app_name`                  | string | Application name                                                                                                                               |
| `last_error_code`           | string | Error code of the most recent error (if any)                                                                                                   |
| `last_error_class`          | string | Error class of the most recent error (if any)                                                                                                  |
| `event`                     | string | Event label (if set): `discovered_workflow`, `discovery_skipped`, `parser_skip`, `oversized_line_dropped`, `schema_drift` or `cost_self_check` |
| `dimension`                 | string | Dimension label (if set)                                                                                                                       |
| `fingerprint`               | string | Schema fingerprint associated with the report (if set)                                                                                         |
| `workflow_run_id`           | string | Associated workflow run (if set)                                                                                                               |
| `cost_self_check_delta_pct` | number | `(ground-truth cost − tracked cost) / ground-truth cost × 100` from a cost self-check (if computed)                                            |
| `team_id`                   | string | User-defined team label (if configured)                                                                                                        |
| `project_id`                | string | Project identifier (derived from git remote or configured)                                                                                     |
| `org_id`                    | string | Organization identifier (if configured)                                                                                                        |
| `repo_url`                  | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                           |

Source: `src/transport/nr-ingest.ts` — `observabilityHealthToNrEvent()`

#### `AiRetryAlert`

**What it is:** A warning that your assistant seems stuck, either repeating nearly identical calls to the same tool or failing repeatedly with it across its last few calls, with an estimate of the tokens wasted. Use it to catch thrashing loops early.

Emitted when `RetryDetector` flags a thrashing pattern in a tool's recent calls: they are highly similar (default similarity 0.8 or more), or every one of them failed. The defaults are at least 3 occurrences within a window of 5 calls.

| Field           | Type   | Description                                                                                                                                                                        |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string | Always `"AiRetryAlert"`                                                                                                                                                            |
| `timestamp`     | number | Unix epoch milliseconds                                                                                                                                                            |
| `tool_name`     | string | The tool being called repeatedly                                                                                                                                                   |
| `occurrences`   | number | Number of calls to the tool in the window that were counted toward the alert                                                                                                       |
| `window_size`   | number | Size of the sliding detection window                                                                                                                                               |
| `similarity`    | number | Similarity score (0–1) between the repeated calls                                                                                                                                  |
| `tokens_wasted` | number | Estimated tokens wasted by the repeated calls                                                                                                                                      |
| `developer`     | string | Developer identifier                                                                                                                                                               |
| `app_name`      | string | Application name                                                                                                                                                                   |
| `platform`      | string | Originating platform (defaults to `"claude-code"`)                                                                                                                                 |
| `session_id`    | string | Resolved Claude Code session ID (if available). Sourced from the ingesting process's own `sessionTraceId`, not the alert's in-process `sessionId` — see the builder's doc comment. |
| `team_id`       | string | User-defined team label (if configured)                                                                                                                                            |
| `project_id`    | string | Project identifier (derived from git remote or configured)                                                                                                                         |
| `org_id`        | string | Organization identifier (if configured)                                                                                                                                            |
| `repo_url`      | string | Full git remote URL, redacted for embedded credentials (own opt-out: repoUrlEnabled)                                                                                               |

Like `NrAiObserveSetupCheck`, `AiRetryAlert` does not carry `event_version`.

Source: `src/transport/nr-ingest.ts` — `retryAlertToNrEvent()`

#### `AiTurnCost`

**What it is:** The token cost of each assistant turn, attributed down to the individual tool call (an even share of the turn) and, when a skill is running, to that skill. Where `AiToolCall` shows what the assistant did, this event shows what it cost. Use it to find which tools or skills drive spend, and join it to `AiToolCall` on `tool_use_id` for per-call detail.

Emitted for each tool call in an attributed turn (in `--stdio` mode, only for token reports that belong to this process's own session), carrying the turn's cost and tokens split evenly across the calls, and once for each token report no tool call claimed (a response row). `tool_use_id` cross-references the call's `AiToolCall` row. Every call inside a skill run carries `skill_name`, so `sum(cost_usd) FACET skill_name` is the full cost of the work each skill drove.

| Field                   | Type   | Description                                                                                                                                                                                                                            |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`             | string | Always `"AiTurnCost"`                                                                                                                                                                                                                  |
| `event_version`         | number | Always `1`                                                                                                                                                                                                                             |
| `timestamp`             | number | Unix epoch milliseconds. On a tool row, when the turn's last tool call ended; on a response row, when the response was written                                                                                                         |
| `turn_id`               | string | Unique identifier for the turn (fresh UUID minted at cost close); groups all rows from one turn                                                                                                                                        |
| `tool_use_id`           | string | Joins to `AiToolCall.tool_use_id`. Absent on response rows                                                                                                                                                                             |
| `tool`                  | string | Tool name (e.g., `"Read"`, `"Skill"`). Absent on response rows                                                                                                                                                                         |
| `skill_name`            | string | Skill whose run this call happened inside (see `AiToolCall` above)                                                                                                                                                                     |
| `skill_source`          | string | `tool` or `slash`, as on `AiToolCall`                                                                                                                                                                                                  |
| `skill_run_id`          | string | One id per skill run, as on `AiToolCall`                                                                                                                                                                                               |
| `skill_parent_run_id`   | string | As on `AiToolCall`                                                                                                                                                                                                                     |
| `cost_usd`              | number | This call's share of the turn's cost (turn total ÷ call count); the whole response's cost on a response row                                                                                                                            |
| `input_tokens`          | number | This call's share of the turn's input tokens (fractional)                                                                                                                                                                              |
| `output_tokens`         | number | This call's share of the turn's output tokens (fractional)                                                                                                                                                                             |
| `cache_read_tokens`     | number | This call's share of cache-read tokens (fractional)                                                                                                                                                                                    |
| `cache_creation_tokens` | number | This call's share of cache-creation tokens (fractional)                                                                                                                                                                                |
| `turn_cost_usd`         | number | The full turn's cost (identical on all rows from one turn)                                                                                                                                                                             |
| `turn_tool_call_count`  | number | The number of calls in this turn (identical on all rows from one turn); `0` on a response row                                                                                                                                          |
| `model`                 | string | Model used to generate the turn's response                                                                                                                                                                                             |
| `developer`             | string | Developer identifier                                                                                                                                                                                                                   |
| `app_name`              | string | Application name                                                                                                                                                                                                                       |
| `platform`              | string | Originating platform (defaults to `"claude-code"`). On a response row, the token report's source platform, else the session's last stamped tool call's                                                                                 |
| `session_id`            | string | Resolved Claude Code session ID (if available). Precedence: `attribution.sessionId` > `sessionTraceId`; omitted when both are null                                                                                                     |
| `team_id`               | string | User-defined team label (if configured)                                                                                                                                                                                                |
| `project_id`            | string | Project identifier (derived from git remote or configured)                                                                                                                                                                             |
| `org_id`                | string | Organization identifier (if configured)                                                                                                                                                                                                |
| `cost_authority`        | string | `"external"` only when `companionMode` is true and the turn was stamped `claude-code` by the platform that reported it; omitted otherwise. A row can show `platform` `claude-code` from the default and still have no `cost_authority` |

Rows come in two shapes. A tool row has `tool` and `tool_use_id` and measures the usage of the model response that followed the turn, split evenly across the turn's calls, the same approximation `nr_observe_get_cost_per_tool` reports. A response row has `turn_tool_call_count: 0` and no `tool`, `tool_use_id`, or `skill_name`. It is a token report no tool call claimed, such as the first response after a prompt (the one that asks for the tools), and carries that response's whole cost. `sum(cost_usd)` covers every main-agent response, so per-tool queries need `WHERE tool IS NOT NULL`. Rows come from watcher-sourced token events only, never from `nr_observe_report_tokens` calls. Every row of a turn shares the turn's end `timestamp`, so a timeseries of this event spikes at turn boundaries rather than tracing per-call timing. Replayed token events are deduplicated by `(session_id, message_id)` before attribution, so a turn closes once and produces its rows once.

Source: `src/transport/nr-ingest.ts` — `turnCostToNrEvents()` and `ingestTurnCost()`

### Setup Validation

#### `NrAiObserveSetupCheck`

**What it is:** A test event the setup wizard sends to New Relic each time it validates your license key, to confirm that the key works and data can reach New Relic. It carries only its event type and a `setupCheck` flag and measures nothing, so you can ignore it in dashboards.

A one-shot license-key validation ping, sent with a direct `fetch()` call to the NR Events API — it bypasses the `HarvestScheduler` entirely, so the flush-interval and retry-buffer behavior in [Delivery Mechanism](#delivery-mechanism) does not apply to it. Carries no session, developer, or file data.

| Field        | Type    | Description                      |
| ------------ | ------- | -------------------------------- |
| `eventType`  | string  | Always `"NrAiObserveSetupCheck"` |
| `setupCheck` | boolean | Always `true`                    |

Source: `src/install/key-validator.ts` — `validateLicenseKey()`

---

## Metric API

### MCP Server — Per-Call Metrics

Recorded for each tool call as it happens, and for each proxy discovery request.

| Metric Name                        | Value      | Attributes                                                       | How Computed                            | What it tells you                                                                                                                                                                 |
| ---------------------------------- | ---------- | ---------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.tool.call_count`               | `1`        | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}` | Incremented once per tool call          | How many tool calls the assistant made. Chart it as a rate to see activity over time.                                                                                             |
| `ai.tool.duration_ms`              | duration   | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}` | From `ToolCallRecord.durationMs`        | How long each tool call took, in milliseconds, when a duration was recorded. Use it to spot slow tools.                                                                           |
| `ai.tool.success`                  | `0` or `1` | `{tool, session_id?, team_id?, project_id?, org_id?, repo_url?}` | `record.success ? 1 : 0`                | Whether each call succeeded (`1`) or failed (`0`). Average it for a success rate by tool.                                                                                         |
| `ai.mcp.proxy_request_count`       | `1`        | `{server, method}`                                               | Incremented per proxy discovery request | How many discovery requests (tool and resource listing, resource reads) the Preflight proxy handled for upstream MCP servers. Tool calls are not counted here.                    |
| `ai.mcp.proxy_request_duration_ms` | duration   | `{server}`                                                       | From `ProxyRequestRecord.durationMs`    | How long each discovery request took, in milliseconds, including proxy overhead. Use it to find slow upstream MCP servers. For tool-call latency, see `ai.mcp.server_latency_ms`. |

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

Emitted every 60 seconds alongside session gauges. A series appears only once the proxy has recorded traffic for it.

| Metric Name                | Value       | Attributes                                                  | How Computed                                                    | What it tells you                                                                                      |
| -------------------------- | ----------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ai.mcp.server_call_count` | count       | `{server, team_id?, project_id?, org_id?, repo_url?}`       | Per-server total call count from `ProxyMetricsTracker`          | How many calls each upstream MCP server has received. Shows which servers are used most.               |
| `ai.mcp.server_latency_ms` | average ms  | `{server, team_id?, project_id?, org_id?, repo_url?}`       | `sum(latencies) / count` per server (only emitted if count > 0) | Average response time of each upstream MCP server, in milliseconds. Use it to find slow servers.       |
| `ai.mcp.server_error_rate` | ratio (0-1) | `{server, team_id?, project_id?, org_id?, repo_url?}`       | `failedCount / totalCount` per server (only emitted if > 0)     | Share of each server's calls that failed, from 0 to 1. Use it to find unreliable servers.              |
| `ai.mcp.proxy_overhead_ms` | average ms  | `{team_id?, project_id?, org_id?, repo_url?}`               | `sum(overheadValues) / count` across all servers (only if > 0)  | Average time the Preflight proxy adds to a call, in milliseconds. Use it to confirm proxying is cheap. |
| `ai.mcp.tool_popularity`   | count       | `{tool, server, team_id?, project_id?, org_id?, repo_url?}` | Per-tool per-server call count (capped at 100 combinations)     | How many times each tool on each server has been called. Shows which tools matter most.                |

Source: `src/transport/nr-ingest.ts` — `emitSessionGauges()`, reading `ProxyMetricsTracker.getMetrics()` from `src/metrics/proxy-metrics.ts`

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

Emitted every 60 seconds alongside session gauges (only when a `GitEfficiencyTracker` is wired in). Attributes: `{developer, session_id?, team_id?, project_id?, org_id?, repo_url?}`. Each count blends hook-observed git, gh-CLI and GitHub MCP PR tool activity (`create_pull_request`, `update_pull_request`, `merge_pull_request`) with commits hydrated from `git log` at session start — the two sources are deduped upstream (see `GitEfficiencyTracker.hydrateGitLog()`), so there is no separate hook-observed-vs-hydrated breakdown.

| Metric Name               | Value | How Computed                                                                                                                                                                                                                                                                                                                                                                                             | What it tells you                                                                                                           |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ai.git.commit_count`     | count | `GitEfficiencyMetrics.commitCount`: commits that are not `--amend` and that `classifyGitSegments` marks succeeded. A chained command reports one exit status, so that mark is inferred from the error text and from bash's `&&`/`\|\|`/`\|` grouping, and a failed commit can still count when `&&` alone joins it to a later step and the text does not show its failure (a gpg signing error, for one) | How many commits you made today, across your sessions, including ones made outside the assistant.                           |
| `ai.git.push_count`       | count | `GitEfficiencyMetrics.pushCount`: plain and force pushes that `classifyGitSegments` records as succeeded, inferred as for `ai.git.commit_count`                                                                                                                                                                                                                                                          | How many pushes were made today, across your sessions.                                                                      |
| `ai.git.force_push_count` | count | `GitEfficiencyMetrics.forcePushes`: every force push run, including one that failed                                                                                                                                                                                                                                                                                                                      | How many force pushes were run, including `--force-with-lease` and failed ones. Use it to watch for risky history rewrites. |
| `ai.git.pr_created`       | count | `GitEfficiencyMetrics.prMetrics.created`                                                                                                                                                                                                                                                                                                                                                                 | How many pull requests were opened today, across your sessions.                                                             |
| `ai.git.pr_merged`        | count | `GitEfficiencyMetrics.prMetrics.merged`                                                                                                                                                                                                                                                                                                                                                                  | How many pull requests were merged today, across your sessions.                                                             |

Source: `src/metrics/git-efficiency-tracker.ts` — `emitMetrics()`

### MCP Server — Feedback Metrics

Emitted with the other metrics every 60 seconds, but only for feedback reported since the previous emit, so intervals with no new feedback have no data point.

| Metric Name         | Value | Attributes                                                                     | How Computed                                                         | What it tells you                                                                                                 |
| ------------------- | ----- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ai.feedback.count` | `1`   | `{developer, quality, session_id?, team_id?, project_id?, org_id?, repo_url?}` | One record per `nr_observe_report_feedback` call since the last emit | How many feedback reports you or your team have filed, split by the quality rating. Use it to track satisfaction. |

Source: `src/tools/workflow-tools.ts` — `FeedbackCollector.emitMetrics()`

### Delivery Self-Monitoring Metrics

Recorded by `HarvestScheduler` itself when data is lost, so loss is visible in New Relic. They ship on the metric cadence and are not scoped to a session or developer.

| Metric Name             | Value         | Attributes                                                                        | How Computed                                                                                                                                                 | What it tells you                                                       |
| ----------------------- | ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `nr.ai.dropped_events`  | dropped count | `{source: event_buffer \| retry_buffer, transport?: nr-events-api \| otlp}`       | Oldest events dropped when the event buffer or a retry buffer overflowed, drained once per harvest                                                           | Events lost before they could be sent. Non-zero means data is missing.  |
| `nr.ai.dropped_metrics` | dropped count | `{source: metric_aggregator \| retry_buffer, transport?: nr-metrics-api \| otlp}` | Invalid samples (non-finite values or invalid attribute types) rejected by the aggregator, or oldest metric snapshots dropped when a retry buffer overflowed | Metrics lost before they could be sent. Non-zero means data is missing. |

Source: `src/shared/harvest/harvest-scheduler.ts`

### Metric Aggregation

All metrics pass through the `MetricAggregator` before being sent. For each unique (name + attributes) combination, the aggregator emits a single `summary` metric with:

| Field   | Type   | How Computed               |
| ------- | ------ | -------------------------- |
| `count` | number | Number of `record()` calls |
| `sum`   | number | Sum of all values          |
| `min`   | number | Minimum value              |
| `max`   | number | Maximum value              |

The metric `type` is `summary` (not gauge). All four aggregated values are packed into a single NR Metric API record per (name + attributes) per harvest interval. The record also carries the configured metric harvest interval (default 60 seconds) as the top-level `interval.ms` key that the Metric API requires. It is the configured interval, not a measured window.

Source: `src/shared/harvest/metric-aggregator.ts`

### Local-only Metrics (Defined, Not Exported)

Every tracker below defines an `emitMetrics(aggregator)` method (or, for `TrendAnalyzer`, `emitWeeklySummaryEvent()`) that calls `aggregator.record(...)` for the metric names in its table. None of these methods are ever called: `emitSessionGauges()` in `src/transport/nr-ingest.ts` only calls `emitMetrics()` on `costTracker`, `efficiencyScorer`, `feedbackCollector`, `apiFailureTracker`, and `gitEfficiencyTracker` (see the Cost, Efficiency, API Failure and Git Metrics sections above). **Local-only — not currently exported to New Relic** for every metric name in this section; each tracker still computes and holds this data locally (available to the local dashboard and MCP tools via its own `getMetrics()`), it just never reaches the harvest loop.

| Metric Name                                | Value       | Attributes                                         | Defined In                                                                               |
| ------------------------------------------ | ----------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ai.tool.success_rate`                     | rate (0–1)  | `{tool}`                                           | `src/metrics/session-tracker.ts` — `SessionTracker.emitMetrics()`                        |
| `ai.bash.call_count`                       | count       | `{category}`                                       | `src/metrics/session-tracker.ts` — `SessionTracker.emitMetrics()`                        |
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

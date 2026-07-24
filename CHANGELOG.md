# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.3] - 2026-07-24

### Fixed

- **Subagent and transcript cursor files were never garbage-collected** — `.subagent-pos-<sessionId>-<agentId>` (written once per spawned subagent, including workflow-spawned agents) and `.transcript-pos-<sessionId>` files in the storage root accumulated indefinitely; heavy subagent or workflow usage could leave thousands of small files behind with no cleanup path. The periodic maintenance sweep now removes a subagent cursor once its parent session is no longer active and the cursor is older than the watcher's cold-scan window, and removes a transcript cursor once its session is no longer active and no companion buffer file remains for it.

## [1.14.2] - 2026-07-24

### Fixed

- **Generic-MCP self-report tools were never reachable** — `nr_observe_report_tool_call`, `nr_observe_report_session_start`, and `nr_observe_report_session_end` were fully implemented on `GenericMcpAdapter` but never registered on the running MCP server, so any client following the generic-MCP setup instructions in `docs/ADAPTERS.md` found no such tools on `tools/list`. They're now registered whenever the server starts in `--stdio` mode, with `nr_observe_report_tool_call` feeding into the same `SessionTracker`/ingest pipeline hook-driven platforms use.

## [1.14.1] - 2026-07-24

### Fixed

- **Native Windows session resolution** — the `--stdio` MCP server now resolves its Claude Code `session_id` on native Windows, where Claude Code interposes Git Bash between itself and the hook collector but launches the MCP server directly. The hook collector writes an additional breadcrumb keyed by the project's working directory (alongside the existing PID-keyed breadcrumb); the MCP server falls back to it, on any platform, whenever the PID-based lookup misses. Previously, affected sessions never resolved a real session ID, so dashboard History, weekly summaries, and model-performance metrics never populated for them.

## [1.14.0] - 2026-07-23

### Added

- **Google Antigravity platform adapter** — Preflight now detects and normalizes tool calls from Google Antigravity (2.0 / IDE / CLI) as a full `full-hooks` platform. Antigravity ships a real, first-party, documented `hooks.json` mechanism (`PreToolUse`/`PostToolUse`) covering every built-in tool call (`run_command`, `view_file`, `write_to_file`, `grep_search`, and more — see `docs/ADAPTERS.md` for the full map). Antigravity's hook payloads carry no field naming which event fired at all, so Preflight dispatches on payload shape instead (presence of a `toolCall` key means `PreToolUse`); because `PostToolUse` carries no tool name either, pairing is done by a `stepIdx`-derived ID rather than by tool name. Detection is explicit opt-in (`MCP_CLIENT=antigravity`) — no ambient environment variable is exposed for this purpose. Setup instructions (both MCP registration and the `hooks.json` entries) are in `docs/ADAPTERS.md`.

## [1.13.0] - 2026-07-23

### Added

- **Pi platform adapter** — Preflight now detects and normalizes tool calls from [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`). Pi sessions are detected via `PI_CODING_AGENT=true`, a real ambient environment variable Pi itself sets for exactly this purpose. Pi has zero MCP client support by deliberate design, so unlike every other `full-hooks` platform this adapter does not register an MCP server — setup instead uses `--local` mode (optionally backed by the existing background dashboard daemon on macOS) since nothing else keeps a Preflight process running for Pi sessions. Preflight ships a documented extension snippet (see `docs/ADAPTERS.md`) that translates Pi's own `tool_call`/`tool_result` extension events into the same shape Claude Code already sends, so built-in tool calls (`bash`, `read`, `write`, `edit`, `grep`, `find`) are captured and mapped to Preflight's standard vocabulary automatically once the extension is installed. Unlike opencode/Kilo Code, Pi's hook payload does carry a real success/failure signal (`event.isError`), so captured tool calls report their actual outcome rather than always reporting success. `ls` and any tool disabled by default have no structured coverage yet. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.12.0] - 2026-07-23

### Added

- **Kilo Code platform adapter** — Preflight now detects and normalizes tool calls from [Kilo Code](https://kilocode.ai) (`@kilocode/cli`). Kilo Code sessions are detected via `MCP_CLIENT=kilocode` or `NEW_RELIC_AI_PLATFORM=kilocode` (Kilo's documentation lists no ambient environment variable for the MCP server process itself, unlike several other platforms). Kilo CLI is a confirmed fork of opencode and shares its exact plugin-based interception mechanism — no external hooks.json, only an in-process plugin. Preflight ships a documented plugin snippet (see `docs/ADAPTERS.md`) that translates Kilo's own `tool.execute.before`/`tool.execute.after` plugin events into the same shape Claude Code already sends, so built-in tool calls (`read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `bash`, `webfetch`, `websearch`, `question`, `todowrite`, `todoread`, `plan`, `task`, `skill`) are captured and mapped to Preflight's standard vocabulary automatically once the plugin is installed. Kilo's hook payload carries no success/failure signal, so every captured tool call is currently reported as successful, and only `bash`/`read`/`edit`/`write` receive structured input metadata. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.11.0] - 2026-07-23

### Added

- **opencode platform adapter** — Preflight now detects and normalizes tool calls from [opencode](https://opencode.ai). opencode sessions are detected via `MCP_CLIENT=opencode` or `NEW_RELIC_AI_PLATFORM=opencode` (opencode's documentation lists no ambient environment variable for the MCP server process itself, unlike several other platforms). Unlike Claude Code, Kiro, Amazon Q, Droid, and Codex, which all send `PreToolUse`/`PostToolUse` hooks from an external hooks configuration, opencode has no external hooks file — its only interception point is an in-process plugin. Preflight ships a documented plugin snippet (see `docs/ADAPTERS.md`) that translates opencode's own `tool.execute.before`/`tool.execute.after` plugin events into the same shape Claude Code already sends, so built-in tool calls (`bash`, `read`, `write`, `edit`, `apply_patch`, `grep`, `glob`, `webfetch`, `websearch`, `skill`, `todowrite`, `question`) are captured and mapped to Preflight's standard vocabulary automatically once the plugin is installed. opencode's hook payload carries no success/failure signal, so every captured tool call is currently reported as successful, and only `bash`/`read`/`edit`/`write` receive structured input metadata. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.10.0] - 2026-07-22

### Added

- **OpenAI Codex platform adapter** — Preflight now detects and normalizes tool calls from [OpenAI Codex](https://developers.openai.com/codex) (CLI, IDE extension, and desktop app). Codex sessions are detected via `MCP_CLIENT=codex` or `NEW_RELIC_AI_PLATFORM=codex` (Codex's documentation lists no ambient environment variable for the MCP server process itself, unlike several other platforms). Codex's native `PreToolUse`/`PostToolUse` hooks use the same event vocabulary and field shapes Claude Code already sends, so built-in tool calls (shell commands, unified exec, `apply_patch` file edits, MCP tool calls, and subagent spawns) are captured and mapped to Preflight's standard vocabulary automatically once hooks are configured. Hosted tools such as `WebSearch` are not observable — Codex's own documentation confirms these never reach the local function-tool hook path. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.9.0] - 2026-07-22

### Added

- **Cline platform adapter** — Preflight now detects [Cline](https://cline.bot) (VS Code and JetBrains extension, formerly "Claude Dev"). Cline sessions are detected via `MCP_CLIENT=cline` or `NEW_RELIC_AI_PLATFORM=cline` (Cline doesn't forward ambient environment variables into an MCP server's own subprocess, unlike several other platforms, so there's no ambient variable to detect automatically). Cline's VS Code/JetBrains extension has no hook or callback mechanism for its built-in tool calls — confirmed against Cline's own documentation — so Preflight observes only calls Cline routes to Preflight's own MCP tools, the same visibility level as the existing Zed and Continue.dev adapters. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.8.0] - 2026-07-22

### Added

- **Google Gemini CLI platform adapter** — Preflight now detects and normalizes tool calls from [Gemini CLI](https://github.com/google-gemini/gemini-cli), Google's agentic command-line coding assistant. Gemini CLI sessions are detected via `MCP_CLIENT=gemini-cli` or `NEW_RELIC_AI_PLATFORM=gemini-cli` (Gemini CLI's documentation doesn't expose an ambient environment variable for the MCP server process itself, unlike several other platforms). Gemini CLI's hooks use their own event names (`BeforeTool`/`AfterTool` rather than `PreToolUse`/`PostToolUse`) but the same field shapes Claude Code already sends, so its built-in tool calls (`read_file`, `write_file`, `replace`, `run_shell_command`, `glob`, `grep_search`, `google_web_search`, `web_fetch`) are captured and mapped to Preflight's standard vocabulary automatically once hooks are configured. Gemini CLI also requires hook output to be valid JSON, so the collector now writes an empty JSON object to stdout for Gemini CLI invocations specifically, leaving every other platform's behavior unchanged. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.7.0] - 2026-07-22

### Added

- **Factory Droid platform adapter** — Preflight now detects and normalizes tool calls from [Factory Droid](https://factory.ai), Factory.ai's agentic CLI and IDE integrations. Droid sessions are detected via `MCP_CLIENT=droid` or `NEW_RELIC_AI_PLATFORM=droid` (Factory's documentation doesn't expose an ambient environment variable for automatic detection, unlike several other platforms). Droid's `PreToolUse`/`PostToolUse` hook events use the same shape Claude Code, Kiro, and Amazon Q already send, so its built-in tool calls (`Task`, `Execute`, `Glob`, `Grep`, `Read`, `Edit`, `Create`, `FetchUrl`, `WebSearch`) are captured and mapped to Preflight's standard vocabulary automatically once hooks are configured. Setup instructions are included in `docs/ADAPTERS.md`.

## [1.6.20] - 2026-07-21

### Fixed

- The client-side `AlertEvent` type in `src/web/api/client.ts` declared an optional `sessionId` field mirroring the server-side `AlertEvent` shape, but `AlertLog`'s runtime schema (`src/alerts/alert-log.ts`) never included `sessionId`, so `/api/alerts/recent` never actually returned it. Removed the dead field; `src/web/store/liveStore.ts` already had its own `AlertEvent` correctly omitting it, with a comment explaining why.

## [1.6.19] - 2026-07-21

### Fixed

- `src/web/lib/format.test.ts` and `format.test.tsx` covered disjoint sets of `format.ts` exports with zero overlap, and the `.test.ts` file silently ran under both Jest and Vitest — violating the documented Jest/Vitest routing split (`docs/TEST_PATTERNS.md`), which requires web tests to use `.test.tsx` only. Merged into a single `format.test.tsx`, and added coverage for `scoreColor`, `fmtDateTime`, `fmtTimeOfDay`, `fmtElapsed`, and `formatNumber`, which previously had no tests anywhere.

## [1.6.18] - 2026-07-21

### Fixed

- License-key/API-key validation (`install/key-validator.ts`) and the team-summary NerdGraph query (`tools/cross-session-tools.ts`) now run their outbound URL through the same SSRF validation (`validateSsrfUrl`) already applied to the proxy's outbound HTTP dispatch. Both build their URL from a fixed map of real NR hostnames, so this closes a consistency gap rather than a currently exploitable path.

## [1.6.17] - 2026-07-21

### Fixed

- OTel session spans were unconditionally tagged `'ai.platform': 'claude-code'` regardless of which platform was actually detected, so every non-Claude-Code session's trace data in New Relic was mislabeled. Spans are now tagged with the actual detected platform.
- `nr_observe_get_prompt_cache_health`'s recommendation text referenced "CLAUDE.md rules" specifically; it now says "instruction file rules" to match every platform's own instruction-file convention.

## [1.6.16] - 2026-07-21

### Added

- New MCP tool `nr_observe_mark_task_boundary` lets any AI coding assistant explicitly signal the end of a task. Claude Code already gets this boundary for free from its own `AskUserQuestion`/`TaskUpdate` tool calls, but platforms without an equivalent tool had no way to mark task boundaries, which reduced the accuracy of anti-pattern, efficiency-score, and cost-per-outcome metrics that segment activity by task.

## [1.6.15] - 2026-07-21

### Added

- Every platform adapter now declares which file(s) it treats as persistent agent instructions — Cursor's `.cursorrules`, Windsurf's `.windsurfrules` — in addition to the `CLAUDE.md`/`.claude/` convention already watched on every platform.

### Fixed

- `nr_observe_get_claudemd_impact` and `nr_observe_get_instruction_drift` only ever detected changes to a file literally named `CLAUDE.md`, so a Cursor or Windsurf project's real instruction file was invisible to both tools even though both platforms have the same tool-call visibility Claude Code does. Both tools now also watch each detected platform's actual instruction-file convention.
- `nr_observe_get_instruction_drift` previously matched any file path merely containing the substring `CLAUDE.md` (e.g. `NOT_CLAUDE.md`, `CLAUDE.md.bak`), not just the real instruction file. It now matches only the actual file.

## [1.6.14] - 2026-07-21

### Fixed

- `SubagentWatcher` decoded each 64KB poll read with a one-shot `toString('utf-8')`; a multi-byte character (emoji, non-ASCII) whose bytes straddled the read boundary was silently replaced with the Unicode replacement character and permanently lost, since the byte cursor had already advanced past those bytes. Decoding now goes through a per-file `StringDecoder`, which buffers an incomplete trailing byte sequence and reconstructs the character correctly on the next poll.

### Added

- Test coverage for `dashboard-health.ts` (`waitForHealthyDashboard()` and `getDashboardAddress()`), which had none despite gating the pass/fail signal shown by `preflight update` and the setup wizard's daemon-install flow.

## [1.6.13] - 2026-07-20

### Added

- `otlp`-related config fields are now grouped under a nested `otlp: {...}` object on the resolved server config, matching the existing `dashboard`/`alerts` nesting. The legacy flat top-level keys (`otlpEndpoint`, `otlpHeaders`, `otlpReceiverEnabled`, etc.) are still accepted in config.json for backward compatibility; using one now logs a deprecation warning naming the specific legacy keys consulted.
- Added an optional `configVersion` field to config.json (defaults to 1) establishing a documented convention for versioning non-additive config-shape changes going forward.

### Fixed

- Numeric config values sourced from a config file or CLI flag (harvest intervals, the local OTLP receiver port, the MCP server port, alert evaluation interval/log retention) bypassed the same min/max bounds that were already enforced on the equivalent environment variable — a config-file typo or a stray CLI flag could reach the harvest scheduler or HTTP server completely unclamped.
- `sessionBudgetUsd`, `dailyBudgetUsd`, `weeklyBudgetUsd`, and `retainSessionsDays` validated positivity only when sourced from an environment variable; a negative or zero value in config.json passed through untouched with no warning, silently disabling the cost guardrail or corrupting the retention window. These fields are now validated and a rejected value logs a warning before falling back to a safe default.

## [1.6.12] - 2026-07-20

### Added

- `retainSessionsDays` now defaults to 90 days instead of retention being off by default; set it to `null` explicitly in config.json to disable retention.
- Retention now also sweeps `weekly_summaries/`, not just `sessions/`, and re-runs every 6 hours instead of once at startup.
- `ContextWindowTracker.fileReadCounts` and `SessionTracker.filesRead`/`filesWritten` are now capped at 10,000 unique file paths per session, evicting the oldest-touched file first — previously unbounded, unlike every sibling capped structure in the same files.

### Fixed

- Orphan-buffer/breadcrumb/dead-instance GC only ran when the `--local` dashboard won its port bind, but the default `mode` is `cloud` (the documented stdio-MCP setup) — a crashed session in the default configuration leaked `buffer-<id>.jsonl` and heartbeat files forever. GC now runs unconditionally in every mode, independent of dashboard-bind status.

## [1.6.11] - 2026-07-20

### Added

- Every platform adapter now declares a `visibilityLevel` (`full-hooks`, `self-reported`, or `mcp-tools-only`) describing how much of a platform's built-in tool activity Preflight can actually observe — previously this distinction lived only in code comments, so a hook-visible platform and an MCP-tools-only platform looked structurally identical to every downstream consumer.
- Weekly summaries now include a `perPlatform` breakdown (sessions, cost, efficiency, tool calls, anti-patterns, tagged with visibility level), alongside the existing per-developer breakdown.

### Fixed

- `nr_observe_get_platform_comparison` and the weekly Slack digest blended metrics across platforms with different instrumentation coverage with no indication that differences might reflect what each platform lets Preflight observe rather than actual developer behavior. Both now tag results by visibility level and add a caveat when the platforms being compared span more than one level.

## [1.6.10] - 2026-07-20

### Fixed

- Proxy mode assigned every concurrent client the same fake shared session id (`sessionId: null` on every proxy tool call, one process-level id reused across all developers). Each proxy client's `AiMcpToolCall` events and per-tool metrics now carry a distinct per-connection session id, resolved from the MCP `Mcp-Session-Id` request header when present and otherwise generated per TCP connection.
- Proxy mode emitted `ai.session.duration_ms`/`unique_files_read`/`unique_files_written` gauges reflecting a single never-populated session tracker (e.g. a week-long proxy process reporting a multi-day session duration with zero file activity). These gauges are no longer emitted in proxy mode.
- The on-disk security audit log was never populated in proxy mode because no local store was wired up for it; proxied tool calls are now persisted to the audit log like stdio/local traffic.
- Documented that the proxy's stdio upstream transport shares one child-process connection across all concurrent clients — safe for stateless MCP servers, not for stateful ones.

## [1.6.9] - 2026-07-20

### Changed

- The MCP server's tool registration was centralized in one 1476-line file: a single function built the `tools/list` array from a ~30-condition if-chain and dispatched `tools/call` through a ~760-line switch, referencing tool definitions and handlers scattered across five sibling files that had no registration logic of their own. Each sibling file now exports its own `registerXTools()` — a small declarative list of its tools, their availability conditions, and their handlers — and the main registry composes all of them into the server's single `tools/list`/`tools/call` handler pair. No user-visible behavior change.
- The ~40 near-identical "tracker not available" error blocks in that dispatch switch are now built from two shared helpers (`requireTracker`/`requireAvailable`) instead of being copy-pasted per tool.

## [1.6.8] - 2026-07-20

### Fixed

- Metric tracker `reset()` signatures had drifted across `src/metrics/`: some took zero arguments, some silently ignored their `sessionId` parameter, and one tracker had no `reset()` at all — a generic session-boundary dispatch loop couldn't type-check across trackers. All ten affected trackers now implement a shared `Resettable` interface with a consistent `reset(sessionId: string): void` signature.
- `TaskDetector`'s per-task cost/token delta silently clamped to zero when `CostTracker`'s cumulative totals decreased between a task's start and close (e.g. from an out-of-order `reset()`), with no diagnostic trail. That case now logs a warning with the raw delta before clamping.
- `TaskCompletionTracker.recordToolCall()` was a literal no-op with no visibility into why; it now logs at debug level.

## [1.6.7] - 2026-07-20

### Security

- The hook collector binary's secret-redaction pattern list had fallen out of sync with the canonical list used elsewhere in the server, missing coverage for database connection strings with embedded credentials, Stripe/PyPI/HuggingFace tokens, Twilio SIDs, and Azure SAS tokens. Both now import from a single shared pattern list, so the two can no longer drift.

### Fixed

- The "Evicting non-orphan pre-event due to capacity overflow" warning was masking the actual pending-event identifier behind `***`, for the same reason as the 1.6.6 fix — the log field's own name was treated as sensitive by the secret-redaction logic. The warning now shows the real identifier.
- The `recordContent` gate (which `highSecurity` forces off) was implemented independently in two places with duplicated logic. Both now call one shared function so the behavior can't diverge between them.

## [1.6.6] - 2026-07-19

### Fixed

- The "Unknown keys in config file (ignored)" warning (and its `alerts`/`dashboard` variants) was masking the actual unrecognized key names behind `***`, since the secret-redaction logic treated the log field's own name as sensitive. The warning now shows the real key names, so a typo'd or stale config field is actually visible in the logs.

## [1.6.5] - 2026-07-19

### Removed

- `CROSS_SESSION_TOOLS`, `registerSessionTools`, and an unused internal module that only re-exported already-directly-imported tool functions — none had any real consumers.
- `TaskOutcomeEvent` and `CostAccumulationContext` (a deprecated alias) — cost-tracking types with zero references anywhere.
- `LocalAlertRuleType` and `AlertChannel` — unused alert-rule type aliases.
- `useRecentWorkflows` — a dashboard store selector with zero real consumers.

## [1.6.4] - 2026-07-19

### Fixed

- Resolved a batch of TypeScript type errors in the web dashboard's source code that weren't being caught by the project's normal build and lint checks. No user-visible behavior change.

## [1.6.3] - 2026-07-18

### Changed

- Cleaned up outdated, duplicated, and unclear comments across the entire codebase — the metrics engine, MCP server tools and installer, platform adapters, storage, proxy, alerting, transport, security, tracing, digest delivery, and the web dashboard — for accuracy. No user-visible behavior change.

## [1.6.2] - 2026-07-18

### Fixed

- Internal bookkeeping session IDs from `--local` and proxy mode could occasionally still show up in the session list, live sessions view, or concurrency chart, since each dashboard endpoint filtered them independently and inconsistently. That filtering is now applied once, centrally, wherever session data is loaded, so it can no longer be missed for any given view.

## [1.6.1] - 2026-07-18

### Fixed

- Developer collaboration profiles previously showed the same values for every developer because real conversation activity wasn't being counted. Message and correction counts are now derived from the actual session transcript, so specificity, autonomy, and correction-rate scores reflect real usage. This also corrects the correction-rate figure surfaced in CLAUDE.md impact analysis and in prompt-engineering recommendations.

## [1.6.0] - 2026-07-17

### Added

- A normalized cost-rate metric, cost per million tokens, so spend can be compared across sessions and models independent of raw token volume. A session-blended rate (across input, output, thinking, cache-read, and cache-creation tokens) is available from `nr_observe_get_cost_breakdown`, and a per-model rate (input+output tokens) is available from `nr_observe_get_model_usage` and shown in the dashboard's Today and History views.

## [1.5.6] - 2026-07-17

### Fixed

- The Today page's "Concurrent Sessions" chart could show a taller peak bar than the headline peak number above it. Both are now computed from the same activity-window model, so an idle-but-not-yet-ended session no longer inflates the chart above what the headline reports.

## [1.5.5] - 2026-07-17

### Fixed

- Opening a workflow run's detail view while the run was still in progress showed "Failed to load run details" instead of live progress. The detail view now shows in-progress agent activity and automatically upgrades to the final summary once the run completes.

## [1.5.4] - 2026-07-17

### Added

- Added test coverage across the MCP server's session and hook handling, metric trackers, platform adapters, proxy and transport layer, storage, alerting, and MCP tool handlers, plus the web dashboard's components, views, and API client — covering error paths, malformed-input handling, and edge-case behavior that previously worked but was unverified.

### Fixed

- Corrected an ambiguous assertion in the Today view's test suite that could match either of two KPI tiles rendering the same value, instead of the one it was meant to check.

## [1.5.3] - 2026-07-16

### Fixed

- The dashboard's live-session view now aggregates anti-pattern occurrences by type before returning them, instead of returning a mismatched shape the frontend couldn't render correctly.
- Replaced an unsafe type cast used to attach turn attribution to tool-call records with a properly-typed record construction; no change to the attribution data itself.
- The hook event buffer's internal type now reflects that each buffered line has a different shape depending on its mode, removing an unchecked type cast from the event-processing pipeline.

## [1.5.2] - 2026-07-16

### Changed

- Tightened internal typing across the MCP server, platform adapters, config loading, transcript parsing, and storage layers — replacing loosely-typed values with concrete types wherever the underlying data was already validated or structurally known. No user-visible behavior change.

## [1.5.1] - 2026-07-16

### Fixed

- The subagent transcript watcher now emits a health event instead of silently skipping a transcript file whose filename doesn't match the expected agent-id shape, so a future change to that format would be observable instead of silently reintroducing lost subagent cost tracking.
- The workflow watcher no longer accumulates unbounded internal bookkeeping for the life of the process; stale tracking entries are evicted on each poll instead of persisting indefinitely.
- Both the subagent and workflow watchers now go straight to the active session's own directory when tracking a single session, instead of listing every session on disk on every poll.
- The session trace's Gantt timeline no longer re-sorts and rebuilds its highlight state on every mouse movement, and its bars now expose an accessible name to assistive technology.
- Fixed a missing file extension on an internal module import.

### Added

- Added test coverage for the Sessions view's workflow-consolidation logic: KPI aggregation across workflow runs, run-source and status filtering, the session/run/agent expansion tree, and the in-place workflow-run detail view.

## [1.5.0] - 2026-07-15

### Added

- Subagent and workflow-script cost tracking: tokens spent inside Task-tool subagents and Workflow-tool script runs were previously invisible to cost tracking, meaningfully undercounting real spend on agentic sessions. Preflight now watches subagent and workflow transcripts directly, attributes their cost and token usage to the parent session, and reports it as a distinct breakdown alongside the parent session's own spend.
- A unified session trace: parent tool calls, subagent fan-out, and workflow-run structure now render together in one attributed timeline (Gantt and list views), with drill-down into individual subagent calls.
- Workflow-run visibility: a dedicated list and detail view showing per-run status, duration, agent count, and per-agent breakdown, including declared vs. observed phase and parallelism topology for script-based workflows.
- Observability health status: watcher active/disabled state, files watched, and parse-error counts are now surfaced in Settings, replacing an environment-variable-based check that never worked in the browser.

## [1.4.47] - 2026-07-15

### Fixed

- The live dashboard's pre-connection anti-pattern hydration now maps the server's anti-pattern fields (file/command, iteration/read/repeat/edit/agent counts) onto the display shape correctly, instead of leaving the target file and count blank until the first live event arrives.

## [1.4.46] - 2026-07-15

### Fixed

- The OTLP receiver now closes its outbound connection pool when stopped, and no longer hangs if closing that pool fails, instead of leaving the pool open for the life of the process.
- Corrected a test assertion in the alert banner suite that no longer matched the component's real number formatting.

## [1.4.45] - 2026-07-15

### Fixed

- Fixed `nr_observe_get_decision_tree`'s `reasoning` field always being one of 3 hardcoded template strings instead of the model's actual reasoning. When content recording is enabled and the underlying model exposes plaintext thinking or visible text for that turn, the field now reflects the model's real reasoning (passed through the existing redaction filter), falling back to the prior rule-based label when the model exposes no plaintext reasoning.

## [1.4.44] - 2026-07-15

### Fixed

- Fixed instruction/prompt drift tracking correlating on the arguments of a `Read` tool call (file path, offset, limit) instead of the target file's actual content, which produced false drift signals when re-reading an unchanged file at a different offset or limit, and missed real content changes read at an identical offset/limit.

## [1.4.43] - 2026-07-14

### Fixed

- Fixed the WSL-hosted collector failing to read Windows-style transcript paths sent by desktop Claude Code, which silently dropped all token/model/cost collection for `wsl-windows-cc` installs.
- Fixed `resolveBinaryPath()` splitting `PATH` on `:` instead of the platform delimiter and never probing npm's `.cmd`/`.ps1` shim extensions, which always returned null on native Windows — causing a false "not on PATH" warning, loss of absolute hook-path resolution, and a stalled hook upgrade when switching from WSL to native Windows installs.

## [1.4.42] - 2026-07-14

### Added

- Added test coverage for the proxy-request and context-snapshot NR event ingestion paths, the security-alert event wiring inside tool-call ingestion, additional sensitive-file/destructive-command/network-request detection patterns, and SSE heartbeat/cleanup edge cases in the live dashboard event stream.

## [1.4.41] - 2026-07-14

### Added

- Added automated test coverage for previously untested (but correct) routes and branches in `src/dashboard/routes/api-handler.ts`: cache health, quality proxy, tool selection score, git efficiency (+ repos), context, model usage, activity heatmap, settings (read + write), digest send, and the concurrency endpoint's peak/all-time-peak fields and history-view live-peak override. No behavior changes — this is a test-only hardening release.

## [1.4.40] - 2026-07-14

### Fixed

- Today.tsx's empty-state gate omitted concurrency/activity-heatmap/live-session pending state, letting the empty state show briefly even as a live session registered.
- History.tsx and Alerts.tsx now surface query load errors instead of silently rendering as "no data yet."
- Git Efficiency's branch-divergence and repo-context now derive the real default branch instead of assuming `main`.
- `formatDuration` now guards against non-finite/negative input, matching `formatNumber`'s existing guard.
- Alerts.tsx's Slack Digest card now shows a loading indicator while settings load, matching the cards above it.
- Audit.tsx's classification Pill now shows the friendly label instead of the raw internal key.
- Removed `Kpi`'s redundant `tone="accent"`, which rendered identically to `tone="good"`.
- Corrected a stale comment in `liveStore.ts` overstating cross-path dedup guarantees for live tool-call events.

## [1.4.39] - 2026-07-14

### Fixed

- Proxy stdio upstream: expanded the dangerous env-var denylist to cover non-Node interpreters (`PYTHONPATH`, `RUBYOPT`, `PERL5LIB`, and others) that an operator-configured stdio upstream command could be pointed at.
- Proxy stdio upstream: a dispatch timeout now aborts the underlying MCP client call instead of only racing past it, so a wedged child process no longer accumulates abandoned in-flight requests.
- Proxy OTLP receiver: resource-attribute enrichment no longer duplicates a key the instrumented application already set on the payload.

## [1.4.38] - 2026-07-14

### Fixed

- `undici` is now a direct runtime dependency. `src/proxy/otlp-receiver.ts` imports it directly, but it was declared only as a version `overrides` pin (added for security hardening), never as an actual dependency — so a clean `npm install`/`npm install -g` (no devDependencies) never installed it, and the proxy crashed with `ERR_MODULE_NOT_FOUND: undici` on startup. It previously worked in this repo's own dev/CI environment only because `jsdom` (a devDependency) pulls in `undici` transitively.

## [1.4.37] - 2026-07-13

- Added automated test coverage for previously untested (but correct) branches across `src/install/`: `migrate.ts`'s legacy-storage-path merge/rollback logic, the `validate` CLI command, graceful process-kill escalation, several setup-wizard prompt/fallback paths, config-diagnostics edge cases, and `json-utils.ts`'s JSON parsing helpers (which previously had no dedicated test file at all). No behavior changes — this is a test-only hardening release.

## [1.4.36] - 2026-07-13

- Typed the last 7 `client.ts` response contracts, consumed by the Settings, Alerts, ContextBar, and Audit views (`fetchAuditLog`, `fetchContext`, `fetchSettings`, `fetchDiagnostics`, `patchSettings`, `postDigestSend`), removing the `as Promise<T>` casts these views previously needed. Also removed the unused `fetchSessionToday` export, which had zero consumers. This closes the effort to type the rest of the dashboard's API layer (#141) — every exported function in `client.ts` now has a real response interface instead of `Promise<unknown>`.

## [1.4.35] - 2026-07-13

- Typed 7 more `client.ts` response contracts consumed by the History, Sessions, and Git Efficiency views (`fetchWeekly`, `fetchCostPerOutcome`, `fetchPersonalCoach`, `fetchConcurrencyHistory`, `fetchSessionDetail`, `fetchGitEfficiency`, `fetchGitEfficiencyRepos`), removing the `as Promise<T>` casts these views previously needed. Part of an ongoing effort to type the rest of the dashboard's API layer (#141).

## [1.4.34] - 2026-07-13

### Fixed

- The Today view's dashboard API client now returns fully typed response interfaces for 15 API functions (`fetchCost`, `fetchSessionCurrent`, `fetchSessionsList`, `fetchTodayAggregate`, `fetchAntiPatterns`, `fetchConcurrency`, `fetchActivityHeatmap`, `fetchLiveSessions`, `fetchQualityProxy`, `fetchToolSelectionScore`, `fetchLatency`, `fetchModelUsage`, `fetchCacheHealth`, `fetchSessionReplay`, and `fetchRecentAlerts`) instead of the previous `Promise<unknown>`, eliminating the matching type-cast assertions at their call sites. This enables compile-time type checking to catch backend/frontend field mismatches before deployment. Part of an ongoing effort to type the rest of the dashboard's API layer (#141).

## [1.4.33] - 2026-07-13

### Fixed

- Audit view's "Export JSONL" button exported every audit entry regardless of the active classification filter or the 200-row display cap. Now exports exactly what's shown on screen.
- Sessions view never rendered the `filesRead` or `antiPatterns` data the backend already computes for each session. Now shows a "Files Read" list and "Anti-Patterns" pills (reusing the same taxonomy labels used elsewhere in the session replay view) when present.
- Dashboard's System Health diagnostics panel always ran the Claude-Code-specific hooks-wired check, regardless of which coding platform was actually detected — non-Claude-Code users (Cursor, Windsurf, etc.) saw a false "Hooks wired: fail" result. Now forwards the detected platform, which the existing check already knew how to handle correctly.

## [1.4.32] - 2026-07-13

### Fixed

- The activity heatmap grid (History view's "Activity · Last 12 Weeks" panel) placed every day one row early for any user in a timezone west of UTC — the backend sends genuinely UTC-anchored day keys, but the frontend read them back with local-time accessors. Now reads them with UTC accessors to match.

### Removed

- `StatusIndicator` and `Sparkline` — two fully-built, fully-tested dashboard components with zero real consumers anywhere in the app. Removed along with their test suites.
- An unreachable dead-code branch in `HourlyCostBlocks`' internal `describeChart()` helper, guaranteed unreachable by its only caller's own guards.

## [1.4.31] - 2026-07-13

### Fixed

- The Audit view's classification Pill rendered every entry with the same neutral gray tone, even for `destructive_command`/`sensitive_file` entries with a genuinely critical or high severity. The backend now forwards the computed severity, and the Pill is color-coded accordingly (red for critical, amber for high).
- Four labels in the History view had drifted from the real fetch parameters they describe: "Weekly Efficiency · Last 8" (the real default is 12 weeks), the activity heatmap's screen-reader label claiming "last 4 weeks" (it's 12), "Peak Concurrent Sessions · All-Time" (the underlying fetch is always 30-day-bounded, never all-time), and "Daily Spend"/"Top Tools" panels that could silently understate their scope for very high-volume users due to an underlying 200-session fetch cap — both now carry a clarifying label.
- The Git Efficiency view's "Today's activity across all sessions" silently excluded a session that started before local midnight and crossed into today — hydration now uses the overlap-aware session lookup already used elsewhere in the codebase for the same cross-midnight gap. Separately, the "Verified before push" indicator couldn't see a build/test that ran in an earlier session today when replaying that session's history, always showing "no build/test detected" in that case even when verification genuinely happened; the replay path now carries that signal through correctly.

## [1.4.30] - 2026-07-12

### Fixed

- The "Alert Thresholds" card claimed these five values feed "the local alert engine" and require a server restart. Neither is true — the real (and only) consumer is the separate `deploy-alerts` CLI, which templates cloud alert conditions and reads config fresh on every invocation. Subtitle and save-confirmation copy corrected.
- Clicking "Unsubscribe" on the Slack digest webhook left an unsaved, stale edit visible in the input box even though the adjacent status Pill correctly flipped to "Not configured." The input now resets to server truth immediately.
- The session detail page's "Outcome" card always showed one of exactly two hardcoded values (`completed`/`in progress`) — no real outcome classification exists. Relabeled as "Status" to accurately reflect it as a running-state indicator, not a quality/outcome classification.
- The session detail page's "Session Quality" and "Tool Selection" cards were fully built but never rendered: the backing tracker data was never attached to any of the three `/api/sessions/:id` response branches. Now attached to the branches where the data is actually available (the live session and, for quality, persisted sessions via their own stored timeline).
- The Today view's anti-pattern banner rendered a literal `?` instead of a real count for `stuck_loop`, `blind_editing`, and `over_delegation` patterns when reached via its non-SSE API-fallback path — the fallback chain only checked 3 of the 6 possible count fields. Extended to check all of them.

## [1.4.29] - 2026-07-12

### Fixed

- `SECURITY.md`'s audit-trail network-request pattern list said `curl`, `wget`, `fetch`; the real pattern list is `curl`, `wget`, `nc`, `ssh`. Docs corrected.
- `REDACT_FIELD_KEYS` (the allowlist controlling which extra `AiToolCall` string fields get redacted before reaching New Relic) was missing five fields that `src/hooks/tool-parsers.ts` produces: `commandDescription`, `taskSubject`, `grepPath`, `globPath`, and `agentTeamName`. These now pass through `redactSensitive()` like every other tool-specific string field.

## [1.4.28] - 2026-07-12

### Fixed

- CLAUDE.md attributed hook-event buffer appends to `LocalStore`; the real writer is `collector-script.ts`'s own raw file-append logic. `LocalStore` genuinely owns the drain side (rename-then-read) — only the append-side attribution was wrong. Docs corrected.
- Multiple places claimed weekly Slack digest delivery happens automatically on a configured schedule: `docs/COMMANDS_TABLE.md`'s example response, the product documentation's feature description, and the `nr_observe_subscribe_digest` tool's own runtime response message. No scheduler exists — delivery is manual-only via `nr_observe_send_digest`. All three now say so; `digestSchedule` is documented as stored for future use only.

## [1.4.27] - 2026-07-12

### Fixed

- `LocalStore.saveSession()` and `loadRecentSessions()` were a parallel, unused session-persistence implementation with zero non-test call sites — every real session-persistence path goes through the separate `SessionStore` class instead. Removed both methods and their tests.
- `buildSessionSummary()` redacted `timeline[].filePath` via `redactSensitive()` but persisted `filesRead`/`filesModified`/`sessionName`/`repoName` unredacted, even though they're sourced from the same underlying task data. All four now go through the same redaction call for consistency.
- `SessionStore.saveSession()` now logs a warning when it's about to overwrite an existing session file for the same `sessionId`+date — the scenario a resumed/forked session running two MCP processes against one real session ID would produce. The overwrite behavior (last-write-wins) is unchanged; this only makes a previously-silent collision visible.

## [1.4.26] - 2026-07-12

### Fixed

- `json-utils.ts` exported a lenient JSON reader, `readJsonFile()`, with zero production callers — the only historical caller was replaced after it caused a real credential-wipe bug (a permission error was silently swallowed into `{}`, which was then written back over `config.json`, erasing `licenseKey`/`accountId`). The dead function has been removed; `readJsonFileStrict()` remains the only JSON reader in `src/install/`.
- `src/install/index.ts`, a barrel module re-exporting install-CLI symbols, had zero reachable consumers — every real call site already imports directly from `./cli.js` or `./install-helper.js`, and `package.json`'s `exports` field never exposed the compiled barrel to external consumers either. Removed.

## [1.4.25] - 2026-07-12

### Fixed

- `docs/ADVANCED.md` claimed the inbound OTLP receiver enriches "any OTel-instrumented app" pointing at it with session context, without noting this only applies to JSON-encoded OTLP payloads — most production OTel SDKs default to protobuf, which the receiver has always forwarded unmodified. The headline claim now states the JSON-only scope directly.
- The OTLP receiver's Bearer-token check compared header length before running its timing-safe content comparison, leaking the correct API key's length via response-time differences. Both sides are now hashed to a fixed-length digest before comparison, removing the length-dependent branch entirely.
- The OTLP receiver's per-IP rate limiter pruned expired request timestamps down to an empty array but never removed that array from its internal map, so every distinct source IP that ever made one request left a small permanent entry for the life of the process. Empty entries are now deleted instead of retained.
- Documented the previously-unlisted `otlpReceiverBindAddress` config field (env `NR_AI_OTLP_RECEIVER_BIND_ADDRESS`) in `docs/ADVANCED.md` and `CLAUDE.md`, including a note that widening it beyond the `127.0.0.1` default increases exposure to the two fixes above.

## [1.4.24] - 2026-07-12

### Fixed

- Standalone proxy mode's SSRF protection validated the literal hostname string of a configured upstream/forward URL, but re-checked the exact same unchanged string a second time immediately before every network call — providing no real protection against DNS rebinding (a hostname resolving to a safe address when first validated, then to `127.0.0.1` or a cloud metadata address before the connection is actually made). Both `HttpUpstream` (proxy forwarding) and `OtlpReceiver` (OTLP forward endpoint) now resolve the hostname exactly once at connection time via a custom DNS lookup, validate every resolved address against the same blocklist rules, and pin the actual connection to that validated address.
- Two proxy upstream transports returned raw error detail to HTTP clients on failure: `HttpUpstream` included the literal connection-error text (which can contain the upstream's host:port) in its JSON error body, and `StdioUpstream` forwarded a failed child process's raw error message (which can include file paths or tool-echoed arguments) straight through as the JSON-RPC error message. Both now return only a generic error code/message to the client; the full detail is still logged server-side.

## [1.4.23] - 2026-07-12

### Fixed

- `buildReplayResponse()`'s main persisted-session path passed its timeline straight to `analyzeReplayTimeline()` with no sort, unlike its two fallback branches which both sort before analysis. Nothing upstream guarantees a persisted timeline is chronological (session persistence is append-only), so an out-of-order timeline could silently produce wrong anti-pattern segment boundaries and iteration counts with no error raised. The persisted-session path now sorts before analysis, matching the fallback branches.
- `static-handler.ts`'s explicit path-traversal pre-check only split incoming paths on `/`, so a request built entirely from backslash-delimited `..` segments (no forward slashes at all) passed this specific check unchecked. The check now also splits on `\`, closing the gap in the primary sanitizer.
- Removed `DashboardServer.registerRoute()`, a public method with no callers and no test coverage. Corrected a stale comment on `LiveEventBus`'s `setMaxListeners(200)` call that understated both the per-connection listener count (5, not 4) and the resulting connection headroom (200 concurrent connections, not 40 or 50 — `setMaxListeners` caps per event name, not in aggregate).

## [1.4.22] - 2026-07-11

### Fixed

- `setup-wizard.ts`'s background-dashboard-daemon install step reported success right after `launchctl load` returned without throwing, which only confirms the plist loaded, not that the daemon process actually came up healthy — a plist can load successfully while the spawned process immediately crashes. It now polls the dashboard's `/api/health` endpoint via the same `getDashboardAddress()`/`waitForHealthyDashboard()` helpers `cli.ts`'s `update` command already uses, and downgrades the success message to a warning (with `launchctl list` / log-file pointers) when the health check fails.
- `checkStorageWritable()` used `accessSync(W_OK)` alone, which succeeds identically for a writable file and a writable directory — a corrupted install with a plain file sitting at the storage path would falsely report "ok" while `LocalStore`'s downstream `mkdirSync()` calls would fail with `ENOTDIR`. It now also calls `statSync().isDirectory()` and reports a distinct "exists but is not a directory" failure (with a `rm && mkdir` fix suggestion) when the path exists but isn't a directory.

## [1.4.21] - 2026-07-11

### Fixed

- Standalone HTTP-proxy mode sent zero telemetry to New Relic — `ProxyManager`'s `onToolCall`/`onRequest` callbacks were wired to `logger.debug()` only, and `NrIngestManager` was never constructed on that code path, so `AiMcpToolCall`/`AiProxyRequest` events, the `ai.mcp.*` proxy gauges, and audit-trail security recording for proxied tool calls never fired. Proxy mode now constructs and starts an `NrIngestManager` (gated on `mode !== 'local'`, matching the existing `--stdio`/`--local` behavior) and feeds it from the proxy callbacks.
- If the local OTLP/HTTP receiver failed to start (e.g. port already in use), proxy mode continued reporting itself healthy with the receiver silently absent, with no signal beyond a log line. `ProxyManager` now tracks OTLP receiver status (`disabled` / `running` / `failed`) and surfaces it in the `GET /health` response whenever the receiver is enabled, and the failure is now logged at `error` level.

## [1.4.20] - 2026-07-11

### Fixed

- `LocalStore`'s crash-recovery drain merge could silently drop a hook event that `preflight-collector` wrote in the narrow window between the merge's read of the live buffer and its overwrite of that buffer with the merged content. Recovery now extracts the leftover `.drain` file's events in memory and lets the buffer's own already-atomic claim-and-drain path (rename, not read-then-overwrite) handle the live buffer, so a concurrent append can never be clobbered.
- `WeeklySummaryGenerator.generate()`'s write was a single non-atomic `writeFileSync`; a crash mid-write (SIGKILL, OOM, host crash) left a truncated/invalid JSON file that still passed the shutdown handler's `existsSync()` check, permanently corrupting that week's backfill slot. The write now goes through a temp file plus atomic rename.
- `getLatest()` returned `null` outright if the single lexicographically-latest weekly summary file was corrupt, blinding every caller (including `nr_observe_get_weekly_summary`'s no-arg/`"latest"` path) to all older, still-valid summaries. It now falls back to the next-most-recent valid file.
- Requesting a nonexistent ISO week (e.g. `"2025-W53"` — 2025 only has 52 weeks) silently returned a real-looking but wrong date range that actually overlapped the following year's week 1. `getWeekDateRange()` now rejects such inputs, and `nr_observe_get_weekly_summary` returns a clean error instead of a misleading result.

## [1.4.19] - 2026-07-10

### Fixed

- `nr_observe_get_context_composition`'s per-turn token breakdown claims 4 categories (system prompt, conversation history, tool results, injected files), but two of them — `system_prompt` and `injected_file_content` — are always 0: the model API's usage response only reports aggregate input/cache-read/cache-creation token counts, with no breakdown by content category, so Preflight has no way to separate those two categories from the rest. `fillPercent` and the dominance alerts are unaffected and reflect real totals. The tool's response now carries an explanatory `note` field on every call, and the registered description now discloses the limitation.
- `nr_observe_get_decision_tree`'s `reasoning` field reads like extracted reasoning but is always one of 3 fixed rule-based labels (e.g. "recovery after X failure") — `DecisionTracker.recordToolCall()` has no parameter carrying actual model reasoning text. Branches are also only recorded on 3 narrow triggers, not on every turn, so `totalBranches` undercounts ordinary turns relative to a literal "per turn" reading. The tool's response (including the `post_mortem: true` path) now carries an explanatory `note` field, and the registered description no longer claims "reasoning...extraction."

## [1.4.18] - 2026-07-10

### Fixed

- `nr_observe_get_latency_decomposition`'s code comment and documentation both falsely claimed the tool "only" needs proxy-mode instrumentation to work. Verified false: Preflight's proxy mode forwards requests to MCP servers, not to the model API, so its visible latency is MCP-server latency, not model-API latency — the same architectural gap found in the `nr_observe_get_api_failures` fix above. Unlike that tool, this one's runtime behavior was already safe (it's never listed in `tools/list`, and a direct call already returns an explicit error rather than misleading data), so this fix corrects the false claims in the code comment, the direct-call error message, and the docs table — no runtime behavior, registration, or data shape change beyond adding an explanatory `note` field to the existing error response.

## [1.4.17] - 2026-07-10

### Fixed

- `nr_observe_get_api_failures` always silently reported zero API failures — `ApiFailureTracker.recordRequest()`/`.recordFailure()` had zero call sites in production. Investigating this one further than the others: model-API-level failure data (rate limits, timeouts, auth errors from the LLM provider itself) is not observable anywhere in Preflight's current architecture, in either mode. Claude Code hook events only see Claude Code's own tool calls, not the underlying model-API traffic, and Preflight's proxy mode forwards requests to MCP servers, not to the model API itself — there is no LLM-facing proxy in this codebase today. Rather than fabricate a substitute signal, the tool's response now carries an explicit `dataAvailable: false` field and an explanatory `note` on every call, so a caller can no longer mistake the permanent all-zero output for "no failures occurred." Building a real LLM-facing proxy to make this data genuinely observable remains a separate, much larger effort.

## [1.4.16] - 2026-07-10

### Fixed

- `nr_observe_get_instruction_drift` always reported an empty dataset — `InstructionDriftTracker.recordSessionOutcome()` and `.loadRecords()` had zero call sites in production. Fixing this required cross-session persistence, not just in-process wiring: each MCP server process is scoped to one Claude Code session, so recording an outcome right before shutdown alone would be lost immediately and never enable the cross-session correlation the tool exists to provide. The session's prompt hash is now persisted on the saved session summary, the last 7 days of prior sessions are reloaded into the tracker at startup, and the current session's own outcome is recorded at shutdown. Note: correlation is currently keyed on the hash of the `Read` tool's arguments (file path/offset/limit), not the file's content, so this detects read/path drift rather than CLAUDE.md content changes — hashing actual content remains a separate, larger fix.

## [1.4.15] - 2026-07-10

### Fixed

- `nr_observe_report_feedback` recorded user quality feedback but never emitted it — `FeedbackCollector.emitMetrics()` was never called from the harvest flush, so `ai.feedback.count` never reached New Relic. Fixed by wiring `emitMetrics()` into the harvest flush alongside the existing `costTracker`/`efficiencyScorer` metrics. Also fixed a latent double-counting bug found while wiring this in: `emitMetrics()` had no cursor, so calling it on every harvest flush (as this fix now does) would have re-emitted every historical feedback record on every subsequent flush; it now tracks a `lastEmittedIndex` cursor, mirroring `EfficiencyScorer`'s existing pattern. Does not implement an actual correlation between feedback and efficiency scores — that remains a separate, larger fix.

## [1.4.14] - 2026-07-10

### Fixed

- **v1.4.13's path-containment fix did not actually clear the CodeQL `js/path-injection` findings it targeted** — that release replaced a runtime-derived separator check with two hardcoded literal checks combined with `||`, but that combination is never recognized by CodeQL as a sanitizer, regardless of whether the literals are hardcoded or the check is inlined. Confirmed by pushing several candidate shapes directly to a disposable test repository and inspecting the actual scan result rather than relying on pull-request-level checks (which don't reliably reflect whether a pre-existing finding was resolved). `isWithinRoot()`'s containment check is now `path.relative()`-based, inlined directly at the point of use, which is the shape confirmed to satisfy CodeQL's sanitizer recognition. Windows correctness is now handled by Node's own platform-aware `path.relative()`/`path.isAbsolute()` rather than hand-rolled separator matching.

## [1.4.13] - 2026-07-10

### Fixed

- **Static-asset path-containment check flagged by GitHub CodeQL as a potential path-injection sanitizer gap** — `isWithinRoot()` in the dashboard's static file handler checked one hardcoded `'/'` plus a runtime `path.sep`-derived fallback (needed so Windows' backslash-joined paths still pass the containment check). CodeQL cannot statically verify that a runtime value equals `'/'`, so it stopped recognizing the fallback branch as a valid sanitizer and flagged the file reads that follow. Both branches are now hardcoded literal checks (`'/'` and `'\\'`), which CodeQL recognizes as the standard path-containment pattern, with no change in behavior on either platform.

## [1.4.12] - 2026-07-10

### Fixed

- `nr_observe_get_platform_comparison` could never differentiate platforms — `buildSessionSummary()` never set the `platform` field on persisted session summaries, so every session fell into the `'claude-code'` fallback bucket regardless of which of the 9 real platform adapters generated it. The active platform (already detected once per process by `PlatformRegistry`) is now threaded through `HookEventProcessor.activePlatform` into every persisted session summary. Does not address the related `nr_observe_get_collaboration_profile` bug (missing `userMessages`/`assistantMessages`/`userCorrections` data) — that's a separate, larger fix.

## [1.4.11] - 2026-07-10

### Fixed

- **`EACCES` reading stdin when Claude Code runs on a Windows host and spawns Preflight inside WSL via `wsl.exe`** — the hook collector read stdin by opening `/dev/stdin`, a symlink to `/proc/self/fd/0`. On Linux that path is a fresh `open()` subject to a permission check, and the stdin pipe crossing the Windows/WSL boundary is created by WSL's root-owned init/relay (`root:root`, mode `0600`), so the re-open failed for a non-root user even though the already-inherited file descriptor was readable. Hook events were silently dropped for every Windows-host/WSL-guest Claude Code setup. The collector now falls back to reading the inherited stdin file descriptor directly when `/dev/stdin` specifically fails with `EACCES`, leaving the existing POSIX and Windows read paths unchanged otherwise. (#99)

## [1.4.10] - 2026-07-10

### Fixed

- `CLAUDE.md`'s MCP Tools list and `docs/COMMANDS_TABLE.md` were missing 5 fully-implemented, registered MCP tools: `nr_observe_get_config`, `nr_observe_get_cost_per_tool`, `nr_observe_get_turn_analysis`, and `nr_observe_get_git_efficiency` (all present in `COMMANDS_TABLE.md` but absent from `CLAUDE.md`'s summary list), and `nr_observe_get_context_tracking` (missing from both docs, and even from `analytics-tools.ts`'s own header comment). All 5 are now documented in both files.

## [1.4.9] - 2026-07-10

### Added

- **`docs/ADAPTERS.md`** — canonical per-platform reference covering integration mechanism, detection env vars, tool-name mapping, known gaps, and setup steps for all 8 named platform adapters and the generic MCP fallback. Closes out the adapter-correctness series (v1.4.3–v1.4.8): the real behavior was already fixed in code, but was previously undocumented outside source comments and unit tests.

### Fixed

- **`CONTRIBUTING.md`'s "Platform Support" table was itself incorrect** — it claimed a shared `NEW_RELIC_AI_PLATFORM` env var drove auto-detection for Cursor, Windsurf, Zed, Continue.dev, and Amazon Q; in reality only the Kiro and Copilot adapters read that variable, and the other five each use distinct, undocumented env vars in `isSupported()`. Replaced with an accurate summary that points to `docs/ADAPTERS.md`.

### Changed

- `CLAUDE.md` — added a **Platform Adapter Pattern** section (mirroring the existing Metric Tracker Pattern / MCP Tool Registration sections) describing `PlatformAdapter`/`PlatformRegistry` and cross-referencing `docs/ADAPTERS.md`.
- `docs/ARCHITECTURE.md` — added `PlatformRegistry` to the Component Reference table; it was missing despite normalizing every hook-sourced tool name since v1.4.3.
- `README.md` — added `docs/ADAPTERS.md` to the Documentation list and noted under "Works With" that platform coverage isn't uniform (some platforms only observe calls made to Preflight's own MCP tools, not their built-in tools).

## [1.4.8] - 2026-07-09

### Fixed

- Amazon Q Developer CLI adapter: replaced an invented 15-entry tool-name map (only 3 entries were real) with the confirmed 9-tool built-in vocabulary, mapping the 4 with genuine Claude Code equivalents (`fs_read`, `fs_write`, `execute_bash`, `todo_list`) and leaving the rest (`introspect`, `report_issue`, `knowledge`, `thinking`, `use_aws`) unmapped rather than forced.
- `collector-script.ts`: `postToolUse` events no longer hardcode `success: true` — they now read `tool_response.success` when present, fixing a cross-platform bug where failed Kiro and Amazon Q tool calls were silently recorded as successful.
- Amazon Q Developer CLI adapter: `getHookInstallInstructions()` now documents the platform's real, genuine hook mechanism (`preToolUse`/`postToolUse` via the agent config `hooks` field) instead of only covering MCP server registration.

## [1.4.7] - 2026-07-09

### Fixed

- Continue adapter: replaced the entirely invented `CONTINUE_TOOL_MAP` (camelCase names that never matched Continue's real tool vocabulary) with Continue's actual snake_case built-in tool names, confirmed directly from Continue's own source (`core/tools/builtIn.ts`). Removed the incorrect `deleteFile: 'Delete'` mapping — Continue has no delete/remove built-in tool at all.
- Continue adapter: corrected `getHookInstallInstructions()` to honestly state that Continue's native agent has no PreToolUse/PostToolUse-style hook mechanism, describe the real (non-deprecated) `.continue/mcpServers/*.yaml` MCP config format, and note that the upstream `continuedev/continue` repository is no longer actively maintained.

## [1.4.6] - 2026-07-10

### Fixed

- **`ZedAdapter`'s tool-name map used invented tool names that don't match Zed's real built-in agent vocabulary** — `open_file`, `create_file`, `execute_command`, `search_files`, `find_in_files`, `search_in_file`, `run_command`, and `list_files` are not real Zed tool names (confirmed via https://zed.dev/docs/ai/tools.html). `ZED_TOOL_MAP` now covers Zed's confirmed real built-in tools (`read_file`, `find_path`, `grep`, `list_directory`, `fetch`, `search_web`, `edit_file`, `write_file`, `delete_path`, `terminal`, `spawn_agent`, `skill`).
- **`ZedAdapter`'s setup instructions and `initialize()` comment described a nonexistent capture mechanism** — both claimed built-in tool calls "arrive via stdio" automatically; no such mechanism exists. Unlike the Kiro/Cursor/Windsurf fixes, Zed's native agent genuinely has no hook/callback system to document instead (confirmed: no "Hooks" page exists anywhere in Zed's documentation). Instructions now accurately state that Preflight can only observe calls made to its own MCP tools in Zed, and that full tool-call observability requires running an already-supported platform (e.g. Claude Code) as a Zed External Agent instead.

## [1.4.5] - 2026-07-09

### Fixed

- **Windsurf hook events were silently dropped** — `preflight-collector` only recognized `hook_event_name` (Claude Code/Kiro/Cursor's event-name field). Windsurf's real Cascade Hooks system (`.windsurf/hooks.json`, confirmed via https://docs.windsurf.com/windsurf/cascade/hooks) sends the event name as `agent_action_name` instead, with all event data nested under a `tool_info` object rather than flat fields — so every Windsurf hook event fell through to a silent no-op. The collector now recognizes and correctly parses `pre_read_code`/`post_read_code`, `pre_write_code`/`post_write_code`, `pre_run_command`/`post_run_command`, and `pre_mcp_tool_use`/`post_mcp_tool_use`.
- **`WindsurfAdapter`'s setup instructions and `initialize()` comment described a nonexistent integration** — both claimed built-in tool calls (file edits, terminal) were captured via "extension API or file watcher events"; no such mechanism exists anywhere in this codebase. Instructions now document the real `.windsurf/hooks.json` Cascade Hooks setup.

## [1.4.4] - 2026-07-09

### Fixed

- **Cursor hook events were silently dropped** — `preflight-collector` only recognized Claude Code's/Kiro's generic `PreToolUse`/`PostToolUse` hook names. Cursor's real hooks system (`.cursor/hooks.json`) sends a completely different, per-action-type event vocabulary (`beforeShellExecution`/`afterShellExecution`, `beforeMCPExecution`/`afterMCPExecution`, `beforeReadFile`, `afterFileEdit`), so every Cursor hook event fell through to a silent no-op. The collector now recognizes and correctly parses all six events.
- **`CursorAdapter`'s setup instructions and tool-name map described a nonexistent integration** — `getHookInstallInstructions()` and `initialize()`'s comment claimed built-in tool calls (file edits, terminal) were captured via "a file watcher or Cursor extension"; no such mechanism exists anywhere in this codebase. Instructions now document the real `.cursor/hooks.json` setup, and `CURSOR_TOOL_MAP` now covers Cursor's confirmed generic `preToolUse`/`postToolUse` tool-name vocabulary (`Shell`, `Task`, `Read`, `Write`) alongside its existing built-in-action-name entries.

## [1.4.3] - 2026-07-09

### Fixed

- **Kiro hook events were silently dropped** — `preflight-collector` matched Claude Code's exact PascalCase hook event names (`PreToolUse`); Kiro sends lower-camelCase (`preToolUse`) per its own docs, so every Kiro hook event fell through to a silent no-op — nothing was written to the buffer, but the collector still exited 0. The event-name check is now case-insensitive. (#84)
- **Hook-sourced tool names were never normalized for any platform** — `PlatformAdapter.normalizeToolCall()` and `PlatformRegistry` were fully implemented and tested but never actually called from the running hook pipeline; every platform's tool names passed through to trackers and the dashboard unmapped. Added `PlatformAdapter.mapToolName()` and wired it into `HookEventProcessor`, and corrected Kiro's tool-name map with its documented aliases (`read`/`write`/`shell`/`aws`).

### Added

- **`preflight doctor --platform <name>`** — the "Hooks wired" check previously only validated Claude Code's `settings.json` and stayed green regardless of whether a non-Claude-Code platform's hooks actually worked. Passing `--platform kiro` (or any other registered platform name) now skips the Claude-Code-specific check in favor of an explicit reminder to verify that platform's own hook/MCP config and to confirm events land in `~/.newrelic-preflight/buffer-*.jsonl`.

## [1.4.2] - 2026-07-09

### Added

- **`preflight local` command** — lists every `--local` dashboard process preflight has launched (not just whichever one currently owns the dashboard port), and `preflight local --clean` offers to kill the ones that lost the port race and have been running headless ever since. Every `--local` process now registers itself in a small per-PID registry at startup regardless of port outcome; dead entries (from a process that didn't shut down cleanly) are garbage-collected automatically every 5 minutes by whichever process owns the dashboard. `preflight doctor` gained a matching "Local instances" check that reports idle processes and points at `preflight local --clean`.

## [1.4.1] - 2026-07-08

### Fixed

- **`preflight update` could report a restart succeeded when it hadn't** — both restart paths (the macOS launchd daemon and an ad-hoc `--local` process) declared success as soon as the restart _action_ didn't throw (`launchctl load` returning success, or the respawned process not throwing synchronously), without checking that the dashboard actually came back up. A daemon that crashed immediately after a "successful" `launchctl load` — for example due to a macOS Full Disk Access restriction — would print a false "restarted" message while a stale process kept serving the old version. `update` now polls the dashboard's health endpoint for a healthy response reporting the freshly-built version before declaring success, and falls back to checking for an ad-hoc process if the daemon restart can't be verified.

## [1.4.0] - 2026-07-08

### Added

- **`preflight update` offers to restart stale dashboard/daemon processes** — after a successful `git pull` + rebuild, `--local` now writes a small PID file (`local-dashboard.pid`: pid/argv/cwd) the moment it wins the dashboard port bind, giving `update` a reliable way to find its own dashboard process instead of a running instance silently continuing to serve the old cached version. If the macOS launchd dashboard daemon is installed, it's restarted automatically (no prompt). Otherwise, if a live ad-hoc `--local` process is found, `update` prompts (default yes) to restart it — killing it gracefully and respawning it detached with its original arguments. `--stdio` (Claude Code) sessions are never touched; they keep the existing "restart Claude Code" guidance.

## [1.3.1] - 2026-07-08

### Fixed

- **Dashboard 403 on Windows** — the static file handler's root-containment check only recognized `/` as a path separator, so every static asset request (including `index.html`) was rejected on Windows, where `resolve()`/`join()` produce backslash-joined paths. Added a platform-separator fallback alongside the existing literal `/` check.
- **Hook collector silently dropped all session data on Windows** — the hook collector read stdin via the POSIX-only `/dev/stdin` device path, which doesn't exist on Windows, so every `PreToolUse`/`PostToolUse` hook failed silently and the Sessions tab stayed empty with no indication of failure. Windows now reads stdin via its file descriptor directly instead.

---

## [1.3.0] - 2026-07-08

### Added

- **Prompt cache health** — `CostTracker` now aggregates a `cacheHitRate` ratio and `totalCacheSavingsUsd` from `cache_read_tokens`/`cache_creation_tokens` on every token report, and emits `ai.cost.tokens_cache_creation` and `ai.cost.cache_savings_usd` metrics. The new `nr_observe_get_prompt_cache_health` MCP tool returns a status tier (`excellent`/`can_improve`/`needs_attention`/`no_cache_activity`), hit rate percentage, total savings, and a concrete recommendation naming the actual percentage.
- **Weekly cache hit rate trend** — `TrendAnalyzer` computes `weeklyCacheHitRateTrend` across sessions (omitting the current, still-in-progress week and any week with no cache activity), surfaced via the `TRENDS` tool.
- **`CacheHealthPanel` on the Today dashboard view** — shows the current session's cache hit rate with a status pill, total savings, a week-over-week delta chip (↑/↓ _N_ pts vs. last week), and the same concrete recommendation text as the MCP tool. Backed by a new `GET /api/cache-health` route.
- `tokensCacheRead`, `tokensCacheCreation`, and `cacheSavingsUsd` are now persisted in `FullSessionSummary` (old session files without these fields default to `0`).

## [1.2.0] - 2026-07-08

### Added

- **Smithery MCP registry support** — added `smithery.yaml` at the repo root so Preflight can be discovered and installed via the [Smithery](https://smithery.ai) registry. Configures `npx -y @newrelic/preflight@latest --stdio` with a UI for `licenseKey`, `accountId`, `developer`, and `mode` (`cloud`/`local`).
- **`nr_observe_install_hooks` MCP tool** — since Smithery only wires up the MCP server and doesn't touch `~/.claude/settings.json`, this tool lets users finish setup from within a Claude Code chat session by writing the `PreToolUse`/`PostToolUse` monitoring hooks headlessly (no TTY required). A Claude Code restart is still needed to activate monitoring.
- **`nr_observe_health` reports hook status** — the health check now includes `hooks_installed` and `setup_required` booleans, so an AI tool can detect an incomplete setup (e.g. after a Smithery install) and prompt the user to call `nr_observe_install_hooks`.

---

## [1.1.1] - 2026-07-07

### Fixed

- **License key region routing for unrecognized prefixes** — Preflight no longer throws an error when a New Relic license key has a region prefix that isn't in its built-in lookup table (e.g. `ca06...NRAL`). Instead, it logs a warning and falls back to the US region. This prevents a startup crash for users whose account was provisioned in a newly launched or unsupported region. Users who need explicit region routing can set `collectorHost` in their config to override the default.

---

## [1.1.0] - 2026-07-03

### Added

- **Amazon Kiro platform adapter** — Preflight now detects and normalizes tool calls from [Amazon Kiro](https://kiro.dev), AWS's agentic, MCP-native IDE. Kiro sessions are automatically detected via environment variables (`KIRO_SESSION_ID`, `KIRO_IDE`, `MCP_CLIENT=kiro`, or `NEW_RELIC_AI_PLATFORM=kiro`) and all standard Kiro tool names are mapped to the normalized Preflight vocabulary. Install instructions are included in `preflight install` output. **Note:** tool-name mappings are best-effort pending validation against a live Kiro install — unmapped tools record as `Unknown` with the original tool name preserved in telemetry.

---

## [1.0.10] - 2026-07-03

### Fixed

- **WSL2 + fish shell session tracking** — the hook collector now walks `/proc/<pid>/stat` to find ancestor PIDs (up to 5 levels deep), so the MCP server can match a hook event to its session even when intermediate shell processes (e.g. a fish shell started by WSL2) sit between Claude Code and the collector. On macOS and Windows the behaviour is unchanged.
- **Version reporting when installed as a symlink** — `preflight --version` now resolves symlinks before locating `package.json`, fixing cases where the binary is installed via `npm link` or a package manager that places a symlink in a `bin/` directory separate from the package root.
- **`preflight doctor` false alarm for custom hook wrappers** — when a hook event type (e.g. `PostToolUse`) has a hook command that is not the official preflight collector, the doctor check now reports a **warning** rather than a failure, since the user may be wrapping `preflight-collector` in a custom script. A hook event type with no command at all still reports as a failure.

---

## [1.0.9] - 2026-07-02

### Changed

- **Pricing tables updated to 2026-07-01** — cost calculations now reflect current vendor rates:
  - **New models added:** `claude-fable-5`, `claude-sonnet-5` (introductory pricing of $2/$10 through August 31, 2026), `claude-opus-4-8`, `gemini-3.5-flash`, `mistral-medium-latest`
  - **Model alias updated:** the family alias `claude-opus-4` now resolves to `claude-opus-4-8` (previously `claude-opus-4-7`); the older generation entry is retained as a legacy entry for historical cost backfill
  - **Mistral rate corrections:** Mistral Small and Large rates revised to match current public pricing
  - **AWS Bedrock:** added `anthropic.claude-sonnet-5` and `anthropic.claude-opus-4-8` entries

---

## [1.0.8] - 2026-07-02

### Fixed

- **`preflight update` with package manager installs** — when preflight is installed via a package manager (global `npm install -g`, `pnpm add -g`, or a local `npm install` into `node_modules`), running `preflight update` now prints a clear reinstall command instead of failing with a cryptic `not a git repository` error from git
- **`preflight update` divergent branches** — when `git pull` fails (e.g. local commits ahead of remote), the error output now includes a `git fetch origin && git reset --hard origin/<branch>` command (replace `<branch>` with your default branch name) rather than a generic "check the output above" message

### Changed

- New **Improving Your Tool Selection Score** section in `docs/ADVANCED.md` — explains what triggers each of the three tool selection penalties (redundant reads, repeated failures, unused large outputs) and gives concrete prompt-writing tips to avoid them. Cross-referenced from the `nr_observe_get_tool_selection_score` entry in `docs/COMMANDS_TABLE.md`.

---

## [1.0.7] - 2026-07-01

### Added

- **`preflight uninstall --yes`** — skips the interactive confirmation prompt for scripted and CI use
- **`preflight uninstall --daemon`** — removes only the background dashboard daemon (plist + `launchctl unload`) without touching hooks, MCP config, schedule, or session history
- `preflight uninstall` now prints a full summary of exactly what will change before prompting — which hooks files, MCP config files, schedule plist, and daemon plist will be touched, with exact paths

### Changed

- Background dashboard daemon installation during `preflight setup` is now **opt-in** (`[y/N]`) rather than opt-out (`[Y/n]`). The daemon is a persistent `launchd` service and should require explicit consent to install. Existing installations are unaffected — only new setups or re-runs of `preflight setup` are impacted.
- `preflight doctor` now reports a missing daemon as a **warning** (exit code 2) rather than a **failure** (exit code 1). The daemon is optional; the MCP server functions fully without it. Scripts that previously tested `[ $? -eq 1 ]` to detect a missing daemon should be updated to check for exit code 2.

### Fixed

**`preflight uninstall`**

- Exit code is now 1 when uninstall is cancelled (non-interactive stdin or user answers `n`) or when any removal step fails — previously the process could exit 0 despite making no changes
- Non-interactive stdin (CI pipelines, `echo "" | preflight uninstall`) now cancels cleanly and exits 1 rather than hanging indefinitely waiting for confirmation input
- When one removal step fails (e.g. a permissions error on the schedule plist), the remaining steps (hooks, MCP config) still complete in the same run — previously a single failure stopped all subsequent steps
- The restart prompt (`"Restart Claude Code for changes to take effect"`) is now suppressed on a partial failure; the message distinguishes between a fully successful uninstall and an incomplete one
- WSL installations now clean both the Linux-side and Windows-side settings files in a single `preflight uninstall` run, rather than silently skipping the Windows-side path
- If a plist file cannot be deleted after the launchd job is removed (e.g. wrong permissions on the plist), the uninstall continues rather than getting stuck in a retry loop. The launchd job is already inactive at this point, so the orphaned file is harmless; its path is included in the warning log (`~/.newrelic-preflight/` or `launchctl` output) so it can be removed manually if desired.
- When a plist file disappears between the status check and the removal call (race window during interactive confirmation), `preflight uninstall` now prints an "already absent" message rather than silently producing no output
- Corrupt or unreadable settings files (`settings.json`, `.mcp.json`) are now diagnosed and reported rather than silently ignored
- The saved platform target record is cleared after a fully successful config removal and retained when the uninstall is incomplete, ensuring retry attempts continue targeting the right settings paths

**`preflight doctor`**

- NR endpoint reachability check is now correctly skipped when `licenseKey` is not configured, with an explanation in the output — previously it attempted a network request and reported a connection failure that had nothing to do with the network
- Storage path check now uses the env-var-resolved path (`NEW_RELIC_AI_MCP_STORAGE_PATH`) rather than the raw config file value, so it tests the same directory the running MCP server actually writes to
- Hooks check handles partially unparseable settings files: hooks found in valid files are reported as passing, and malformed files are surfaced as a separate warning, rather than treating any parse error as proof that no hooks are installed
- NR reachability check is now suppressed when no config file exists (first-time setup), preventing a spurious "NR unreachable" failure from appearing alongside the expected "no config file" warning
- Unreadable plist files (e.g. wrong permissions) are now reported as "unreadable" rather than "not installed", giving a more accurate diagnosis and a correct fix command
- XML entity sequences (e.g. `&amp;`, `&lt;`) in plist `PATH` values are now correctly decoded before checking for a node binary — paths with special characters were previously always reported as missing
- Daemon node-path check now probes for an actual executable `node` binary in each plist `PATH` directory; a non-executable `node` file is called out separately with its own fix advice rather than being reported the same as a missing binary. Also checks for `nodejs` as an alternate binary name (used on Debian/Ubuntu)
- Broken node symlinks in plist `PATH` dirs (dangling after a node upgrade) are now correctly identified as non-executable candidates rather than silently treated as missing entries

**Setup and daemon**

- Node binary path injected into daemon and schedule plists is now resolved by probing executables in `PATH` rather than using `dirname(process.execPath)`. Version managers (Homebrew, nvm, volta) place node at stable symlink directories that survive upgrades — the previous approach resolved to versioned Cellar paths that break after `brew upgrade node`. Re-run `preflight setup` to apply this to an existing installation.
- Dashboard daemon plist now includes `ThrottleInterval: 300` to prevent rapid crash-restart loops from filling the daemon log
- `preflight setup` no longer hangs when run in a non-interactive environment (e.g. piped stdin); it exits cleanly with an informational message

---

## [1.0.6] - 2026-06-30

### Added

- `preflight doctor` — a new CLI subcommand that runs six diagnostic checks and prints a summary with actionable fix commands. Checks: config file valid, dashboard daemon installed (macOS), daemon node path in plist PATH, PreToolUse/PostToolUse hooks wired, storage directory writable, New Relic endpoint reachable. Exit code 0 = all clear, 1 = at least one failure, 2 = warnings only. WSL installs check both the Linux-side and Windows-side settings paths.
- Configuration load errors at startup now append `Run 'preflight doctor' to diagnose.` to guide users to the new subcommand.
- **Settings → System Health panel** — a new card at the top of the Settings page that runs the same six diagnostic checks via `GET /api/diagnostics` and surfaces any failures or warnings with copy-able fix commands. Auto-refreshes every 60 seconds. Collapses to a green "System healthy" indicator when everything is passing.

### Changed

- Empty-state copy for the Tool Selection and Model Usage panels now reads "Start a Claude Code session to begin scoring / to see model cost breakdown. Resets when the process restarts." — clearer than the previous generic "after tool calls arrive" wording.

---

## [1.0.5] - 2026-06-29

### Added

- Dashboard sidebar footer now shows the installed version number, a link to the GitHub repository, and an amber "Update available" nudge when a newer version is published on npm. The npm registry check runs once at server startup in the background and never blocks the dashboard.
- `PRIVACY.md` — a data collection inventory documenting every field sent to New Relic in cloud mode, who can query it in a shared account, and a pre-cloud checklist. Linked from `README.md` and `SECURITY.md`.

### Fixed

- `highSecurity` mode was not enforced in the hook collector when set via environment variable. The collector was checking `NEW_RELIC_AI_MCP_HIGH_SECURITY` instead of the documented `NEW_RELIC_AI_HIGH_SECURITY`. Users who set the environment variable (rather than the config file) would not have had content recording suppressed in the collector. Both paths now use the same variable name.
- The `com.preflight.dashboard` and `com.preflight.update` launchd daemons crashed with `env: node: No such file or directory` (exit 127) on macOS systems where node is installed via Homebrew, nvm, volta, asdf, or any other version manager that places node outside launchd's minimal default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The generated plists now include an `EnvironmentVariables` block that injects the directory of the node binary used during `preflight setup`, making both daemons work regardless of how node was installed. Re-run `preflight setup` to apply this fix to an existing installation.

### Changed

- `SECURITY.md` and `PRIVACY.md` moved to the repository root for discoverability. GitHub surfaces `SECURITY.md` from the root as a security policy link on the repository page.
- Updated `@opentelemetry/*` packages to 0.219.0 / 2.8.0, and dev tooling (eslint, prettier, vite, vitest, recharts, lucide-react, and others) to latest compatible versions.

---

## [1.0.4] - 2026-06-24

### Fixed

- Alert rules copy during setup now correctly locates `examples/local-alert-rules.json` when installed globally via npm. The previous path resolution walked two directories up from the entry point (`dist/index.js`), overshooting the package root; it now walks up until it finds `package.json`, making it robust regardless of entry-point depth.
- WSL install no longer defaults to Windows Claude Code mode for all WSL users. The installer previously wrote hooks to the Windows-side `.claude/settings.json` (with `wsl.exe -e` commands) whenever it detected WSL and a resolvable Windows home directory — which broke users running Linux Claude Code installed via npm inside WSL. The new behaviour: Windows CC mode is only used when explicitly requested via `--windows-cc`, or when a prior Windows CC install is recorded in `~/.newrelic-preflight/config.json`. All other WSL users get standard Linux-path hooks.
- `preflight install` now accepts a `--windows-cc` flag to explicitly opt in to Windows Claude Code mode from WSL, making first-time Windows CC setups straightforward.
- `preflight setup` now prompts WSL users to identify their Claude Code installation (Windows desktop app vs. Linux npm install inside WSL) before writing hooks, eliminating the silent misconfiguration that caused empty hook registries.
- WSL install advisory message is now always shown even when the subsequent `settings.json` read or merge fails, so the `--windows-cc` routing hint reaches the user regardless of install outcome.

---

## [1.0.3] - 2026-06-23

### Added

- Windows (WSL) support: `preflight setup` and `preflight install` now detect when running inside WSL and write hooks and MCP config to the Windows-side Claude Code settings path, so Windows Claude Code users no longer see "0 hooks in registry" or a reduced tool set
- Native Linux install support: setup wizard now shows `preflight --local &` guidance for background dashboard on Linux (previously only macOS got daemon guidance)

### Changed

- README refreshed with local-first framing, logo, demo GIF, and cleaner structure

---

## [1.0.2] - 2026-06-23

### Added

- Always-on background dashboard daemon for macOS (`local` and `both` modes). The setup wizard now offers to install a launchd agent (`com.preflight.dashboard`) that keeps the local dashboard running at `http://127.0.0.1:7777` even when Claude Code is closed. `preflight uninstall` removes it.

### Fixed

- Local dashboard now starts immediately when `--stdio` mode launches with `mode: local` or `mode: both` — no longer requires manually running `preflight --local` after a Claude Code session starts
- Background dashboard daemon correctly survives port contention with active Claude Code sessions and reclaims the dashboard port when sessions end (previously exited immediately on EADDRINUSE)
- Setup wizard daemon upgrade is now atomic — installing over an existing daemon no longer risks leaving the user with no daemon if the reinstall fails
- Session resolution polling loop is now correctly aborted when the MCP server shuts down, preventing orphaned breadcrumb poll timers
- OTel session spans no longer emit a zero-call ghost span with a placeholder session ID to OTLP backends when session ID resolution takes the async path
- `isSyntheticSessionId` now covers the provisional `pending-` prefix, preventing provisional session IDs from appearing in audit records, dashboard live-session lists, or the session history

## [1.0.1] - 2026-06-23

### Security

- Pinned transitive dependency `undici` to ≥ 7.28.0 to address a CVE in proxy cookie handling
- Pinned transitive dependency `hono` to ≥ 4.12.25 to address a CVE in header parsing
- Pinned transitive dependency `js-yaml` to ≥ 4.2.0 to address unsafe YAML load
- Pinned transitive dependency `@opentelemetry/core` to ≥ 2.8.0 to address prototype pollution
- Fixed polynomial ReDoS risk in `normalizeDeveloperName()` by splitting alternating regex into two sequential anchored calls (CodeQL `js/polynomial-redos`)
- Fixed incomplete shell string escaping in hook path generation — backslashes are now escaped before double-quotes (CodeQL `js/incomplete-sanitization`)
- Added explicit null-byte and path-traversal component guard in the static file handler (CodeQL `js/path-injection`)
- Added MIME extension allow-list gate in the static file handler to limit `readFile()` to known web-asset types (CodeQL `js/path-injection`)

## [1.0.0] - 2026-06-23

### Added

- Initial public release

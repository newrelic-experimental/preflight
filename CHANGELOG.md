# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

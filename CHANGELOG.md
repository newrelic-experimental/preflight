# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

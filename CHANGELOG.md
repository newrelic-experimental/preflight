# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

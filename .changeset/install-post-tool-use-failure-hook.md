---
'@newrelic/preflight': patch
---

`preflight install`, the Claude Code plugin, and `preflight install --copilot` now register the `PostToolUseFailure` hook. Before, Preflight never received a failed tool call from Claude Code or the Copilot CLI. A failure was recorded only when its call timed out (after 60 seconds, or 11 minutes for Bash), as `error_type` `timeout` without its error text, and after the calls that followed it, so retry detection missed retries of a failed call. Plugin users get the hook on the next plugin update. Re-run `preflight install` (or `preflight install --copilot`) to add it to an existing install. Until then, `preflight doctor` reports it as missing and `nr_observe_health` reports `hooks_installed: false`.

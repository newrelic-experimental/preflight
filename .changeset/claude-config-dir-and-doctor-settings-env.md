---
'@newrelic/preflight': patch
---

Preflight now finds Claude Code transcripts under `CLAUDE_CONFIG_DIR` when it is set, so token and cost data no longer go missing for installs that move Claude Code's config directory. `preflight doctor`'s Companion mode check and OTLP receiver double-count warning now also read `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*` values from the `env` blocks of Claude Code's settings files, not just the shell that runs `doctor`.

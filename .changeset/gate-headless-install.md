---
'@newrelic/preflight': minor
---

`nr_observe_install_hooks` no longer writes to `~/.claude/settings.json` by default. Any MCP client connected to Preflight could call the tool, so it now refuses and changes nothing unless you opt in. To install the hooks, run `preflight install` in a terminal, or set `"allowHeadlessInstall": true` in your config (or `NEW_RELIC_AI_ALLOW_HEADLESS_INSTALL=true`). With the flag on, the tool installs as before and records a `HookInstall` entry in the audit trail. `nr_observe_get_config` reports the setting. See docs/ADVANCED.md.

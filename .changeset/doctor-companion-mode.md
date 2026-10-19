---
'@newrelic/preflight': patch
---

`preflight doctor` now reports the companion mode a running Preflight MCP server actually resolved, along with where it came from, instead of only what your terminal's environment would resolve. This matters for managed rollouts that set the Claude Code OTel variables in settings rather than the shell. With no server running, the detail says it reflects the shell. `nr_observe_get_config` also returns `companionModeSource`.

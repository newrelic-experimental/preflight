---
'@newrelic/preflight': patch
---

Each platform adapter now recognizes another spelling of its own engine name (for example `Kilo_Code` or `CURSOR`) in `MCP_CLIENT` or `NEW_RELIC_AI_PLATFORM` without relying on platform detection to rewrite the variable first.

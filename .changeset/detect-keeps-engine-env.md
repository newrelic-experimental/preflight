---
'@newrelic/preflight': patch
---

Detecting the platform no longer rewrites `MCP_CLIENT` or `NEW_RELIC_AI_PLATFORM` in the server's environment, so processes it spawns inherit the spelling you set.

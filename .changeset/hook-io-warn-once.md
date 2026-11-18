---
'@newrelic/preflight': patch
---

The warning about an unrecognized `MCP_CLIENT` or `NEW_RELIC_AI_PLATFORM` value now prints once per install instead of on every tool call, and prints again if you change the setting to another unrecognized value.

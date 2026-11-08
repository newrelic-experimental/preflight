---
'@newrelic/preflight': patch
---

**`NEW_RELIC_AI_MCP_LOG_LEVEL` and `NEW_RELIC_AI_LOG_LEVEL` are honored at startup.** The `--log-level` flag used to default to `info` and overwrite `NEW_RELIC_AI_LOG_LEVEL`, so both variables were ignored. The level now resolves in this order. The `--log-level` flag comes first, then `NEW_RELIC_AI_MCP_LOG_LEVEL`, then `NEW_RELIC_AI_LOG_LEVEL`, then the config file's `logLevel`, then `info`.

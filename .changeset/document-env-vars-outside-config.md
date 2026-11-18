---
'@newrelic/preflight': patch
---

The environment variable reference in `docs/ADVANCED.md` now lists `NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH`, `NEW_RELIC_AI_LOG_LEVEL`, `NEW_RELIC_AI_PLATFORM`, and `NEW_RELIC_AI_COPILOT_DIR`. `npm run check:docs-inventory` now fails on any undocumented `NEW_RELIC_AI_*` name in `src/`, not only those in `src/config.ts`.

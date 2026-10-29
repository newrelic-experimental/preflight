---
'@newrelic/preflight': major
---

**The Claude Code plugin now runs the MCP server version it was released with, and ignores `NEW_RELIC_AI_PREFLIGHT_VERSION`.** Its `.mcp.json` launched `@newrelic/preflight@${NEW_RELIC_AI_PREFLIGHT_VERSION:-latest}`, which the Claude plugin marketplace rejects: it only lists a plugin whose `npx` launcher names an exact version. The plugin now launches its own version, so the bundled hook collector and the server always come from one release, and the server moves when the plugin updates instead of whenever npm publishes. Fleets that hold the server with `NEW_RELIC_AI_PREFLIGHT_VERSION` should set the marketplace's `source.ref` to that release's tag (`v<version>`) instead, which now holds both; the variable no longer has any effect. `docs/FLEET_DEPLOYMENT.md` has the updated managed settings.

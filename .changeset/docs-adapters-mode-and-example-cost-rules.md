---
'@newrelic/preflight': minor
---

The starter alert rules now include a daily and a weekly cost rule next to the session one, so the `today` and `week` cost periods are visible in the file `preflight setup` copies. The cloud-mode setup examples in the adapter docs, `.env.example`, and the MCP Registry manifest now set `NR_AI_MODE`, so copying them no longer produces a server that refuses to start. `preflight install --kiro` writes the Kiro hook file (`.kiro/hooks/preflight-observability.json`) into the current project, which turns on automatic tool-call capture (`preflight uninstall --kiro` removes it); the Kiro adapter docs describe it.

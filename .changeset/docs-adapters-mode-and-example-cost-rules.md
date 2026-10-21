---
'@newrelic/preflight': patch
---

The starter alert rules now include a daily and a weekly cost rule next to the session one, so the `today` and `week` cost periods are visible in the file `preflight setup` copies. The cloud-mode setup examples in the adapter docs, `.env.example`, and the MCP Registry manifest now set `NR_AI_MODE`, so copying them no longer produces a server that refuses to start. The Kiro adapter docs now include the hook file that turns on automatic tool-call capture.

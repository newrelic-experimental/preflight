---
'@newrelic/preflight': patch
---

Pull requests opened or edited through the GitHub MCP server under Claude Code now count. Claude Code names those tools `mcp__<server>__create_pull_request` and `mcp__<server>__update_pull_request`, which Preflight didn't recognize, so the PR metrics, the Git tab, and the Sessions-today "ready for review" status missed them.

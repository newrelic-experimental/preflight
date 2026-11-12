---
'@newrelic/preflight': patch
---

Pull requests opened, edited, or merged through the GitHub MCP server now count. Under Claude Code those tools are named `mcp__<server>__create_pull_request` and so on, which Preflight didn't recognize, so the PR metrics, the Git tab, and the Sessions-today "ready for review" status missed them. Merges through `merge_pull_request` were never counted on any platform. Each of these events now also carries its PR number, so merging a PR through the MCP server takes the session that opened it out of "ready for review". A failed MCP create or merge no longer counts.

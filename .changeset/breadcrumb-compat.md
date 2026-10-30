---
'@newrelic/preflight': patch
---

**Older and newer Preflight versions keep finding the right session as you upgrade.** The hook collector still writes session breadcrumbs where servers older than the #979 fix look, so a server pinned to an older release keeps resolving, and a current server ignores those copies so it still never adopts another assistant's session. A server restarted mid-session now resolves from an older collector's breadcrumb on the session's next tool call. When an older and a newer breadcrumb disagree, the server takes the session that was active most recently. A hook command that spells its assistant differently, such as `MCP_CLIENT=Kiro` or `claude_code`, is now recognized, and one naming an assistant Preflight doesn't know writes no breadcrumb and prints a warning.

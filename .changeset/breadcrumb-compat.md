---
'@newrelic/preflight': patch
---

**Older and newer Preflight versions keep finding the right session as you upgrade.** The hook collector still writes session breadcrumbs where servers older than the #979 fix look, so a server pinned to an older release keeps resolving, and a current server ignores those copies so it still never adopts another assistant's session. A server restarted mid-session now resolves from an older collector's breadcrumb on the session's next tool call. A server prefers its own assistant's breadcrumbs over unattributed and older ones. A hook command that spells its assistant differently, such as `MCP_CLIENT=Kiro` or `claude_code`, is now recognized. A name Preflight doesn't know, such as an inherited `MCP_CLIENT=vscode`, no longer hides Claude Code. When nothing else identifies the assistant, that hook writes no breadcrumb and prints a warning.

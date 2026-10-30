---
'@newrelic/preflight': patch
---

**Cursor, Windsurf, and Antigravity no longer take over a Claude Code session's cost.** If a Claude Code session had recently run in the same directory, a Preflight server started by one of these editors adopted that session's id from the directory breadcrumb and recorded its own cost on it. These editors never write that breadcrumb themselves, so the server now ignores it and waits for its own session instead.

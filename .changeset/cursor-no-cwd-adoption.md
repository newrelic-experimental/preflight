---
'@newrelic/preflight': patch
---

**A Preflight server no longer takes over another coding assistant's session.** A server started by Cursor, Kiro, or any other assistant could adopt the session of a Claude Code session running in the same directory or under the same parent process, and record its own cost on that session. The hook collector now records which assistant wrote each session breadcrumb, and a server adopts only the breadcrumbs that its own assistant's hooks wrote. Servers for assistants whose hooks write no breadcrumb, such as Cursor, Windsurf, Zed, and the generic MCP fallback, no longer wait for one. Breadcrumbs from an older collector still count while that collector keeps writing them, so a plugin that is behind the server keeps working until it updates.

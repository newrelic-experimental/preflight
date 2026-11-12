---
'@newrelic/preflight': patch
---

**An assistant started from a Claude Code terminal keeps its own session, and Claude Code no longer adopts it.** Before, a Codex, Droid, or Gemini CLI hook command that names no assistant and runs from a Claude Code terminal inherited Claude Code's environment, so the collector filed its session breadcrumbs and tool calls under Claude Code. That assistant's Preflight server then never found its session, and a Claude Code server in the same directory could take it over. The collector now files a hook under Claude Code only when `CLAUDE_CODE_SESSION_ID` is unset or names the hook's own session. A Claude Code build that never sets `CLAUDE_CODE_SESSION_ID` keeps the old behavior. Separately, a server that reads several breadcrumb writers again picks the breadcrumb of its closest ancestor process across all of them.
